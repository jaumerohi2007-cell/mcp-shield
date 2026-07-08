#!/usr/bin/env node
/**
 * MCP-Shield — entry point.
 *
 * Transparent security proxy between an MCP client (e.g. Claude Code) and a
 * target MCP server. The client speaks line-delimited JSON-RPC 2.0 over stdio;
 * MCP-Shield launches the real server as a child process and sits inline,
 * relaying every packet through its security hooks:
 *
 *   client (process.stdin) ──▶ [firewall + approval hooks] ──▶ target.stdin
 *   target.stdout ──▶ [sanitizer hook] ──▶ client (process.stdout)
 *
 * process.stdout carries protocol traffic ONLY — every diagnostic goes to
 * stderr, otherwise the client would try to parse it as JSON-RPC.
 */

import { spawn } from 'node:child_process';
import { readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { Firewall, screenClientLine } from './security/firewall.js';
import { hasSession, runCliLoginFlow } from './enterprise/auth.js';
import { runInstallCommand, runUninstallCommand, shieldInvocation } from './install.js';
import { tryStartEnterpriseSync } from './enterprise/ruleSync.js';
import { tryStartEnterpriseTelemetry, type TelemetryManager } from './enterprise/telemetry.js';
import { sanitizeServerMessage } from './security/sanitizer.js';
import { startDashboardServer, type DashboardServer } from './server/dashboardServer.js';
import {
  createAccessDeniedResponse,
  isJsonRpcMessage,
  isToolCallRequest,
  type JsonRpcMessage,
  type McpToolCallRequest,
} from './types/mcp.js';

// ---------------------------------------------------------------------------
// Diagnostics — stderr only, stdout belongs to the protocol
// ---------------------------------------------------------------------------

function log(message: string): void {
  process.stderr.write(`[mcp-shield] ${message}\n`);
}

function fail(message: string): never {
  log(message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const USAGE = 'usage: mcp-shield [--port <0-65535>] -- <target-command> [target-args...]  (0 = OS-assigned)';
const DEFAULT_PORT = 3000;

interface CliOptions {
  port: number;
  targetCommand: string;
  targetArgs: string[];
}

function parseCliArgs(argv: string[]): CliOptions {
  const sepIndex = argv.indexOf('--');
  if (sepIndex === -1) {
    fail(`missing "--" separator before the target command.\n${USAGE}`);
  }

  const shieldArgs = argv.slice(0, sepIndex);
  const [targetCommand, ...targetArgs] = argv.slice(sepIndex + 1);
  if (targetCommand === undefined) {
    fail(`missing target command after "--".\n${USAGE}`);
  }

  let port = DEFAULT_PORT;
  for (let i = 0; i < shieldArgs.length; i += 1) {
    const arg = shieldArgs[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--port' || arg === '-p') {
      i += 1;
      const raw = shieldArgs[i];
      // 0 is valid: it asks the OS for any free port (the dashboard logs the
      // actual one). 1..65535 are the usual explicit ports.
      if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 0 || Number(raw) > 65535) {
        fail(`invalid --port value: ${raw ?? '(missing)'}\n${USAGE}`);
      }
      port = Number(raw);
    } else {
      fail(`unknown option: ${arg}\n${USAGE}`);
    }
  }

  return { port, targetCommand, targetArgs };
}

// ---------------------------------------------------------------------------
// `mcp-shield register` — write the shield entry into the Claude MCP config
// ---------------------------------------------------------------------------

const REGISTER_USAGE = 'usage: mcp-shield register [--local] -- <target-command> [target-args...]';

/**
 * Registers the proxy in Claude's MCP config so users don't have to hand-edit
 * JSON or fight CLI quoting. Global scope writes ~/.claude.json; --local (or
 * --project) writes .mcp.json in the current directory instead.
 */
async function runRegisterCommand(args: string[]): Promise<void> {
  const sepIndex = args.indexOf('--');
  const flags = sepIndex === -1 ? args : args.slice(0, sepIndex);
  const target = sepIndex === -1 ? [] : args.slice(sepIndex + 1);

  let local = false;
  for (const flag of flags) {
    if (flag === '--local' || flag === '--project') {
      local = true;
    } else {
      fail(`unknown option: ${flag}\n${REGISTER_USAGE}`);
    }
  }
  if (target.length === 0) {
    fail(`missing target command after "--".\n${REGISTER_USAGE}`);
  }

  const configPath = local
    ? path.join(process.cwd(), '.mcp.json')
    : path.join(homedir(), '.claude.json');

  // ~/.claude.json holds the user's entire Claude Code state, not just MCP
  // servers — anything unreadable or unparseable must abort untouched rather
  // than get clobbered with a fresh skeleton.
  let raw: string | null = null;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      fail(`cannot read ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let config: Record<string, unknown> = { mcpServers: {} };
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      fail(`${configPath} is not valid JSON — fix or remove it, then retry: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      fail(`${configPath} does not contain a JSON object at the top level`);
    }
    config = parsed as Record<string, unknown>;
  }

  const existingServers = config['mcpServers'];
  const servers: Record<string, unknown> =
    typeof existingServers === 'object' && existingServers !== null && !Array.isArray(existingServers)
      ? (existingServers as Record<string, unknown>)
      : {};
  config['mcpServers'] = servers;
  // Absolute invocation, never a bare "mcp-shield": the client resolves the
  // command against ITS OWN PATH at spawn time (see shieldInvocation).
  const invocation = shieldInvocation();
  servers['shield'] = { command: invocation[0], args: [...invocation.slice(1), '--', ...target] };

  // An in-place writeFile truncates before it streams, so a crash or Ctrl-C
  // mid-write would destroy the very state this command promises to keep
  // intact. Write a sibling temp file and rename it over the target instead —
  // the swap is atomic on POSIX. realpath first, so an intentionally
  // symlinked config keeps working: the rename lands on the link's target
  // rather than replacing the link with a regular file.
  let destPath = configPath;
  try {
    destPath = await realpath(configPath);
  } catch {
    // Fresh file (ENOENT): rename straight to the literal path.
  }
  const tmpPath = `${destPath}.${process.pid}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await rename(tmpPath, destPath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    fail(`cannot write ${destPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const message = `[mcp-shield] Successfully registered "shield" server in ${configPath}. Please restart Claude Code to apply changes.`;
  const line = process.stderr.isTTY ? `\x1b[32m${message}\x1b[0m\n` : `${message}\n`;
  // Wait for the write callback: stderr on a pipe is async, and process.exit
  // right after would truncate the one line of feedback this command produces.
  await new Promise<void>((resolve) => {
    process.stderr.write(line, () => resolve());
  });
}

// ---------------------------------------------------------------------------
// Command dispatch — before any proxy subsystem initializes, so a proxy-only
// startup failure (e.g. a poisoned rules cache making Firewall.create throw)
// can never take `login` or `register` down with it
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);

async function main() {
  // ── `mcp-shield login` ──────────────────────────────────────────────────────
  // Dedicated command: runs the SSO loopback flow, writes ~/.mcp-shield/session.json
  // and exits. No MCP target server is spawned.
  if (rawArgs[0] === 'login') {
    try {
      await runCliLoginFlow();
    } catch (err) {
      fail(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(0);
  }

  // ── `mcp-shield register` ───────────────────────────────────────────────────
  // Dedicated command: writes the "shield" proxy entry into the Claude MCP
  // config (global ~/.claude.json, or ./.mcp.json with --local/--project) and
  // exits. No MCP target server is spawned.
  if (rawArgs[0] === 'register') {
    await runRegisterCommand(rawArgs.slice(1));
    process.exit(0);
  }

  // ── `mcp-shield install` ────────────────────────────────────────────────────
  // Dedicated command: wraps the servers of a known MCP client (claude, cursor,
  // vscode, windsurf, claude-code) behind the shield. With no argument it
  // auto-detects every client installed on this machine and shields them all.
  if (rawArgs[0] === 'install') {
    await runInstallCommand(rawArgs[1]);
    process.exit(0);
  }

  // ── `mcp-shield uninstall` ──────────────────────────────────────────────────
  // Dedicated command: reverts the auto-configuration (same auto-detect sweep)
  if (rawArgs[0] === 'uninstall') {
    await runUninstallCommand(rawArgs[1]);
    process.exit(0);
  }

// ---------------------------------------------------------------------------
// Line-delimited JSON-RPC framing
// ---------------------------------------------------------------------------

/**
 * Accumulates raw stdio chunks and yields complete lines. MCP stdio framing
 * is one JSON-RPC message per '\n'-terminated line, but a chunk boundary can
 * fall anywhere — even mid-message — so the tail is kept until its newline
 * arrives.
 */
class LineBuffer {
  private chunks: string[] = [];

  *feed(chunk: string): Generator<string> {
    // A chunk without a newline just extends the pending line: O(chunk) work,
    // never re-scanning or re-copying what is already buffered. Join + split
    // happen once per newline, so a multi-megabyte single-line message (e.g.
    // a base64 image in a tools/call result) stays linear instead of
    // quadratic — string += concatenation here measured ~20x slower at 48 MiB.
    if (!chunk.includes('\n')) {
      if (chunk !== '') {
        this.chunks.push(chunk);
      }
      return;
    }
    this.chunks.push(chunk);
    const parts = this.chunks.join('').split('\n');
    this.chunks.length = 0;
    const tail = parts.pop();
    if (tail !== undefined && tail !== '') {
      this.chunks.push(tail);
    }
    for (const part of parts) {
      const line = part.replace(/\r$/, '');
      if (line.trim() !== '') {
        yield line;
      }
    }
  }

  /** Whatever remains once the stream ends: a final line missing its newline. */
  flush(): string | null {
    const rest = this.chunks.join('').trim();
    this.chunks.length = 0;
    return rest === '' ? null : rest;
  }
}

/**
 * Serializes async message handling per direction: a held or slow message
 * must not let a later one overtake it, or JSON-RPC ordering breaks. This is
 * also what will make Phase 4 work: while an 'ask' verdict keeps one message
 * parked awaiting dashboard approval, everything behind it waits in order.
 */
function createSequentialQueue(label: string): (task: () => Promise<void>) => void {
  let tail: Promise<void> = Promise.resolve();
  return (task) => {
    tail = tail.then(task).catch((err: unknown) => {
      log(`${label} pipeline error: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
}

// ---------------------------------------------------------------------------
// Security hooks — firewall, sanitizer, and manual approval (Phases 3 & 4)
// ---------------------------------------------------------------------------

const firewall = await Firewall.create();

// Set once the dashboard is up. null means no dashboard (startup failed), in
// which case an 'ask' verdict falls back to failing closed.
let dashboard: DashboardServer | null = null;

// null when no Enterprise session is active — telemetry calls are no-ops.
let telemetry: TelemetryManager | null = null;

type AuthorizationDecision =
  | { action: 'forward'; viaApproval?: boolean }
  | { action: 'forward-modified'; message: McpToolCallRequest; viaApproval?: boolean }
  | { action: 'block'; ruleName: string; viaApproval?: boolean };

/**
 * HOOK (a) — firewall: every structurally valid tools/call is judged against
 * the SecurityRules (src/config/rules.ts) by the engine in
 * src/security/firewall.ts.
 *
 * HOOK (b) — manual approval (src/server/wsHandler.ts): an 'ask' verdict parks
 * this promise, emits 'pending_approval' over Socket.io, and waits for the
 * operator's verdict from the dashboard:
 *   approve → { action: 'forward' }
 *   deny    → { action: 'block' }        (also on timeout / dashboard gone)
 *   modify  → { action: 'forward-modified' } with operator-edited arguments
 * The sequential client queue guarantees messages behind a parked one wait
 * their turn. With no dashboard, 'ask' FAILS CLOSED (denied).
 */
async function authorizeToolCall(request: McpToolCallRequest): Promise<AuthorizationDecision> {
  const verdict = firewall.evaluateToolCall(request);
  if (verdict.action === 'allow') {
    return { action: 'forward' };
  }
  if (verdict.action === 'block') {
    return { action: 'block', ruleName: verdict.rule.name };
  }

  // ask: hold for manual approval.
  if (dashboard === null) {
    log(`ask: "${request.params.name}" (rule: ${verdict.rule.name}) — no dashboard, failing closed`);
    return { action: 'block', ruleName: verdict.rule.name };
  }

  log(`ask: "${request.params.name}" (rule: ${verdict.rule.name}) — awaiting dashboard approval`);
  const outcome = await dashboard.queue.enqueue(request, verdict.rule.name, verdict.reason);
  // viaApproval marks a decision that already surfaced on the dashboard as
  // pending_approval → request_resolved. handleClientLine must NOT also emit an
  // 'activity' feed event for it, or the dashboard would show the request twice
  // (a stale pending row plus a duplicate resolved row) and double-count stats.
  switch (outcome.action) {
    case 'approve':
      return { action: 'forward', viaApproval: true };
    case 'modify':
      return {
        action: 'forward-modified',
        message: { ...request, params: { ...request.params, arguments: outcome.arguments } },
        viaApproval: true,
      };
    case 'deny':
      log(`ask: "${request.params.name}" denied (${outcome.reason})`);
      return { action: 'block', ruleName: verdict.rule.name, viaApproval: true };
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const options = parseCliArgs(rawArgs);

// Start the dashboard first so the approval queue exists before any traffic
// flows. A startup failure is non-fatal: the proxy still firewalls and
// sanitizes, and 'ask' verdicts fall back to failing closed.
try {
  dashboard = await startDashboardServer(options.port, { log });
} catch (err) {
  log(`dashboard failed to start: ${err instanceof Error ? err.message : String(err)} — 'ask' will fail closed`);
}

// Enterprise features are gated on an active session. A missing or invalid
// session file means the developer is using the free local-first tier — we
// print a one-time hint and continue without cloud features.
if (await hasSession()) {
  await tryStartEnterpriseSync((rules) => { firewall.reloadRules(rules); });
  telemetry = await tryStartEnterpriseTelemetry();
} else {
  log('Running in local-first mode. To enable Enterprise security policy syncing and audit logging, run "mcp-shield login".');
}

log(`spawning target server: ${options.targetCommand} ${options.targetArgs.join(' ')}`.trimEnd());
const child = spawn(options.targetCommand, options.targetArgs, {
  // stdin/stdout piped (the protocol channel we intercept); stderr inherited
  // so the target server's own diagnostics stay visible on our stderr.
  stdio: ['pipe', 'pipe', 'inherit'],
});

child.on('error', (err) => {
  fail(`failed to spawn target server "${options.targetCommand}": ${err.message}`);
});

if (child.stdin === null || child.stdout === null) {
  fail('target server spawned without stdio pipes');
}
const targetStdin = child.stdin;
const targetStdout = child.stdout;

targetStdin.on('error', (err: NodeJS.ErrnoException) => {
  log(`target stdin error: ${err.message}`);
});

// ---------------------------------------------------------------------------
// Shutdown escalation
// ---------------------------------------------------------------------------

const KILL_GRACE_MS = 5000;
let killTimer: NodeJS.Timeout | null = null;

/**
 * After asking the target to stop (signal forwarded or stdin EOF propagated),
 * force-kill it if it lingers: the proxy must never outlive a shutdown
 * request just because the target traps the signal or ignores EOF — that
 * would block the supervising client forever and, once it escalates to
 * SIGKILL on the proxy, orphan the very server the shield is meant to control.
 */
function armKillTimer(): void {
  if (killTimer !== null) {
    return;
  }
  killTimer = setTimeout(() => {
    log(`target server still alive ${KILL_GRACE_MS}ms after shutdown request, sending SIGKILL`);
    child.kill('SIGKILL');
  }, KILL_GRACE_MS);
  // Never keeps the proxy alive on its own; kill on an already-dead pid is a no-op.
  killTimer.unref();
}

// ---------------------------------------------------------------------------
// Wire writers
// ---------------------------------------------------------------------------

function writeToServer(line: string): void {
  targetStdin.write(`${line}\n`);
}

function writeToClient(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Fire-and-forget one activity record to the dashboard feed. Never throws into
 * the hot path and, being an io.emit, never touches stdout. A no-op when no
 * dashboard is running. `pending` decisions are already carried by the
 * queue's own pending_approval/request_resolved events, so this covers the
 * immediate outcomes (allowed / blocked / modified) the feed and stats need.
 */
type ActivityStatus = 'allowed' | 'blocked' | 'modified';
function emitActivity(fields: {
  status: ActivityStatus;
  tool?: string;
  arguments?: Record<string, unknown>;
  rule?: string;
  reason?: string;
  id?: string | number | null;
}): void {
  if (dashboard === null) {
    return;
  }
  // Best-effort telemetry: Socket.io serializes eagerly, so a hostile
  // non-serializable argument (a BigInt slipping through, a circular ref)
  // would throw synchronously here. That must never abort the message's
  // forwarding, so swallow it — the packet still gets proxied.
  try {
    dashboard.broadcast('activity', { ...fields, ts: Date.now() });
  } catch (err) {
    log(`activity broadcast failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function describeMessage(message: JsonRpcMessage): string {
  if ('method' in message) {
    return 'id' in message
      ? `request ${message.method} (id=${message.id})`
      : `notification ${message.method}`;
  }
  return 'error' in message
    ? `error response (id=${message.id})`
    : `response (id=${message.id})`;
}

/** client → server: screen the wire (deny-by-default), authorize tool calls, forward canonically. */
async function handleClientLine(line: string): Promise<void> {
  const screened = screenClientLine(line);

  if (screened.kind === 'respond') {
    log(`REJECTED client line: ${screened.reason}`);
    emitActivity({ status: 'blocked', reason: screened.reason, rule: 'wire-screening' });
    writeToClient(JSON.stringify(screened.response));
    return;
  }
  if (screened.kind === 'drop') {
    log(`DROPPED client line: ${screened.reason}`);
    emitActivity({ status: 'blocked', reason: screened.reason, rule: 'wire-screening' });
    return;
  }

  const { message } = screened;
  if (isToolCallRequest(message)) {
    const decision = await authorizeToolCall(message);

    // A viaApproval decision already reached the dashboard as
    // pending_approval → request_resolved, which drives its feed row and
    // stats; emitting activity too would duplicate it. So only immediate
    // (non-approval) decisions produce an activity event.
    if (decision.action === 'block') {
      log(`BLOCKED tools/call "${message.params.name}" (rule: ${decision.ruleName})`);
      telemetry?.record({
        tool: message.params.name,
        arguments: message.params.arguments,
        verdict: 'blocked',
        triggered_rule_name: decision.ruleName,
        sanitized_output_detected: false,
      });
      if (!decision.viaApproval) {
        emitActivity({
          status: 'blocked',
          tool: message.params.name,
          arguments: message.params.arguments,
          rule: decision.ruleName,
          id: message.id,
        });
      }
      writeToClient(JSON.stringify(createAccessDeniedResponse(message.id, decision.ruleName)));
      return;
    }

    if (decision.action === 'forward-modified') {
      log(`MODIFIED tools/call "${message.params.name}" forwarded`);
      telemetry?.record({
        tool: message.params.name,
        arguments: decision.message.params.arguments,
        verdict: 'modified',
        sanitized_output_detected: false,
      });
      // forward-modified only ever comes from the approval flow (viaApproval),
      // so request_resolved already covers it — no activity event here.
      writeToServer(JSON.stringify(decision.message));
      return;
    }

    log(`ALLOWED tools/call "${message.params.name}"`);
    telemetry?.record({
      tool: message.params.name,
      arguments: message.params.arguments,
      verdict: 'allowed',
      sanitized_output_detected: false,
    });
    if (!decision.viaApproval) {
      emitActivity({
        status: 'allowed',
        tool: message.params.name,
        arguments: message.params.arguments,
        id: message.id,
      });
    }
  } else {
    log(`client → server: ${describeMessage(message)}`);
  }

  // Always the canonical re-serialization, never the client's raw bytes:
  // duplicate-key parser differentials die here.
  writeToServer(screened.wire);
}

/** server → client: parse, sanitize external text (HOOK c), forward canonically. */
async function handleServerLine(line: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Server-side noise (a banner, a stray print) — the client's parser will
    // skip it just like ours did. Only client input is deny-by-default.
    log('server → client: forwarding non-JSON line untouched');
    writeToClient(line);
    return;
  }

  if (!isJsonRpcMessage(parsed)) {
    writeToClient(line);
    return;
  }

  const { message, modified, detections } = sanitizeServerMessage(parsed);
  if (modified) {
    log(`NEUTRALIZED prompt injection in server output (${detections.join(', ')})`);
    telemetry?.record({
      tool: 'server-output',
      verdict: 'modified',
      sanitized_output_detected: true,
    });
  }
  // Canonical re-serialization: the client receives exactly the object the
  // sanitizer judged, closing duplicate-key differentials in this direction too.
  writeToClient(JSON.stringify(message));
}

// ---------------------------------------------------------------------------
// stdio pumps
// ---------------------------------------------------------------------------

const clientBuffer = new LineBuffer();
const serverBuffer = new LineBuffer();
const enqueueClientTask = createSequentialQueue('client → server');
const enqueueServerTask = createSequentialQueue('server → client');

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string | Buffer) => {
  for (const line of clientBuffer.feed(chunk.toString())) {
    enqueueClientTask(() => handleClientLine(line));
  }
});
process.stdin.on('end', () => {
  const rest = clientBuffer.flush();
  if (rest !== null) {
    enqueueClientTask(() => handleClientLine(rest));
  }
  // The client hung up: fail closed on anything still parked awaiting a
  // verdict. Otherwise the EOF propagation below — enqueued BEHIND the parked
  // task on the sequential client queue — would wait out the full 120 s
  // approval timeout, so the target never gets EOF and the SIGKILL fallback
  // never arms. Mirrors the dashboard last-client-disconnect backstop.
  dashboard?.queue.denyAll('MCP client disconnected before a verdict was given');
  // Propagate EOF so the target knows the client hung up — after queued work.
  // Per the MCP stdio shutdown convention (close stdin → wait → escalate),
  // arm the SIGKILL fallback in case the target ignores EOF.
  enqueueClientTask(async () => {
    targetStdin.end();
    armKillTimer();
  });
});
process.stdin.on('error', (err: NodeJS.ErrnoException) => {
  log(`client stdin error: ${err.message}`);
});

targetStdout.setEncoding('utf8');
targetStdout.on('data', (chunk: string | Buffer) => {
  for (const line of serverBuffer.feed(chunk.toString())) {
    enqueueServerTask(() => handleServerLine(line));
  }
});
targetStdout.on('end', () => {
  const rest = serverBuffer.flush();
  if (rest !== null) {
    enqueueServerTask(() => handleServerLine(rest));
  }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// If the client goes away mid-write, exit quietly instead of crashing — but
// take the target server down with us: nothing supervises it once we're gone.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      armKillTimer();
      child.once('close', () => process.exit(0));
    } else {
      process.exit(0);
    }
    return;
  }
  log(`client stdout error: ${err.message}`);
});

// 'close' (not 'exit') so the target's stdout has fully drained first.
child.on('close', (code, signal) => {
  log(`target server closed (code=${code ?? 'none'}, signal=${signal ?? 'none'})`);
  enqueueServerTask(async () => {
    const rest = serverBuffer.flush();
    if (rest !== null) {
      await handleServerLine(rest);
    }
    // Empty write: its callback fires only after everything queued before it
    // has been handed to the client pipe, so exiting here cannot truncate.
    process.stdout.write('', () => {
      process.exit(code ?? (signal !== null ? 1 : 0));
    });
  });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log(`received ${signal}, stopping target server`);
    child.kill(signal);
    armKillTimer();
  });
}

} // end of main()
main().catch(err => fail(`Unhandled error: ${err instanceof Error ? err.message : String(err)}`));
