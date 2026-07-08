/**
 * `mcp-shield install` / `mcp-shield uninstall` — zero-friction (un)wrapping
 * of MCP client configs.
 *
 * With an explicit app id (`install cursor`) only that client is touched and
 * any problem is fatal. With no argument the known clients are probed and
 * every config found is processed; per-client problems are reported but do
 * not abort the sweep, so one corrupt config can't block shielding the rest.
 */

import { readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

function fail(message: string): never {
  process.stderr.write(`[mcp-shield] ${message}\n`);
  process.exit(1);
}

/** Green when a human is watching; plain when piped. Awaits the write
 * callback so a process.exit right after cannot truncate the feedback. */
async function writeFinal(message: string): Promise<void> {
  const full = `[mcp-shield] ${message}`;
  const line = process.stderr.isTTY ? `\x1b[32m${full}\x1b[0m\n` : `${full}\n`;
  await new Promise<void>((resolve) => {
    process.stderr.write(line, () => resolve());
  });
}

// ---------------------------------------------------------------------------
// Client registry — adding support for a new MCP client is one entry here
// ---------------------------------------------------------------------------

interface McpClient {
  /** CLI id: `mcp-shield install <id>` */
  id: string;
  name: string;
  /** Top-level key holding the server map: VS Code uses "servers", everyone
   * else uses "mcpServers". */
  serversKey: string;
  /** Excluded from the no-argument sweep: the project-level .mcp.json is a
   * version-controlled, team-shared file — wrapping it (with machine-local
   * absolute paths, no less) must be a deliberate, explicit action, never a
   * side effect of running the sweep from the wrong directory. */
  autoDetect: boolean;
  /** Absolute path of the client's MCP config, or null when the client does
   * not exist on this platform. */
  configPath: () => string | null;
}

function appData(): string {
  return process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');
}

const CLIENTS: McpClient[] = [
  {
    id: 'claude',
    name: 'Claude Desktop',
    serversKey: 'mcpServers',
    autoDetect: true,
    configPath: () => {
      if (process.platform === 'win32') {
        return path.join(appData(), 'Claude', 'claude_desktop_config.json');
      }
      if (process.platform === 'darwin') {
        return path.join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      }
      return null; // No official Linux build of Claude Desktop.
    },
  },
  {
    id: 'cursor',
    name: 'Cursor',
    serversKey: 'mcpServers',
    autoDetect: true,
    // Cursor's native MCP config lives in ~/.cursor on every platform. (The
    // globalStorage/rooveterinaryinc.roo-cline path this used to target
    // belongs to the Roo Code extension, not to Cursor itself.)
    configPath: () => path.join(homedir(), '.cursor', 'mcp.json'),
  },
  {
    id: 'vscode',
    name: 'VS Code',
    serversKey: 'servers',
    autoDetect: true,
    configPath: () => {
      if (process.platform === 'win32') {
        return path.join(appData(), 'Code', 'User', 'mcp.json');
      }
      if (process.platform === 'darwin') {
        return path.join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
      }
      return path.join(homedir(), '.config', 'Code', 'User', 'mcp.json');
    },
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    serversKey: 'mcpServers',
    autoDetect: true,
    configPath: () => path.join(homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
  },
  {
    id: 'claude-code',
    name: 'Claude Code (project .mcp.json)',
    serversKey: 'mcpServers',
    autoDetect: false,
    configPath: () => path.join(process.cwd(), '.mcp.json'),
  },
];

const SUPPORTED_IDS = CLIENTS.map((c) => c.id).join(', ');

// ---------------------------------------------------------------------------
// Shield invocation — how a client can re-launch THIS mcp-shield
// ---------------------------------------------------------------------------

/**
 * Command (+ leading args) that re-invokes the currently running mcp-shield
 * using absolute paths only. A bare "mcp-shield" would be resolved against
 * the CLIENT's PATH at spawn time, which breaks under every mainstream
 * install channel: `npx mcp-shield install` leaves nothing on PATH once it
 * exits, GUI-launched clients on macOS inherit launchd's minimal PATH, and
 * Windows clients can't exec the npm .cmd shim without a shell.
 */
function shieldInvocation(): string[] {
  // pkg standalone binary: the executable itself is the shield.
  if ((process as unknown as { pkg?: unknown }).pkg !== undefined) {
    return [process.execPath];
  }
  // Plain node (npx, npm -g shim, local checkout): the same node binary
  // running the same entry script.
  return [process.execPath, path.resolve(process.argv[1] ?? '')];
}

/**
 * Does this command/arg string invoke mcp-shield? Deliberately exact — a
 * loose substring test would make `uninstall` mangle an unrelated server
 * whose command merely contains "mcp-shield" (e.g. "mcp-shield-audit").
 * Matches: the bare/legacy name, our pkg binary names, and any path that
 * traverses an "mcp-shield" directory (npm package dir, this repo).
 */
const SHIELD_BASENAMES = new Set(['mcp-shield', 'mcp-shield-linux', 'mcp-shield-macos', 'mcp-shield-win']);

function invokesShield(value: unknown): boolean {
  if (typeof value !== 'string' || value === '') {
    return false;
  }
  const segments = value.split(/[\\/]+/);
  const last = segments[segments.length - 1] ?? '';
  const basename = last.toLowerCase().replace(/\.(exe|cmd|ps1)$/, '');
  return SHIELD_BASENAMES.has(basename) || segments.includes('mcp-shield');
}

function isShieldedEntry(serverConfig: Record<string, any>): boolean {
  if (invokesShield(serverConfig.command)) {
    return true;
  }
  // node <abs .../mcp-shield/dist/index.js> -- <original...>
  return Array.isArray(serverConfig.args) && invokesShield(serverConfig.args[0]);
}

// ---------------------------------------------------------------------------
// Core: read config → wrap/unwrap servers → atomic write
// ---------------------------------------------------------------------------

type Mode = 'install' | 'uninstall';

type ClientOutcome =
  | { kind: 'unsupported' }
  | { kind: 'not-found'; configPath: string }
  | { kind: 'error'; configPath: string; reason: string }
  | { kind: 'no-servers'; configPath: string }
  | { kind: 'unchanged'; configPath: string }
  | { kind: 'changed'; configPath: string; count: number };

/** Wraps every wrappable server in place; returns how many changed. */
function wrapServers(servers: Record<string, any>): number {
  const invocation = shieldInvocation();
  let modified = 0;
  for (const serverConfig of Object.values(servers)) {
    if (!serverConfig || typeof serverConfig !== 'object') continue;
    if (isShieldedEntry(serverConfig)) continue;
    // Entries without a string command are remote (http/sse) servers — most
    // common in VS Code's mcp.json — and carry no child process to proxy.
    if (typeof serverConfig.command !== 'string') continue;
    // A present-but-non-array args is malformed; wrapping would silently
    // discard the value with no way for uninstall to restore it. Leave the
    // entry for the user to fix.
    if (serverConfig.args !== undefined && !Array.isArray(serverConfig.args)) continue;

    const originalCommand = serverConfig.command;
    const originalArgs = serverConfig.args ?? [];
    serverConfig.command = invocation[0];
    serverConfig.args = [...invocation.slice(1), '--', originalCommand, ...originalArgs];
    modified += 1;
  }
  return modified;
}

/** Restores every shielded server in place; returns how many changed. */
function unwrapServers(servers: Record<string, any>): number {
  let modified = 0;
  for (const serverConfig of Object.values(servers)) {
    if (!serverConfig || typeof serverConfig !== 'object') continue;
    if (!isShieldedEntry(serverConfig)) continue;

    const args = Array.isArray(serverConfig.args) ? serverConfig.args : [];
    const sepIndex = args.indexOf('--');
    if (sepIndex === -1 || args.length <= sepIndex + 1) continue;

    serverConfig.command = args[sepIndex + 1];
    serverConfig.args = args.slice(sepIndex + 2);
    if (serverConfig.args.length === 0) {
      delete serverConfig.args;
    }
    modified += 1;
  }
  return modified;
}

/** Sibling-temp-file + rename: atomic on POSIX, and realpath first so an
 * intentionally symlinked config keeps pointing at its real target. */
async function writeConfigAtomic(configPath: string, config: Record<string, unknown>): Promise<void> {
  let destPath = configPath;
  try {
    destPath = await realpath(configPath);
  } catch {}

  const tmpPath = `${destPath}.${process.pid}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await rename(tmpPath, destPath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw new Error(`cannot write ${destPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function applyToClient(client: McpClient, mode: Mode): Promise<ClientOutcome> {
  const configPath = client.configPath();
  if (configPath === null) {
    return { kind: 'unsupported' };
  }

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'not-found', configPath };
    }
    return { kind: 'error', configPath, reason: `cannot read ${configPath}: ${err instanceof Error ? err.message : String(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'error', configPath, reason: `${configPath} is not valid JSON. Please fix it manually first.` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'error', configPath, reason: `${configPath} does not contain a JSON object at the top level` };
  }
  const config = parsed as Record<string, unknown>;

  const existingServers = config[client.serversKey];
  if (!existingServers || typeof existingServers !== 'object' || Array.isArray(existingServers)) {
    return { kind: 'no-servers', configPath };
  }

  const servers = existingServers as Record<string, any>;
  const modified = mode === 'install' ? wrapServers(servers) : unwrapServers(servers);
  if (modified === 0) {
    return { kind: 'unchanged', configPath };
  }

  try {
    await writeConfigAtomic(configPath, config);
  } catch (err) {
    return { kind: 'error', configPath, reason: err instanceof Error ? err.message : String(err) };
  }
  return { kind: 'changed', configPath, count: modified };
}

// ---------------------------------------------------------------------------
// Explicit mode — `mcp-shield install <app>`: any problem is fatal
// ---------------------------------------------------------------------------

async function runExplicit(client: McpClient, mode: Mode): Promise<void> {
  const outcome = await applyToClient(client, mode);
  switch (outcome.kind) {
    case 'unsupported':
      fail(`${client.name} is currently only supported on Windows and macOS.`);
    case 'not-found':
      fail(mode === 'install'
        ? `Could not find config file at ${outcome.configPath}. Please ensure ${client.id} is installed and has been run at least once.`
        : `Could not find config file at ${outcome.configPath}.`);
    case 'error':
      fail(outcome.reason);
    case 'no-servers':
      fail(mode === 'install'
        ? `No "${client.serversKey}" found in ${outcome.configPath} to protect. Add some servers first!`
        : `No "${client.serversKey}" found in ${outcome.configPath}.`);
    case 'unchanged':
      process.stderr.write(mode === 'install'
        ? `[mcp-shield] All servers in ${client.id} are already protected!\n`
        : `[mcp-shield] No servers were protected by mcp-shield in ${client.id}.\n`);
      return;
    case 'changed':
      await writeFinal(mode === 'install'
        ? `Successfully shielded ${outcome.count} server(s) in ${client.id}. Please restart ${client.id} to apply changes.`
        : `Successfully UNINSTALLED from ${outcome.count} server(s) in ${client.id}.`);
      return;
  }
}

// ---------------------------------------------------------------------------
// Auto-detect mode — `mcp-shield install`: probe every client, keep going
// ---------------------------------------------------------------------------

async function runAutoDetect(mode: Mode): Promise<void> {
  let totalChanged = 0;
  let clientsChanged = 0;
  let detectedOk = 0;
  let errors = 0;

  for (const client of CLIENTS) {
    if (!client.autoDetect) {
      process.stderr.write(`[mcp-shield]   - ${client.name}: skipped in auto mode — run "mcp-shield ${mode} ${client.id}" inside a project to opt in\n`);
      continue;
    }
    const outcome = await applyToClient(client, mode);
    switch (outcome.kind) {
      case 'unsupported':
      case 'not-found':
        process.stderr.write(`[mcp-shield]   - ${client.name}: not detected\n`);
        break;
      case 'error':
        errors += 1;
        process.stderr.write(`[mcp-shield]   ! ${client.name}: ${outcome.reason}\n`);
        break;
      case 'no-servers':
        detectedOk += 1;
        process.stderr.write(`[mcp-shield]   ✓ Detected ${client.name} — no MCP servers configured, nothing to ${mode === 'install' ? 'shield' : 'restore'}\n`);
        break;
      case 'unchanged':
        detectedOk += 1;
        process.stderr.write(mode === 'install'
          ? `[mcp-shield]   ✓ Detected ${client.name} — all servers already protected\n`
          : `[mcp-shield]   ✓ Detected ${client.name} — no shielded servers to restore\n`);
        break;
      case 'changed':
        detectedOk += 1;
        clientsChanged += 1;
        totalChanged += outcome.count;
        process.stderr.write(mode === 'install'
          ? `[mcp-shield]   ✓ Detected ${client.name} — shielded ${outcome.count} server(s)\n`
          : `[mcp-shield]   ✓ Detected ${client.name} — restored ${outcome.count} server(s)\n`);
        break;
    }
  }

  if (detectedOk === 0 && errors === 0) {
    fail(`No supported MCP clients found on this machine. Supported: ${SUPPORTED_IDS}. You can also target one explicitly: mcp-shield ${mode} <app>.`);
  }
  if (detectedOk === 0) {
    // Every config we found was unusable — that is a failure, not a sweep.
    fail(`No client config could be ${mode === 'install' ? 'shielded' : 'restored'} (${errors} error(s) above).`);
  }
  if (errors > 0) {
    // Partial success must not look like success: a scripted caller
    // (`mcp-shield install && ...`) would otherwise believe the whole
    // machine is protected when a detected client was left unshielded.
    fail(`${mode === 'install' ? 'Shielded' : 'Restored'} ${totalChanged} server(s) across ${clientsChanged} client(s), but ${errors} client config(s) had errors (see above) and were left untouched.`);
  }

  if (totalChanged > 0) {
    await writeFinal(mode === 'install'
      ? `Proxy injected into ${totalChanged} server(s) across ${clientsChanged} client(s). Zero-trust policies active — restart the affected apps to apply changes.`
      : `Restored ${totalChanged} server(s) across ${clientsChanged} client(s). Restart the affected apps to apply changes.`);
  } else {
    await writeFinal(mode === 'install'
      ? 'Nothing new to shield — every detected client is already protected.'
      : 'Nothing to restore — no shielded servers found in the detected clients.');
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function resolveClient(targetApp: string): McpClient {
  const client = CLIENTS.find((c) => c.id === targetApp);
  if (client === undefined) {
    fail(`unknown app "${targetApp}". Supported: ${SUPPORTED_IDS} — or run with no argument to auto-detect all of them.`);
  }
  return client;
}

export async function runInstallCommand(targetApp?: string): Promise<void> {
  if (targetApp === undefined || targetApp === '') {
    await runAutoDetect('install');
    return;
  }
  await runExplicit(resolveClient(targetApp), 'install');
}

export async function runUninstallCommand(targetApp?: string): Promise<void> {
  if (targetApp === undefined || targetApp === '') {
    await runAutoDetect('uninstall');
    return;
  }
  await runExplicit(resolveClient(targetApp), 'uninstall');
}
