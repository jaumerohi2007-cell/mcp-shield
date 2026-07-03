/**
 * MCP-Shield output sanitizer (blueprint Component C — hook (c) in src/index.ts).
 *
 * Tool results and resource contents are EXTERNAL DATA (web pages, files,
 * API responses) that land directly in the client model's context window. A
 * hostile document can carry instruction-override phrasing that hijacks the
 * agent's goals ("ignore previous instructions", "SYSTEM OVERRIDE: ...").
 * The sanitizer scans every text surface of a server → client result and
 * replaces a detected block with a safe marker before it reaches the client.
 */

import type { JsonRpcMessage } from '../types/mcp.js';

export const NEUTRALIZED_MARKER = '[PROMPT INJECTION DETECTED AND NEUTRALIZED BY MCP-SHIELD]';

interface InjectionPattern {
  label: string;
  pattern: RegExp;
}

// Case-insensitive, with \s+ wherever a space is expected so a phrase cannot
// dodge detection by line-wrapping or padding. Kept deliberately tight: every
// pattern is an instruction *aimed at the model*, not prose that could appear
// in ordinary tool output.
const INJECTION_PATTERNS: InjectionPattern[] = [
  {
    label: 'ignore-previous-instructions',
    pattern:
      /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|everything\s+)?(?:previous|prior|above|earlier|preceding|your)\s+(?:instructions?|prompts?|directives?|rules?|messages?|guidelines?|context|training)\b/i,
  },
  { label: 'system-override', pattern: /\bsystem[\s\-_]*override\b/i },
  { label: 'you-must-now', pattern: /\byou\s+must\s+now\b/i },
  // "New/updated instructions" followed by a colon, dash or period — the
  // punctuation an attacker uses to introduce the injected directive.
  { label: 'new-instructions', pattern: /\b(?:new|updated|revised)\s+instructions?\s*[:.\-]/i },
  {
    label: 'goal-hijack',
    pattern: /\byour\s+(?:new|real|true|actual)\s+(?:task|goal|objective|mission|instructions?)\s+(?:is|are)\b/i,
  },
  {
    label: 'hide-from-user',
    // "do not" and its contraction "don't" (any apostrophe), same verb set.
    pattern: /\bdo(?:\s+not|n['’]?t)\s+(?:tell|inform|alert|notify|warn)\s+the\s+user\b/i,
  },
  {
    label: 'fake-role-tag',
    pattern: /<\/?\s*(?:system|assistant)(?:_?(?:prompt|message))?\s*>/i,
  },
  {
    label: 'act-as-unrestricted',
    pattern: /\bact\s+as\s+(?:an?\s+)?(?:unrestricted|jailbroken|uncensored)\b/i,
  },
];

// Zero-width and invisible formatting characters an attacker can splice into
// a phrase ("ig<ZWSP>nore all previous instructions") to break \b/\s while a
// model still reads the intact words. Stripped before scanning.
const INVISIBLE_CHARS = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** Labels of every injection pattern the text triggers; empty means clean. */
export function scanText(text: string): string[] {
  // NFKC folds confusable/compatibility forms to their canonical characters,
  // then invisibles are removed, so obfuscated phrasings collapse back to the
  // plain text the patterns match.
  const normalized = text.normalize('NFKC').replace(INVISIBLE_CHARS, '');
  const hits: string[] = [];
  for (const { label, pattern } of INJECTION_PATTERNS) {
    if (pattern.test(normalized)) {
      hits.push(label);
    }
  }
  return hits;
}

export interface SanitizationResult {
  message: JsonRpcMessage;
  modified: boolean;
  detections: string[];
}

/**
 * Scan a server → client message and neutralize injected text blocks.
 *
 * Covers both content shapes external data travels in:
 *  - tools/call results:    result.content[]  ({type:'text'} blocks and
 *                           {type:'resource'} embedded resources)
 *  - resources/read results: result.contents[] (text resource items)
 *
 * A clean message is returned as the SAME object (`modified: false`), so the
 * caller can tell whether anything was rewritten.
 */
export function sanitizeServerMessage(message: JsonRpcMessage): SanitizationResult {
  if (!('result' in message) || typeof message.result !== 'object' || message.result === null) {
    return { message, modified: false, detections: [] };
  }

  const result = message.result as Record<string, unknown>;
  const sanitizedResult: Record<string, unknown> = { ...result };
  const detections: string[] = [];
  let modified = false;

  for (const key of ['content', 'contents'] as const) {
    const blocks = result[key];
    if (!Array.isArray(blocks)) {
      continue;
    }
    const sanitizedBlocks = blocks.map((block) => sanitizeBlock(block, detections));
    if (sanitizedBlocks.some((block, i) => block !== blocks[i])) {
      sanitizedResult[key] = sanitizedBlocks;
      modified = true;
    }
  }

  if (!modified) {
    return { message, modified: false, detections: [] };
  }
  return {
    message: { ...message, result: sanitizedResult },
    modified: true,
    detections: [...new Set(detections)],
  };
}

/** Returns the same block when clean, a rewritten copy when a text surface is hostile. */
function sanitizeBlock(block: unknown, detections: string[]): unknown {
  if (typeof block !== 'object' || block === null) {
    return block;
  }
  const record = block as Record<string, unknown>;

  // {type:'text', text} blocks and resources/read items both carry top-level text.
  const text = record['text'];
  if (typeof text === 'string') {
    const hits = scanText(text);
    if (hits.length > 0) {
      detections.push(...hits);
      return { ...record, text: NEUTRALIZED_MARKER };
    }
  }

  // {type:'resource', resource:{text}} embedded resources.
  const resource = record['resource'];
  if (typeof resource === 'object' && resource !== null) {
    const resourceText = (resource as Record<string, unknown>)['text'];
    if (typeof resourceText === 'string') {
      const hits = scanText(resourceText);
      if (hits.length > 0) {
        detections.push(...hits);
        return { ...record, resource: { ...(resource as Record<string, unknown>), text: NEUTRALIZED_MARKER } };
      }
    }
  }

  return block;
}
