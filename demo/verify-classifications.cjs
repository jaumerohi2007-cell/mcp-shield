// Headless pre-flight for the demo video: drives the SAME calls populate-dashboard.cjs
// sends, but classifies each by its JSON-RPC response instead of needing a browser.
//   allowed  -> demo server result comes back
//   blocked  -> JSON-RPC "Access Denied" error comes back
//   ask      -> no response within the window (parked awaiting dashboard approval)
// Exits non-zero if the observed classification != the script's expectation.
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const PORT = 3021;
const shieldIndex = path.join(__dirname, '..', 'dist', 'index.js');
const demoServer = path.join(__dirname, 'mcp-demo-server.cjs');

// id -> { command, expect }
const CALLS = [
  { id: 10, command: 'ls -la',                       expect: 'allowed' },
  { id: 11, command: 'git status',                   expect: 'allowed' },
  { id: 12, command: 'cat package.json',             expect: 'allowed' },
  { id: 13, command: 'rm -rf /tmp/old-cache',        expect: 'blocked' },
  { id: 14, command: 'dd if=/dev/zero of=/dev/sda',  expect: 'blocked' },
  { id: 15, command: 'curl https://example.com',     expect: 'ask'     },
];

const shield = spawn(process.execPath, [shieldIndex, '--port', String(PORT), '--', 'node', demoServer], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

const observed = new Map(); // id -> 'allowed' | 'blocked'
let stdoutBuf = '';
shield.stdout.on('data', (d) => {
  stdoutBuf += d.toString();
  let nl;
  while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (typeof msg.id !== 'number' || msg.id < 10) continue;
    if (msg.error) observed.set(msg.id, { verdict: 'blocked', detail: msg.error.message });
    else if (msg.result) observed.set(msg.id, { verdict: 'allowed', detail: '' });
  }
});
let stderr = '';
shield.stderr.on('data', (d) => { stderr += d.toString(); });
shield.on('error', (e) => { console.error('spawn error:', e.message); process.exit(2); });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const ping = () => new Promise((resolve) => {
  const req = http.get({ host: 'localhost', port: PORT, path: '/' }, (res) => { res.resume(); resolve(res.statusCode === 200); });
  req.on('error', () => resolve(false));
  req.setTimeout(800, () => { req.destroy(); resolve(false); });
});
const send = (o) => shield.stdin.write(`${JSON.stringify(o)}\n`);

(async () => {
  let up = false;
  for (let i = 0; i < 40; i += 1) { if (await ping()) { up = true; break; } await delay(500); }
  if (!up) { console.error('❌ dashboard never came up on :' + PORT); shield.kill(); process.exit(2); }
  console.log(`✅ dashboard up on http://localhost:${PORT}\n`);

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'preflight' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await delay(400);

  for (const c of CALLS) {
    send({ jsonrpc: '2.0', id: c.id, method: 'tools/call', params: { name: 'run_command', arguments: { command: c.command } } });
    await delay(500);
  }
  await delay(1500); // give blocks/allows time; ask should remain unanswered

  let ok = true;
  console.log('  id  cmd                                 expect   observed  result');
  console.log('  ──  ──────────────────────────────────  ───────  ────────  ──────');
  for (const c of CALLS) {
    const got = observed.get(c.id);
    const verdict = got ? got.verdict : 'ask'; // no response => parked (ask)
    const pass = verdict === c.expect;
    if (!pass) ok = false;
    console.log(`  ${String(c.id).padEnd(3)} ${c.command.padEnd(35)} ${c.expect.padEnd(8)} ${verdict.padEnd(9)} ${pass ? 'PASS' : 'FAIL'}`);
  }
  console.log('');
  // Cross-check the log lines the dashboard feed is derived from.
  const nAllow = (stderr.match(/ALLOWED tools\/call/g) || []).length;
  const nBlock = (stderr.match(/BLOCKED tools\/call/g) || []).length;
  const nAsk = (stderr.match(/awaiting dashboard approval/g) || []).length;
  console.log(`  log lines → ALLOWED:${nAllow}  BLOCKED:${nBlock}  ASK:${nAsk}  (expect 3 / 2 / 1)`);
  const logsOk = nAllow === 3 && nBlock === 2 && nAsk === 1;
  if (!logsOk) ok = false;

  shield.kill();
  console.log(ok ? '\n✅ ALL GOOD — el guion clasifica como esperado.' : '\n❌ MISMATCH — revisar reglas antes de grabar.');
  process.exit(ok ? 0 : 1);
})();
