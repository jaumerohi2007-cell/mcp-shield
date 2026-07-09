import { exec } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';

// NOTE: The spec names the session field "apiKey", but apiClient.ts was
// established in Step 1 with "token". We use "token" throughout for
// consistency with the existing validated schema.
const SESSION_DIR = path.join(os.homedir(), '.mcp-shield');
const SESSION_PATH = path.join(SESSION_DIR, 'session.json');
// El portal SSO vive en el MISMO servidor que la API (endpoint login-mock), así
// que su URL se deriva de MCP_SHIELD_SERVER_URL: un solo host que configurar.
// MCP_SHIELD_AUTH_URL sigue disponible como override explícito.
const SERVER_URL = (process.env['MCP_SHIELD_SERVER_URL'] ?? 'https://mcp-shield-server.onrender.com').replace(/\/+$/, '');
const AUTH_URL = process.env['MCP_SHIELD_AUTH_URL'] ?? `${SERVER_URL}/api/v1/auth/login-mock`;
const CLIENT_ID = 'mcp_shield_cli';
const LOOPBACK_START = 3009;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;

// ---------------------------------------------------------------------------
// HTML success page
// ---------------------------------------------------------------------------

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MCP-Shield — Authenticated</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0a0a0a;
      color: #e5e5e5;
    }
    .card {
      text-align: center;
      padding: 3rem 4rem;
      max-width: 520px;
      background: #141414;
      border: 1px solid #2a2a2a;
      border-radius: 16px;
      box-shadow: 0 24px 64px rgba(0, 0, 0, .6);
    }
    .shield { font-size: 3.5rem; margin-bottom: 1.5rem; }
    h1 { font-size: 1.75rem; font-weight: 600; color: #22c55e; margin-bottom: .75rem; }
    p { color: #a3a3a3; line-height: 1.65; font-size: .95rem; }
    .badge {
      display: inline-block;
      margin-top: 1.75rem;
      padding: .35rem 1rem;
      background: #0f2a1a;
      border: 1px solid #166534;
      border-radius: 20px;
      color: #86efac;
      font-family: ui-monospace, monospace;
      font-size: .8rem;
      letter-spacing: .02em;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="shield">🛡️</div>
    <h1>Authentication successful!</h1>
    <p>Your Enterprise session has been saved.<br>You can close this tab and return to your terminal.</p>
    <div class="badge">mcp-shield enterprise &middot; active</div>
  </div>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openBrowser(url: string): void {
  let cmd: string;
  if (process.platform === 'darwin') {
    cmd = `open ${JSON.stringify(url)}`;
  } else if (process.platform === 'win32') {
    // Escape & for Windows cmd.exe so it doesn't split the URL into two arguments.
    cmd = `cmd.exe /c start "" ${JSON.stringify(url.replace(/&/g, '^&'))}`;
  } else {
    // Linux / WSL: try xdg-open; wslview is preferred in WSL if xdg-open is absent.
    cmd = `xdg-open ${JSON.stringify(url)} 2>/dev/null || wslview ${JSON.stringify(url)}`;
  }
  exec(cmd, (err) => {
    if (err) {
      process.stderr.write(
        `[mcp-shield] Browser could not be opened automatically.\n` +
        `[mcp-shield] Please visit this URL to complete login:\n  ${url}\n`,
      );
    }
  });
}

async function findFreePort(start: number): Promise<number> {
  for (let port = start; port <= start + 20; port++) {
    const available = await new Promise<boolean>((resolve) => {
      const probe = http.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (available) return port;
  }
  return start; // last resort — the server will surface a clear bind error
}

async function saveSession(data: { token: string; email: string }): Promise<void> {
  await fs.mkdir(SESSION_DIR, { recursive: true });
  await fs.writeFile(SESSION_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Returns true when ~/.mcp-shield/session.json exists and contains a valid token. */
export async function hasSession(): Promise<boolean> {
  try {
    const raw = await fs.readFile(SESSION_PATH, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const obj = parsed as Record<string, unknown>;
    const token = obj['token'];
    return typeof token === 'string' && token.length > 0;
  } catch {
    return false;
  }
}

/**
 * Runs the OAuth2 loopback login flow:
 * 1. Spins up a temporary HTTP server on localhost:3009 (or next free port).
 * 2. Opens the Enterprise auth portal in the default browser.
 * 3. Waits for the SSO redirect to deliver the token on /callback.
 * 4. Saves the session to ~/.mcp-shield/session.json and closes the server.
 *
 * Rejects on timeout (5 min), missing token, or session-write failure.
 */
export async function runCliLoginFlow(): Promise<void> {
  const port = await findFreePort(LOOPBACK_START);
  const callbackUrl = `http://localhost:${port}/callback`;
  const loginUrl =
    `${AUTH_URL}?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(callbackUrl)}`;

  process.stderr.write(`[mcp-shield] Starting Enterprise login...\n`);
  process.stderr.write(
    `[mcp-shield] If the browser does not open, visit:\n  ${loginUrl}\n`,
  );

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.closeAllConnections();
      server.close(() =>
        reject(new Error('Login timed out after 5 minutes — no browser response received')),
      );
    }, LOGIN_TIMEOUT_MS);
    // Allow the process to exit if something external kills it before the timeout.
    timeoutHandle.unref();

    const server = http.createServer((req, res) => {
      const reqUrl = req.url ?? '';

      if (!reqUrl.startsWith('/callback')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      const parsedUrl = new URL(reqUrl, `http://localhost:${port}`);
      const token = parsedUrl.searchParams.get('token');
      const email = parsedUrl.searchParams.get('email') ?? '';
      const errorParam = parsedUrl.searchParams.get('error');

      // El servidor devuelve ?error=... cuando el login no puede completarse
      // (p. ej. no existe un developer con ese email). Fallamos al instante con
      // el mensaje en vez de esperar el timeout de 5 minutos.
      if (errorParam) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Login failed: ${errorParam}`);
        if (!settled) {
          settled = true;
          clearTimeout(timeoutHandle);
          server.closeAllConnections();
          server.close(() => reject(new Error(`Login failed: ${errorParam}`)));
        }
        return;
      }

      if (!token) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Authentication error: missing token in callback URL.');
        if (!settled) {
          settled = true;
          clearTimeout(timeoutHandle);
          server.closeAllConnections();
          server.close(() => reject(new Error('SSO callback did not include a token')));
        }
        return;
      }

      // Respond with the success page before closing so the browser renders it.
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        // Tell the browser not to reuse this connection so server.close() drains
        // immediately after closeAllConnections().
        'Connection': 'close',
      });
      res.end(SUCCESS_HTML, () => {
        // Response body flushed to OS socket buffer — now tear down.
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        server.closeAllConnections();
        server.close(() => {
          saveSession({ token, email })
            .then(() => {
              process.stderr.write(
                `[mcp-shield] Logged in${email ? ` as ${email}` : ''}. Session saved.\n`,
              );
              resolve();
            })
            .catch(reject);
        });
      });
    });

    server.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutHandle);
        reject(err);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      openBrowser(loginUrl);
    });
  });
}
