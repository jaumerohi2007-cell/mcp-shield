/**
 * Manual-approval queue (blueprint Component D) — hook (b) from src/index.ts.
 *
 * When the firewall returns `ask`, the client → server pipeline parks the
 * message here: an unresolved promise is stored alongside the captured
 * JSON-RPC request, the dashboard is told over Socket.io, and nothing behind
 * it moves until the user decides (approve / deny / modify). Because the
 * proxy's client queue is sequential, at most one request is parked at a time
 * in the current design, but the Map generalises to more.
 *
 * Every wait is bounded and fails CLOSED — the security default of the whole
 * proxy. A request is denied automatically if:
 *   - the user does not answer within `timeoutMs` (default 120 s), or
 *   - the dashboard goes away (last client disconnects) with it still pending.
 * so a hostile or absent operator can never leave the MCP client hanging.
 *
 * This module is transport-agnostic: `ApprovalQueue` takes a `broadcast`
 * callback and is driven by plain method calls, so it is unit-testable
 * without a live socket. `attachApprovalHandlers` is the thin Socket.io glue.
 */

import type { Server as SocketIoServer, Socket } from 'socket.io';

import {
  createAccessDeniedResponse,
  type JsonRpcErrorResponse,
  type McpToolCallRequest,
} from '../types/mcp.js';

export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

/** How a parked request was released. `modify` swaps in operator-edited arguments. */
export type ApprovalOutcome =
  | { action: 'approve' }
  | { action: 'deny'; reason: string }
  | { action: 'modify'; arguments: Record<string, unknown> };

interface PendingRequest {
  id: string;
  rpcRequest: McpToolCallRequest;
  ruleName: string;
  reason: string;
  createdAt: number;
  resolve: (outcome: ApprovalOutcome) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** The record the dashboard receives so it can render the pending card. */
export interface PendingView {
  id: string;
  ruleName: string;
  /** Human-readable condition that fired (e.g. `arguments.command regex "..."`). */
  reason: string;
  createdAt: number;
  tool: string;
  arguments: Record<string, unknown> | undefined;
  rpcRequest: McpToolCallRequest;
}

export interface ApprovalQueueOptions {
  /** Push an event to every connected dashboard client. */
  broadcast: (event: string, payload: unknown) => void;
  timeoutMs?: number;
  /** Injectable for deterministic tests; defaults to a monotonic counter. */
  idFactory?: () => string;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export class ApprovalQueue {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly broadcast: (event: string, payload: unknown) => void;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly nextId: () => string;
  private seq = 0;

  constructor(options: ApprovalQueueOptions) {
    this.broadcast = options.broadcast;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.nextId = options.idFactory ?? (() => `ask-${++this.seq}`);
  }

  /**
   * Park a request pending the operator's verdict. Resolves with their choice,
   * or auto-denies on timeout. Never rejects — the caller always gets a
   * decision it can act on, so the MCP client is never left hanging.
   */
  enqueue(rpcRequest: McpToolCallRequest, ruleName: string, reason = ''): Promise<ApprovalOutcome> {
    return new Promise<ApprovalOutcome>((resolve) => {
      const id = this.nextId();
      // A ref'd timer on purpose: while a request is parked we are waiting for
      // the operator, so this pending approval SHOULD keep the process alive
      // until it is answered or auto-denied at the deadline.
      const timer = setTimeout(() => {
        this.settle(id, { action: 'deny', reason: `approval timed out after ${this.timeoutMs}ms` });
      }, this.timeoutMs);

      const entry: PendingRequest = {
        id,
        rpcRequest,
        ruleName,
        reason,
        createdAt: this.now(),
        resolve,
        reject: () => {},
        timer,
      };
      this.pending.set(id, entry);
      this.broadcast('pending_approval', this.toView(entry));
    });
  }

  /** approve → let the original message through unchanged. */
  approve(id: string): boolean {
    return this.settle(id, { action: 'approve' });
  }

  /** deny → the caller returns Access Denied to the MCP client. */
  deny(id: string, reason = 'denied by operator'): boolean {
    return this.settle(id, { action: 'deny', reason });
  }

  /** modify → forward the call with operator-edited arguments instead. */
  modify(id: string, newArguments: Record<string, unknown>): boolean {
    return this.settle(id, { action: 'modify', arguments: newArguments });
  }

  /** Fail closed on every still-parked request (used when the dashboard vanishes). */
  denyAll(reason: string): void {
    for (const id of [...this.pending.keys()]) {
      this.settle(id, { action: 'deny', reason });
    }
  }

  /** Snapshot for a newly connected dashboard so it can render what is waiting. */
  snapshot(): PendingView[] {
    return [...this.pending.values()].map((entry) => this.toView(entry));
  }

  get size(): number {
    return this.pending.size;
  }

  private settle(id: string, outcome: ApprovalOutcome): boolean {
    const entry = this.pending.get(id);
    if (entry === undefined) {
      return false; // already resolved, timed out, or an unknown id from the UI
    }
    clearTimeout(entry.timer);
    this.pending.delete(id);
    this.broadcast('request_resolved', { id, outcome });
    entry.resolve(outcome);
    return true;
  }

  private toView(entry: PendingRequest): PendingView {
    return {
      id: entry.id,
      ruleName: entry.ruleName,
      reason: entry.reason,
      createdAt: entry.createdAt,
      tool: entry.rpcRequest.params.name,
      arguments: entry.rpcRequest.params.arguments,
      rpcRequest: entry.rpcRequest,
    };
  }
}

/** Build the Access Denied response the proxy returns for a denied/timed-out request. */
export function deniedResponse(request: McpToolCallRequest, reason: string): JsonRpcErrorResponse {
  return createAccessDeniedResponse(request.id, reason);
}

/**
 * Wire a Socket.io server to an ApprovalQueue:
 *  - a new client receives the current pending snapshot,
 *  - `approve` / `deny` / `modify` events settle the matching request,
 *  - when the LAST client disconnects, every still-pending request is denied
 *    (fail closed) so no verdict can hang waiting on an operator who left.
 *
 * `modify` payloads are validated to a plain-object `arguments` map; a
 * malformed edit is rejected rather than forwarded blindly.
 */
export function attachApprovalHandlers(io: SocketIoServer, queue: ApprovalQueue): void {
  // Track clients ourselves instead of reading io.engine.clientsCount inside
  // the disconnect handler: engine.io decrements that count asynchronously,
  // AFTER the 'disconnect' event, so it still reads the leaving socket at that
  // instant. A counter we bump on connect and drop in the disconnect handler
  // is exact.
  let clients = 0;

  io.on('connection', (socket: Socket) => {
    clients += 1;
    socket.emit('pending_snapshot', queue.snapshot());

    socket.on('approve', (payload: unknown) => {
      const id = extractId(payload);
      if (id !== undefined) {
        queue.approve(id);
      }
    });

    socket.on('deny', (payload: unknown) => {
      const id = extractId(payload);
      if (id !== undefined) {
        queue.deny(id);
      }
    });

    socket.on('modify', (payload: unknown) => {
      const id = extractId(payload);
      const args = extractArguments(payload);
      if (id !== undefined && args !== undefined) {
        queue.modify(id, args);
      } else if (id !== undefined) {
        // A modify with an unusable payload must not silently approve; deny it.
        queue.deny(id, 'modify payload was not a valid arguments object');
      }
    });

    socket.on('disconnect', () => {
      clients -= 1;
      // If this was the last dashboard, fail closed on anything still parked:
      // no operator remains to give a verdict. (A refresh briefly hits zero
      // too; denying is the safe default the whole proxy is built on.)
      if (clients === 0 && queue.size > 0) {
        queue.denyAll('dashboard disconnected before a verdict was given');
      }
    });
  });
}

function extractId(payload: unknown): string | undefined {
  if (typeof payload === 'string') {
    return payload;
  }
  if (typeof payload === 'object' && payload !== null) {
    const id = (payload as Record<string, unknown>)['id'];
    if (typeof id === 'string') {
      return id;
    }
  }
  return undefined;
}

function extractArguments(payload: unknown): Record<string, unknown> | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  // Accept either { id, arguments: {...} } or { id, modifiedPayload: {...} }.
  const record = payload as Record<string, unknown>;
  const candidate = record['arguments'] ?? record['modifiedPayload'];
  if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
    return candidate as Record<string, unknown>;
  }
  return undefined;
}
