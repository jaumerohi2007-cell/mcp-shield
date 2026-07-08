// Tests for `mcp-shield register`: global (~/.claude.json) and local
// (./.mcp.json) registration, preservation of unrelated config, and usage /
// corruption error paths. Runs against the compiled output:
//
//   npm test   (= npm run build && node --test tests/*.test.mjs)
//
// Every run points HOME *and* USERPROFILE at a fresh temp dir so the real
// ~/.claude.json is never touched: os.homedir() honors $HOME on POSIX but
// $USERPROFILE on Windows, and overriding only HOME would silently leave the
// Windows suite writing into the developer's real profile.
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

// register writes the ABSOLUTE invocation of the running shield (never a
// bare "mcp-shield" the client couldn't resolve): node binary + entry script.
const shieldEntry = (...target) => ({
  command: process.execPath,
  args: [entry, '--', ...target],
});

const freshDir = () => mkdtemp(path.join(tmpdir(), 'shield-register-'));

async function runRegister(args, { home, cwd = home }) {
  const child = spawn(process.execPath, [entry, 'register', ...args], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home },
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

test('register (global) creates ~/.claude.json with the shield entry', async () => {
  const home = await freshDir();
  const { code, stdout, stderr } = await runRegister(
    ['--', 'npx', '-y', '@foo/server', '--flag'],
    { home },
  );

  assert.equal(code, 0);
  // stdout belongs to the MCP protocol — register must not write anything there.
  assert.equal(stdout, '');
  assert.match(stderr, /Successfully registered "shield" server in .*\.claude\.json/);
  assert.match(stderr, /restart Claude Code/);

  const rawConfig = await readFile(path.join(home, '.claude.json'), 'utf8');
  assert.match(rawConfig, /^\{\n  "/, 'expected 2-space indentation');
  const config = JSON.parse(rawConfig);
  assert.deepEqual(config.mcpServers.shield, shieldEntry('npx', '-y', '@foo/server', '--flag'));
});

test('register (global) preserves unrelated config and overwrites a stale shield entry', async () => {
  const home = await freshDir();
  const configPath = path.join(home, '.claude.json');
  await writeFile(configPath, JSON.stringify({
    theme: 'dark',
    mcpServers: {
      other: { command: 'other-server', args: ['-x'] },
      shield: { command: 'stale', args: ['old'] },
    },
  }));

  const { code } = await runRegister(['--', 'python', 'server.py'], { home });
  assert.equal(code, 0);

  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(config.theme, 'dark');
  assert.deepEqual(config.mcpServers.other, { command: 'other-server', args: ['-x'] });
  assert.deepEqual(config.mcpServers.shield, shieldEntry('python', 'server.py'));
});

test('register --local writes .mcp.json in the working directory, not the home config', async () => {
  const home = await freshDir();
  const cwd = await freshDir();

  const { code, stderr } = await runRegister(['--local', '--', 'node', 'srv.js'], { home, cwd });
  assert.equal(code, 0);
  assert.match(stderr, /Successfully registered "shield" server in .*\.mcp\.json/);

  const config = JSON.parse(await readFile(path.join(cwd, '.mcp.json'), 'utf8'));
  assert.deepEqual(config.mcpServers.shield, shieldEntry('node', 'srv.js'));
  await assert.rejects(readFile(path.join(home, '.claude.json')), 'home config must stay untouched');
});

test('register --project is an alias for --local', async () => {
  const home = await freshDir();
  const cwd = await freshDir();

  const { code } = await runRegister(['--project', '--', 'deno', 'run', 'srv.ts'], { home, cwd });
  assert.equal(code, 0);

  const config = JSON.parse(await readFile(path.join(cwd, '.mcp.json'), 'utf8'));
  assert.deepEqual(config.mcpServers.shield, shieldEntry('deno', 'run', 'srv.ts'));
});

test('register without a target command prints usage and exits non-zero', async () => {
  const home = await freshDir();
  for (const args of [[], ['--'], ['--local']]) {
    const { code, stderr } = await runRegister(args, { home });
    assert.notEqual(code, 0, `args ${JSON.stringify(args)} should fail`);
    assert.match(stderr, /usage: mcp-shield register \[--local\] -- <target-command> \[target-args\.\.\.\]/);
  }
  await assert.rejects(readFile(path.join(home, '.claude.json')), 'no config may be written on usage errors');
});

test('register rejects unknown options before "--"', async () => {
  const home = await freshDir();
  const { code, stderr } = await runRegister(['--bogus', '--', 'npx', 'x'], { home });
  assert.notEqual(code, 0);
  assert.match(stderr, /unknown option: --bogus/);
  assert.match(stderr, /usage: mcp-shield register/);
});

test('register refuses to clobber a corrupt config file', async () => {
  const home = await freshDir();
  const configPath = path.join(home, '.claude.json');
  await writeFile(configPath, '{ this is not json');

  const { code, stderr } = await runRegister(['--', 'npx', 'x'], { home });
  assert.notEqual(code, 0);
  assert.match(stderr, /not valid JSON/);
  assert.equal(await readFile(configPath, 'utf8'), '{ this is not json', 'corrupt file must stay untouched');
});

test('register still works when the rules cache is poisoned with an uncompilable regex', async () => {
  // Regression guard for command-dispatch ordering: Firewall.create() throws
  // on this cache, so register must run before any proxy subsystem initializes.
  const home = await freshDir();
  await mkdir(path.join(home, '.mcp-shield'), { recursive: true });
  await writeFile(path.join(home, '.mcp-shield', 'rules.cache.json'), JSON.stringify({
    rules: [{
      id: 'r1', name: 'bad', tool: '*', action: 'block',
      condition: { field: 'arguments.command', operator: 'regex', value: '(' },
    }],
  }));

  const { code, stderr } = await runRegister(['--', 'npx', 'x'], { home });
  assert.equal(code, 0, `stderr was: ${stderr}`);
  assert.match(stderr, /Successfully registered/);

  const config = JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8'));
  assert.deepEqual(config.mcpServers.shield, shieldEntry('npx', 'x'));
});

test('register follows an intentionally symlinked config instead of replacing the link', async () => {
  const home = await freshDir();
  const shared = await freshDir();
  const realConfig = path.join(shared, 'claude-shared.json');
  await writeFile(realConfig, JSON.stringify({ theme: 'dark', mcpServers: {} }));
  await symlink(realConfig, path.join(home, '.claude.json'));

  const { code } = await runRegister(['--', 'npx', 'x'], { home });
  assert.equal(code, 0);

  const linkStat = await lstat(path.join(home, '.claude.json'));
  assert.equal(linkStat.isSymbolicLink(), true, 'the atomic-write rename must not replace the symlink');
  const config = JSON.parse(await readFile(realConfig, 'utf8'));
  assert.equal(config.theme, 'dark');
  assert.deepEqual(config.mcpServers.shield, shieldEntry('npx', 'x'));
});

test('register repairs a non-object mcpServers value instead of crashing', async () => {
  const home = await freshDir();
  const configPath = path.join(home, '.claude.json');
  await writeFile(configPath, JSON.stringify({ theme: 'dark', mcpServers: 'oops' }));

  const { code } = await runRegister(['--', 'npx', 'x'], { home });
  assert.equal(code, 0);

  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(config.theme, 'dark');
  assert.deepEqual(config.mcpServers.shield, shieldEntry('npx', 'x'));
});
