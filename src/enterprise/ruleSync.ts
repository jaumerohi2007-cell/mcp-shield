import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';

import { CACHE_PATH, isSecurityRule, type SecurityRule } from '../config/rules.js';
import { getApiClient, PaymentRequiredError } from './apiClient.js';

const POLL_INTERVAL_MS = 5 * 60 * 1_000;

interface SyncResponse {
  version: string;
  rules: SecurityRule[];
}

function isSyncResponse(v: unknown): v is SyncResponse {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  const version = obj['version'];
  const rules = obj['rules'];
  if (typeof version !== 'string') return false;
  if (!Array.isArray(rules) || !rules.every(isSecurityRule)) return false;
  return true;
}

async function saveCache(data: SyncResponse): Promise<void> {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

export class RuleSyncManager {
  private readonly onRulesUpdated: (rules: SecurityRule[]) => void;
  private timer: NodeJS.Timeout | null = null;

  constructor(onRulesUpdated: (rules: SecurityRule[]) => void) {
    this.onRulesUpdated = onRulesUpdated;
  }

  async syncRules(): Promise<void> {
    const client = await getApiClient();
    const raw = await client.get<unknown>('/api/v1/rules/sync');
    if (!isSyncResponse(raw)) {
      throw new Error('MCP-Shield Enterprise: server returned an invalid rule set — ignoring update');
    }
    await saveCache(raw);
    this.onRulesUpdated(raw.rules);
  }

  startPolling(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.syncRules().catch((err: unknown) => {
        process.stderr.write(
          `[mcp-shield] enterprise rule sync failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
    }, POLL_INTERVAL_MS);
    // Must not keep the process alive on its own — the proxy exits when the MCP
    // client closes the pipe, not when the polling timer fires.
    this.timer.unref();
  }

  stopPolling(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Best-effort Enterprise initialization: attempts an initial sync and starts
 * background polling. Returns the manager on success or null if the developer
 * has no active Enterprise session — the proxy continues with cached/default
 * rules either way.
 */
export async function tryStartEnterpriseSync(
  onRulesUpdated: (rules: SecurityRule[]) => void,
): Promise<RuleSyncManager | null> {
  const manager = new RuleSyncManager(onRulesUpdated);
  try {
    await manager.syncRules();
    manager.startPolling();
    return manager;
  } catch (err) {
    if (err instanceof PaymentRequiredError) {
      process.stderr.write(
        `[mcp-shield] Enterprise features are OFF — no active subscription or the trial has expired. ` +
        `Subscribe in the admin console to enable centralized rules and audit. Running with local rules.\n`,
      );
    } else {
      process.stderr.write(
        `[mcp-shield] enterprise sync unavailable: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    return null;
  }
}
