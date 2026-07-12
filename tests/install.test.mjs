// Tests for `mcp-shield install` / `uninstall`: explicit per-client mode,
// no-argument auto-detection across the client table, the servers/mcpServers
// key mapping, wrap/unwrap safety, and error paths. Runs against the
// compiled output:
//
//   npm test   (= npm run build && node --test tests/*.test.mjs)
//
// Every run points HOME *and* USERPROFILE at a fresh temp dir so no real
// client config is ever touched: os.homedir() honors $HOME on POSIX but
// $USERPROFILE on Windows. Client config paths are derived from that fake
// home, so the whole suite is platform-independent except where noted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(projectRoot, 'dist', 'index.js');

// Wrapped entries carry the ABSOLUTE invocation of the running shield (never
// a bare "mcp-shield", which clients could not resolve after an `npx` run):
// the node binary that spawned the CLI plus its entry script.
const wrapped = (command, args = []) => ({
  command: process.execPath,
  args: [entry, '--', command, ...args],
});

const freshDir = () => mkdtemp(path.join(tmpdir(), 'shield-install-'));

// Config path helpers relative to a fake home — mirrors src/install.ts. On
// win32 APPDATA is also forced under the fake home so claude/vscode resolve
// inside the sandbox there too.
const cursorConfig = (home) => path.join(home, '.cursor', 'mcp.json');
const windsurfConfig = (home) => path.join(home, '.codeium', 'windsurf', 'mcp_config.json');
const vscodeConfig = (home) => {
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'mcp.json');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  return path.join(home, '.config', 'Code', 'User', 'mcp.json');
};
const claudeConfig = (home) => {
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return null; // unsupported on linux — see dedicated test
};

async function writeConfig(configPath, config) {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2));
}

async function run(args, { home, cwd = home }) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  if (process.platform === 'win32') {
    env.APPDATA = path.join(home, 'AppData', 'Roaming');
  }
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Explicit mode
// ---------------------------------------------------------------------------

test('install cursor wraps servers in ~/.cursor/mcp.json with an absolute invocation and preserves unrelated keys', async () => {
  const home = await freshDir();
  await writeConfig(cursorConfig(home), {
    theme: 'dark',
    mcpServers: {
      fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
      bare: { command: 'my-server' },
    },
  });

  const { code, stdout, stderr } = await run(['install', 'cursor'], { home });
  assert.equal(code, 0, `stderr was: ${stderr}`);
  // stdout belongs to the MCP protocol — install must not write anything there.
  assert.equal(stdout, '');
  assert.match(stderr, /Successfully shielded 2 server\(s\) in cursor/);

  const config = JSON.parse(await readFile(cursorConfig(home), 'utf8'));
  assert.equal(config.theme, 'dark');
  assert.deepEqual(config.mcpServers.fs, wrapped('npx', ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']));
  assert.deepEqual(config.mcpServers.bare, wrapped('my-server'));
});

test('install claude wraps claude_desktop_config.json on win/mac and refuses on linux', async () => {
  const home = await freshDir();
  const configPath = claudeConfig(home);

  if (configPath === null) {
    const { code, stderr } = await run(['install', 'claude'], { home });
    assert.notEqual(code, 0);
    assert.match(stderr, /Claude Desktop is currently only supported on Windows and macOS/);
    return;
  }

  await writeConfig(configPath, {
    mcpServers: { fs: { command: 'npx', args: ['x'] } },
  });
  const { code, stderr } = await run(['install', 'claude'], { home });
  assert.equal(code, 0, `stderr was: ${stderr}`);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(config.mcpServers.fs, wrapped('npx', ['x']));
});

test('install is idempotent: a second run changes nothing', async () => {
  const home = await freshDir();
  await writeConfig(cursorConfig(home), {
    mcpServers: { fs: { command: 'npx', args: ['x'] } },
  });

  await run(['install', 'cursor'], { home });
  const afterFirst = await readFile(cursorConfig(home), 'utf8');

  const { code, stderr } = await run(['install', 'cursor'], { home });
  assert.equal(code, 0);
  assert.match(stderr, /already protected/);
  assert.equal(await readFile(cursorConfig(home), 'utf8'), afterFirst);
});

test('install vscode uses the "servers" key and leaves url-based entries untouched', async () => {
  const home = await freshDir();
  await writeConfig(vscodeConfig(home), {
    inputs: [{ id: 'token', type: 'promptString' }],
    servers: {
      local: { type: 'stdio', command: 'node', args: ['srv.js'] },
      remote: { type: 'http', url: 'https://example.com/mcp' },
    },
  });

  const { code, stderr } = await run(['install', 'vscode'], { home });
  assert.equal(code, 0, `stderr was: ${stderr}`);
  assert.match(stderr, /Successfully shielded 1 server\(s\) in vscode/);

  const config = JSON.parse(await readFile(vscodeConfig(home), 'utf8'));
  assert.deepEqual(config.inputs, [{ id: 'token', type: 'promptString' }], 'inputs must be preserved');
  assert.deepEqual(config.servers.local, { type: 'stdio', ...wrapped('node', ['srv.js']) });
  assert.deepEqual(config.servers.remote, { type: 'http', url: 'https://example.com/mcp' }, 'url entries have no process to wrap');
});

test('install claude-code wraps the project .mcp.json in the working directory', async () => {
  const home = await freshDir();
  const cwd = await freshDir();
  await writeConfig(path.join(cwd, '.mcp.json'), {
    mcpServers: { db: { command: 'python', args: ['db.py'] } },
  });

  const { code } = await run(['install', 'claude-code'], { home, cwd });
  assert.equal(code, 0);

  const config = JSON.parse(await readFile(path.join(cwd, '.mcp.json'), 'utf8'));
  assert.deepEqual(config.mcpServers.db, wrapped('python', ['db.py']));
});

test('install skips a malformed entry whose args is not an array instead of destroying it', async () => {
  const home = await freshDir();
  await writeConfig(cursorConfig(home), {
    mcpServers: {
      broken: { command: 'node', args: 'srv.js --flag' },
      good: { command: 'npx', args: ['x'] },
    },
  });

  const { code, stderr } = await run(['install', 'cursor'], { home });
  assert.equal(code, 0, `stderr was: ${stderr}`);
  assert.match(stderr, /Successfully shielded 1 server\(s\) in cursor/);

  const config = JSON.parse(await readFile(cursorConfig(home), 'utf8'));
  assert.deepEqual(config.mcpServers.broken, { command: 'node', args: 'srv.js --flag' }, 'malformed entry must stay untouched');
  assert.deepEqual(config.mcpServers.good, wrapped('npx', ['x']));
});

test('install with an unknown app lists the supported clients and fails', async () => {
  const home = await freshDir();
  const { code, stderr } = await run(['install', 'emacs'], { home });
  assert.notEqual(code, 0);
  assert.match(stderr, /unknown app "emacs"/);
  assert.match(stderr, /claude, cursor, vscode, windsurf, claude-code/);
});

test('install cursor fails cleanly when the config file does not exist', async () => {
  const home = await freshDir();
  const { code, stderr } = await run(['install', 'cursor'], { home });
  assert.notEqual(code, 0);
  assert.match(stderr, /Could not find config file at .*mcp\.json/);
});

test('install fails on a config without an mcpServers map', async () => {
  const home = await freshDir();
  await writeConfig(cursorConfig(home), { theme: 'dark' });

  const { code, stderr } = await run(['install', 'cursor'], { home });
  assert.notEqual(code, 0);
  assert.match(stderr, /No "mcpServers" found in .* to protect\. Add some servers first!/);
});

test('install refuses to clobber a corrupt config file', async () => {
  const home = await freshDir();
  await mkdir(path.dirname(cursorConfig(home)), { recursive: true });
  await writeFile(cursorConfig(home), '{ this is not json');

  const { code, stderr } = await run(['install', 'cursor'], { home });
  assert.notEqual(code, 0);
  assert.match(stderr, /not valid JSON/);
  assert.equal(await readFile(cursorConfig(home), 'utf8'), '{ this is not json', 'corrupt file must stay untouched');
});

test('install follows an intentionally symlinked config instead of replacing the link', { skip: process.platform === 'win32' }, async () => {
  const home = await freshDir();
  const dotfiles = await freshDir();
  const realConfig = path.join(dotfiles, 'cursor-mcp.json');
  await writeFile(realConfig, JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['x'] } } }));
  await mkdir(path.dirname(cursorConfig(home)), { recursive: true });
  await symlink(realConfig, cursorConfig(home));

  const { code } = await run(['install', 'cursor'], { home });
  assert.equal(code, 0);

  const linkStat = await lstat(cursorConfig(home));
  assert.equal(linkStat.isSymbolicLink(), true, 'the atomic-write rename must not replace the symlink');
  const config = JSON.parse(await readFile(realConfig, 'utf8'));
  assert.deepEqual(config.mcpServers.fs, wrapped('npx', ['x']));
});

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

test('uninstall restores the exact pre-install config (round trip)', async () => {
  const home = await freshDir();
  const original = {
    theme: 'dark',
    mcpServers: {
      fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
      bare: { command: 'my-server' },
    },
  };
  await writeConfig(cursorConfig(home), original);

  await run(['install', 'cursor'], { home });
  const { code, stderr } = await run(['uninstall', 'cursor'], { home });
  assert.equal(code, 0, `stderr was: ${stderr}`);
  assert.match(stderr, /Successfully UNINSTALLED from 2 server\(s\) in cursor/);

  const config = JSON.parse(await readFile(cursorConfig(home), 'utf8'));
  assert.deepEqual(config, original);
});

test('uninstall restores entries wrapped by older releases as bare "mcp-shield"', async () => {
  const home = await freshDir();
  await writeConfig(cursorConfig(home), {
    mcpServers: {
      fs: { command: 'mcp-shield', args: ['--', 'npx', '-y', '@foo/server'] },
    },
  });

  const { code, stderr } = await run(['uninstall', 'cursor'], { home });
  assert.equal(code, 0, `stderr was: ${stderr}`);

  const config = JSON.parse(await readFile(cursorConfig(home), 'utf8'));
  assert.deepEqual(config.mcpServers.fs, { command: 'npx', args: ['-y', '@foo/server'] });
});

test('uninstall never touches an unrelated server whose command merely contains "mcp-shield"', async () => {
  const home = await freshDir();
  const original = {
    mcpServers: {
      audit: { command: 'mcp-shield-audit', args: ['run', '--', 'prod'] },
    },
  };
  await writeConfig(cursorConfig(home), original);

  const { code, stderr } = await run(['uninstall', 'cursor'], { home });
  assert.equal(code, 0);
  assert.match(stderr, /No servers were protected by mcp-shield in cursor/);
  assert.deepEqual(JSON.parse(await readFile(cursorConfig(home), 'utf8')), original);
});

test('uninstall on an unshielded config reports nothing to do and exits 0', async () => {
  const home = await freshDir();
  await writeConfig(cursorConfig(home), {
    mcpServers: { fs: { command: 'npx', args: ['x'] } },
  });

  const { code, stderr } = await run(['uninstall', 'cursor'], { home });
  assert.equal(code, 0);
  assert.match(stderr, /No servers were protected by mcp-shield in cursor/);
});

// ---------------------------------------------------------------------------
// Auto-detect mode (no app argument)
// ---------------------------------------------------------------------------

test('install with no argument shields every detected client and reports the rest', async () => {
  const home = await freshDir();
  const cwd = await freshDir();
  await writeConfig(cursorConfig(home), {
    mcpServers: { fs: { command: 'npx', args: ['x'] } },
  });
  await writeConfig(windsurfConfig(home), {
    mcpServers: { web: { command: 'node', args: ['web.js'] } },
  });

  const { code, stdout, stderr } = await run(['install'], { home, cwd });
  assert.equal(code, 0, `stderr was: ${stderr}`);
  assert.equal(stdout, '');
  assert.match(stderr, /✓ Detected Cursor — shielded 1 server\(s\)/);
  assert.match(stderr, /✓ Detected Windsurf — shielded 1 server\(s\)/);
  assert.match(stderr, /- VS Code: not detected/);
  assert.match(stderr, /Proxy injected into 2 server\(s\) across 2 client\(s\)/);

  const cursor = JSON.parse(await readFile(cursorConfig(home), 'utf8'));
  assert.deepEqual(cursor.mcpServers.fs, wrapped('npx', ['x']));
  const windsurf = JSON.parse(await readFile(windsurfConfig(home), 'utf8'));
  assert.deepEqual(windsurf.mcpServers.web, wrapped('node', ['web.js']));
});

test('the sweep never touches a project .mcp.json — claude-code is explicit opt-in only', async () => {
  const home = await freshDir();
  const cwd = await freshDir();
  const original = { mcpServers: { db: { command: 'python', args: ['db.py'] } } };
  await writeConfig(path.join(cwd, '.mcp.json'), original);
  await writeConfig(cursorConfig(home), {
    mcpServers: { fs: { command: 'npx', args: ['x'] } },
  });

  const { code, stderr } = await run(['install'], { home, cwd });
  assert.equal(code, 0, `stderr was: ${stderr}`);
  assert.match(stderr, /- Claude Code \(project \.mcp\.json\): skipped in auto mode — run "mcp-shield install claude-code" inside a project to opt in/);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(cwd, '.mcp.json'), 'utf8')),
    original,
    'the team-shared project file must never be rewritten by the unattended sweep',
  );
});

test('auto-detect with no clients at all fails with a helpful message', async () => {
  const home = await freshDir();
  const cwd = await freshDir();
  const { code, stderr } = await run(['install'], { home, cwd });
  assert.notEqual(code, 0);
  assert.match(stderr, /No supported MCP clients found/);
  assert.match(stderr, /claude, cursor, vscode, windsurf, claude-code/);
});

test('auto-detect still shields healthy clients past a corrupt config, but exits non-zero', async () => {
  const home = await freshDir();
  const cwd = await freshDir();
  await mkdir(path.dirname(cursorConfig(home)), { recursive: true });
  await writeFile(cursorConfig(home), '{ broken');
  await writeConfig(windsurfConfig(home), {
    mcpServers: { web: { command: 'node', args: ['web.js'] } },
  });

  const { code, stderr } = await run(['install'], { home, cwd });
  assert.notEqual(code, 0, 'a partial sweep must not report success to scripted callers');
  assert.match(stderr, /! Cursor: .*not valid JSON/);
  assert.match(stderr, /✓ Detected Windsurf — shielded 1 server\(s\)/);
  assert.match(stderr, /Shielded 1 server\(s\) across 1 client\(s\), but 1 client config\(s\) had errors/);
  assert.equal(await readFile(cursorConfig(home), 'utf8'), '{ broken', 'corrupt file must stay untouched');
  const windsurf = JSON.parse(await readFile(windsurfConfig(home), 'utf8'));
  assert.deepEqual(windsurf.mcpServers.web, wrapped('node', ['web.js']), 'the healthy client must be shielded on disk despite the earlier error');
});

test('auto-detect fails when every detected config is unusable', async () => {
  const home = await freshDir();
  const cwd = await freshDir();
  await mkdir(path.dirname(cursorConfig(home)), { recursive: true });
  await writeFile(cursorConfig(home), '{ broken');

  const { code, stderr } = await run(['install'], { home, cwd });
  assert.notEqual(code, 0);
  assert.match(stderr, /No client config could be shielded/);
});

test('auto-detect reports a detected client with an empty config as having nothing to shield', async () => {
  const home = await freshDir();
  const cwd = await freshDir();
  await writeConfig(cursorConfig(home), {});

  const { code, stderr } = await run(['install'], { home, cwd });
  assert.equal(code, 0, `stderr was: ${stderr}`);
  assert.match(stderr, /✓ Detected Cursor — no MCP servers configured, nothing to shield/);
  assert.match(stderr, /Nothing new to shield/);
});

test('uninstall with no argument restores every detected client', async () => {
  const home = await freshDir();
  const cwd = await freshDir();
  const original = { mcpServers: { fs: { command: 'npx', args: ['x'] } } };
  await writeConfig(cursorConfig(home), original);
  await writeConfig(windsurfConfig(home), original);
  await run(['install'], { home, cwd });

  const { code, stderr } = await run(['uninstall'], { home, cwd });
  assert.equal(code, 0, `stderr was: ${stderr}`);
  assert.match(stderr, /✓ Detected Cursor — restored 1 server\(s\)/);
  assert.match(stderr, /✓ Detected Windsurf — restored 1 server\(s\)/);

  assert.deepEqual(JSON.parse(await readFile(cursorConfig(home), 'utf8')), original);
  assert.deepEqual(JSON.parse(await readFile(windsurfConfig(home), 'utf8')), original);
});

// ---------------------------------------------------------------------------
// Regression: the PUBLISHED npm package installs under `@jrooig/mcpshield`
// (no hyphen), but the whole test suite runs `dist/index.js` from a checkout
// dir named `mcp-shield` (hyphen). A detector keyed only on the hyphenated
// name recognizes wrapped entries in-repo yet silently fails on real npm
// installs: `install` re-wraps (double proxy) and `uninstall` restores
// nothing. These tests pin detection of a wrapped entry regardless of which
// package-dir spelling produced it, so they'd catch that path dependence
// even though the running entry itself lives under the hyphenated dir.
// A realistic npm-style wrap: node <abs .../@jrooig/mcpshield/dist/index.js> -- <orig>
const npmWrapped = (command, args = []) => ({
  command: process.execPath,
  args: [
    path.join(tmpdir(), 'g', 'lib', 'node_modules', '@jrooig', 'mcpshield', 'dist', 'index.js'),
    '--',
    command,
    ...args,
  ],
});

test('install treats an npm-installed (@jrooig/mcpshield, no hyphen) wrap as already protected', async () => {
  const home = await freshDir();
  await writeConfig(cursorConfig(home), {
    mcpServers: { fs: npmWrapped('npx', ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']) },
  });

  const { code, stderr } = await run(['install', 'cursor'], { home });
  assert.equal(code, 0, `stderr was: ${stderr}`);
  assert.match(stderr, /already protected/);
  // Must NOT double-wrap: the entry is left exactly as it was.
  assert.deepEqual(
    JSON.parse(await readFile(cursorConfig(home), 'utf8')).mcpServers.fs,
    npmWrapped('npx', ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']),
  );
});

test('uninstall unwraps an npm-installed (@jrooig/mcpshield, no hyphen) wrap back to the original', async () => {
  const home = await freshDir();
  await writeConfig(cursorConfig(home), {
    mcpServers: { fs: npmWrapped('npx', ['x']) },
  });

  const { code, stderr } = await run(['uninstall', 'cursor'], { home });
  assert.equal(code, 0, `stderr was: ${stderr}`);
  assert.match(stderr, /UNINSTALLED from 1 server\(s\)/);
  assert.deepEqual(
    JSON.parse(await readFile(cursorConfig(home), 'utf8')).mcpServers.fs,
    { command: 'npx', args: ['x'] },
  );
});
