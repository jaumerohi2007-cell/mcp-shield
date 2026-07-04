/**
 * MCP-Shield firewall (blueprint Component C — hook (a) in src/index.ts).
 *
 * Two layers:
 *
 * 1. screenClientLine() — wire-level screening of every client → server line:
 *    - Deny by default: input that is not valid JSON is answered with a
 *      ParseError and never reaches the target server (a laxer parser on the
 *      server side might otherwise still act on it).
 *    - JSON-RPC batches (arrays) are rejected outright: MCP is strictly
 *      one-message-per-line and a batch is only useful here as a vehicle to
 *      sneak a tools/call past inspection.
 *    - Anything claiming `method: "tools/call"` is held to the strict shape
 *      (params.name a non-empty string, a respondable id) or blocked.
 *    - Canonical re-serialization: what gets forwarded is OUR JSON.stringify
 *      of the object we judged — never the client's raw bytes — so
 *      duplicate-key parser differentials like
 *      {"command":"safe","command":"malicious"} cannot smuggle a second
 *      reading past the firewall.
 *
 * 2. Firewall — the rule engine: matches SecurityRules (allow / block / ask)
 *    against tools/call requests via contains / regex / outside_dir
 *    conditions on dot-path fields of the call params.
 */

import path from 'node:path';

import { defaultRules, loadCachedRules, type RuleCondition, type SecurityRule } from '../config/rules.js';
import {
  createAccessDeniedResponse,
  createErrorResponse,
  isJsonRpcMessage,
  isToolCallRequest,
  JsonRpcErrorCode,
  McpMethod,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type McpToolCallRequest,
} from '../types/mcp.js';

// ---------------------------------------------------------------------------
// Rule engine
// ---------------------------------------------------------------------------

export type FirewallVerdict =
  | { action: 'allow' }
  | { action: 'block' | 'ask'; rule: SecurityRule; reason: string };

export class Firewall {
  private rules: SecurityRule[];
  private compiledRegexes: Map<string, RegExp>;

  constructor(rules: SecurityRule[] = defaultRules) {
    this.compiledRegexes = this.compileRules(rules);
    this.rules = rules;
  }

  /** Loads from `~/.mcp-shield/rules.cache.json` if available, falls back to default rules. */
  static async create(): Promise<Firewall> {
    const cached = await loadCachedRules();
    return new Firewall(cached ?? defaultRules);
  }

  /**
   * Hot-reloads the active rule set in place. Compiles regexes first so that a
   * bad rule from the cloud leaves the existing policy intact and throws instead
   * of silently disabling protection.
   */
  reloadRules(rules: SecurityRule[]): void {
    const newRegexes = this.compileRules(rules);
    this.compiledRegexes = newRegexes;
    this.rules = rules;
  }

  /** First matching rule wins; a call no rule claims is allowed (the rules define the restrictions). */
  evaluateToolCall(request: McpToolCallRequest): FirewallVerdict {
    for (const rule of this.rules) {
      if (rule.tool !== '*' && rule.tool !== request.params.name) {
        continue;
      }
      if (rule.condition !== undefined && !this.conditionMatches(rule, rule.condition, request)) {
        continue;
      }
      if (rule.action === 'allow') {
        return { action: 'allow' };
      }
      return {
        action: rule.action,
        rule,
        reason: rule.condition
          ? `${rule.condition.field} ${rule.condition.operator} "${rule.condition.value}"`
          : `tool "${rule.tool}"`,
      };
    }
    return { action: 'allow' };
  }

  private compileRules(rules: SecurityRule[]): Map<string, RegExp> {
    const regexes = new Map<string, RegExp>();
    for (const rule of rules) {
      if (rule.condition?.operator === 'regex') {
        try {
          regexes.set(rule.id, new RegExp(rule.condition.value, 'i'));
        } catch (err) {
          throw new Error(
            `invalid regex in security rule "${rule.id}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    return regexes;
  }

  private conditionMatches(rule: SecurityRule, condition: RuleCondition, request: McpToolCallRequest): boolean {
    const value = getByPath(request.params, condition.field);
    if (value === undefined) {
      return false;
    }
    // Nested objects/arrays are matched against their JSON form, so a payload
    // cannot dodge a text rule by wrapping the string one level deeper.
    const haystack = typeof value === 'string' ? value : JSON.stringify(value);
    switch (condition.operator) {
      case 'contains':
        return haystack.toLowerCase().includes(condition.value.toLowerCase());
      case 'regex':
        return (this.compiledRegexes.get(rule.id) as RegExp).test(haystack);
      case 'outside_dir':
        // A non-string path is unjudgeable — fail closed and let the rule fire.
        return typeof value !== 'string' || isOutsideDir(value, condition.value);
    }
  }
}

function getByPath(root: Record<string, unknown>, fieldPath: string): unknown {
  let current: unknown = root;
  for (const key of fieldPath.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function isOutsideDir(candidate: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, path.resolve(resolvedRoot, candidate));
  return relative.startsWith('..') || path.isAbsolute(relative);
}

// ---------------------------------------------------------------------------
// Wire-level screening (client → server)
// ---------------------------------------------------------------------------

export type ClientScreenResult =
  | { kind: 'forward'; message: JsonRpcMessage; wire: string }
  | { kind: 'respond'; response: JsonRpcErrorResponse; reason: string }
  | { kind: 'drop'; reason: string };

export function screenClientLine(line: string): ClientScreenResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Deny by default: bytes we cannot parse are bytes we cannot judge.
    return {
      kind: 'respond',
      reason: 'non-JSON input (deny-by-default)',
      response: createErrorResponse(
        null,
        JsonRpcErrorCode.ParseError,
        'Parse error: MCP-Shield forwards valid JSON-RPC 2.0 only',
      ),
    };
  }

  if (Array.isArray(parsed)) {
    return {
      kind: 'respond',
      reason: `JSON-RPC batch of ${parsed.length} messages rejected`,
      response: createErrorResponse(
        null,
        JsonRpcErrorCode.InvalidRequest,
        'Invalid Request: batch requests are not permitted by MCP-Shield',
      ),
    };
  }

  if (!isJsonRpcMessage(parsed)) {
    return {
      kind: 'respond',
      reason: 'not a JSON-RPC 2.0 message',
      response: createErrorResponse(
        null,
        JsonRpcErrorCode.InvalidRequest,
        'Invalid Request: not a JSON-RPC 2.0 message',
      ),
    };
  }

  // Anything that even LOOKS like the tools/call method — after trimming and
  // case-folding — is treated as a tool invocation. A lenient server that
  // route-matches "Tools/Call" or "tools/call " (trailing space) would still
  // dispatch it, so we must not let the disguise skip the firewall: the
  // padded/case variant is held to the exact strict shape or rejected. This
  // covers id-less "notification" variants too (they execute unanswerably).
  const method = 'method' in parsed ? parsed.method : undefined;
  const claimsToolsCall = typeof method === 'string' && method.trim().toLowerCase() === McpMethod.ToolsCall;
  if (claimsToolsCall && !isStrictToolCall(parsed)) {
    const id = extractRespondableId(parsed);
    if (id === undefined) {
      return { kind: 'drop', reason: 'malformed tools/call without an id (would execute unanswerably)' };
    }
    return {
      kind: 'respond',
      reason:
        'malformed tools/call (disguised method, or params.name missing/empty/padded/not a string, or bad arguments/id)',
      response: createAccessDeniedResponse(id, 'malformed-tool-call'),
    };
  }

  // Canonical re-serialization: the server receives OUR serialization of the
  // object the firewall judged — never the client's raw bytes.
  return { kind: 'forward', message: parsed, wire: JSON.stringify(parsed) };
}

/**
 * The only tools/call shape allowed through: the exact method (no whitespace
 * or case disguise), a routable id, a tool name with no surrounding whitespace
 * (a padded name would dodge the rule engine's exact tool match yet still
 * dispatch on a trimming server), and — if present — an `arguments` object
 * that is a real object, so a positional-array `arguments` cannot make the
 * rules' `arguments.command` field unresolvable and slip through as allowed.
 */
function isStrictToolCall(value: JsonRpcMessage): value is McpToolCallRequest {
  if (
    !isToolCallRequest(value) ||
    value.method !== McpMethod.ToolsCall ||
    !(typeof value.id === 'string' || typeof value.id === 'number') ||
    value.params.name.trim() === '' ||
    value.params.name !== value.params.name.trim()
  ) {
    return false;
  }
  const args = value.params['arguments'];
  return args === undefined || (typeof args === 'object' && args !== null && !Array.isArray(args));
}

/**
 * The id to address a rejection to: the request's own id when it is a legal
 * one, null when an id field exists but is unusable (JSON-RPC prescribes a
 * null id for errors on undeterminable requests), undefined when there is no
 * id at all — a notification, which cannot be answered.
 */
function extractRespondableId(message: JsonRpcMessage): JsonRpcId | undefined {
  if (!('id' in message)) {
    return undefined;
  }
  const { id } = message;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}
