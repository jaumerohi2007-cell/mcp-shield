import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';

import { getApiClient } from './apiClient.js';

const QUEUE_PATH = path.join(os.homedir(), '.mcp-shield', 'telemetry.queue.json');
const FLUSH_INTERVAL_MS = 10_000;
const FLUSH_SIZE = 50;

// Unique per process startup — generated once when this module is first imported.
const SESSION_ID = `sess_${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

interface AuditEvent {
  timestamp: number;
  client_session_id: string;
  tool: string;
  arguments?: Record<string, unknown>;
  verdict: 'allowed' | 'blocked' | 'modified';
  triggered_rule_name?: string;
  sanitized_output_detected: boolean;
}

/** What callers supply — manager adds timestamp and session id. */
export interface TelemetryEventInput {
  tool: string;
  arguments?: Record<string, unknown>;
  verdict: 'allowed' | 'blocked' | 'modified';
  triggered_rule_name?: string;
  sanitized_output_detected: boolean;
}

// ---------------------------------------------------------------------------
// Offline queue helpers
// ---------------------------------------------------------------------------

async function loadQueue(): Promise<AuditEvent[]> {
  try {
    const raw = await fs.readFile(QUEUE_PATH, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AuditEvent[]) : [];
  } catch {
    return [];
  }
}

async function saveQueue(events: AuditEvent[]): Promise<void> {
  await fs.mkdir(path.dirname(QUEUE_PATH), { recursive: true });
  await fs.writeFile(QUEUE_PATH, JSON.stringify(events), 'utf-8');
}

async function clearQueue(): Promise<void> {
  await fs.unlink(QUEUE_PATH).catch(() => {});
}

async function appendToQueue(events: AuditEvent[]): Promise<void> {
  const existing = await loadQueue();
  await saveQueue([...existing, ...events]);
}

// ---------------------------------------------------------------------------
// TelemetryManager
// ---------------------------------------------------------------------------

export class TelemetryManager {
  private readonly email: string;
  private readonly buffer: AuditEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;

  private constructor(email: string) {
    this.email = email;
  }

  static async create(): Promise<TelemetryManager> {
    const client = await getApiClient();
    return new TelemetryManager(client.email ?? 'unknown');
  }

  /** Append an event to the in-memory buffer. Triggers an immediate flush if the buffer is full. */
  record(input: TelemetryEventInput): void {
    this.buffer.push({ ...input, timestamp: Date.now(), client_session_id: SESSION_ID });
    if (this.buffer.length >= FLUSH_SIZE) {
      void this.flush();
    }
  }

  startFlushTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => { void this.flush(); }, FLUSH_INTERVAL_MS);
    // Must not prevent clean process exit — the proxy exits when the MCP client
    // closes the pipe, not when the telemetry timer fires.
    this.timer.unref();
  }

  stopFlushTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Drains the in-memory buffer and ships it (plus any offline-queued events) to
   * the audit endpoint. On network/server failure the buffer contents are
   * appended to the local queue file so no audit record is ever lost.
   *
   * Only one flush runs at a time: concurrent calls (timer + buffer-full trigger)
   * are no-ops until the current flush settles.
   */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;

    // Drain atomically — new events accumulate in the buffer while we do I/O.
    const buffered = this.buffer.splice(0);

    try {
      // Retry any events that failed to ship in a previous cycle (offline events
      // come first to maintain chronological order in the audit log).
      const queued = await loadQueue();
      const allEvents = [...queued, ...buffered];
      if (allEvents.length === 0) return;

      const client = await getApiClient();
      await client.post<unknown>('/api/v1/audit/logs', {
        developer_email: this.email,
        events: allEvents,
      });

      // All events shipped: the queue file is now obsolete.
      await clearQueue();
    } catch {
      // Network/auth failure — persist what we just drained so it survives the
      // next flush attempt (old queue events remain on disk untouched).
      if (buffered.length > 0) {
        await appendToQueue(buffered).catch(() => {});
      }
    } finally {
      this.flushing = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Best-effort startup helper
// ---------------------------------------------------------------------------

/**
 * Tries to initialize the telemetry manager and start the flush timer. Returns
 * null (and logs to stderr) if the developer has no active Enterprise session —
 * the proxy runs without telemetry rather than failing to start.
 */
export async function tryStartEnterpriseTelemetry(): Promise<TelemetryManager | null> {
  try {
    const manager = await TelemetryManager.create();
    manager.startFlushTimer();
    return manager;
  } catch (err) {
    process.stderr.write(
      `[mcp-shield] enterprise telemetry unavailable: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}
