import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const SERVER_URL = process.env['MCP_SHIELD_SERVER_URL'] ?? 'https://api.mcp-shield.com';
const SESSION_PATH = path.join(os.homedir(), '.mcp-shield', 'session.json');
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;

interface SessionData {
  token: string;
  email?: string;
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
}

function isSessionData(v: unknown): v is SessionData {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  const token = obj['token'];
  return typeof token === 'string' && token.length > 0;
}

async function loadSession(): Promise<SessionData> {
  let raw: string;
  try {
    raw = await fs.readFile(SESSION_PATH, 'utf-8');
  } catch {
    throw new Error(
      `MCP-Shield: No active session found at ${SESSION_PATH}.\n` +
      `Run 'mcp-shield login' to authenticate with your Enterprise account.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `MCP-Shield: Session file at ${SESSION_PATH} is corrupted (invalid JSON).\n` +
      `Run 'mcp-shield login' to re-authenticate.`,
    );
  }

  if (!isSessionData(parsed)) {
    throw new Error(
      `MCP-Shield: Session file at ${SESSION_PATH} is missing a valid token.\n` +
      `Run 'mcp-shield login' to re-authenticate.`,
    );
  }

  return parsed;
}

function backoffDelay(attempt: number): number {
  const exp = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = exp * 0.25 * (Math.random() * 2 - 1);
  return Math.round(exp + jitter);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class EnterpriseApiClient {
  readonly baseUrl: string;
  readonly email: string | undefined;
  private readonly apiKey: string;

  private constructor(apiKey: string, email?: string) {
    this.baseUrl = SERVER_URL;
    this.apiKey = apiKey;
    this.email = email;
  }

  static async create(): Promise<EnterpriseApiClient> {
    const session = await loadSession();
    return new EnterpriseApiClient(session.token, session.email);
  }

  async get<T>(endpoint: string): Promise<T> {
    return this.requestWithRetry<T>(endpoint, { method: 'GET' });
  }

  async post<T>(endpoint: string, body: unknown): Promise<T> {
    return this.requestWithRetry<T>(endpoint, { method: 'POST', body });
  }

  private async requestWithRetry<T>(
    endpoint: string,
    options: RequestOptions,
    attempt = 0,
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'mcp-shield/0.1.0',
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await sleep(backoffDelay(attempt));
        return this.requestWithRetry<T>(endpoint, options, attempt + 1);
      }
      throw new Error(
        `MCP-Shield: Network error reaching ${url} after ${MAX_RETRIES + 1} attempts: ${String(err)}`,
      );
    }

    if (!response.ok) {
      if (isRetryableStatus(response.status) && attempt < MAX_RETRIES) {
        await sleep(backoffDelay(attempt));
        return this.requestWithRetry<T>(endpoint, options, attempt + 1);
      }
      const text = await response.text().catch(() => '');
      throw new Error(
        `MCP-Shield: Server returned ${response.status} from ${url}` +
        (text ? `: ${text}` : ''),
      );
    }

    return response.json() as Promise<T>;
  }
}

let _client: EnterpriseApiClient | null = null;

export async function getApiClient(): Promise<EnterpriseApiClient> {
  if (_client === null) {
    _client = await EnterpriseApiClient.create();
  }
  return _client;
}
