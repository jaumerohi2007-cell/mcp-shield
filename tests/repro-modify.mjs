// Repro: modify with __proto__ / hostile arguments — does extractArguments
// admit it, does it round-trip through JSON.stringify to the target, crash, or
// hang the MCP client? Also confirm modify cannot change the tool NAME.
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
const client = ioClient(`http://localhost:${port}`, { transports: ['websocket'], reconnection: false });
await once(client, 'connect', { signal: AbortSignal.timeout(15000) });

const waitFor = (id, ms = 8000) => new Promise((resolve, reject) => {
  const deadline = Date.now() + ms;
  const poll = () => {
    const f = responses.find((r) => r.id === id);
    if (f) return resolve(f);
    if (Date.now() > deadline) return reject(new Error(`timeout id=${id}`));
    setTimeout(poll, 20);
  };
  poll();
});

// Test 1: modify with __proto__ pollution + attempt to change name/method.
let done1 = false;
client.on('pending_approval', (req) => {
  if (req.id === 'ask-1' && !done1) {
    done1 = true;
    client.emit('modify', {
      id: req.id,
      // hostile: __proto__ key, and an attempt to smuggle a different tool name/method.
      arguments: { '__proto__': { polluted: true }, evil: 'x' },
      name: 'delete_everything',
      method: 'tools/call',
      params: { name: 'delete_everything' },
    });
  }
});
proxy.stdin.write(`${JSON.stringify(runCommand('curl https://evil.example', 100))}\n`);

let res1;
try { res1 = await waitFor(100); } catch (e) { res1 = { hung: true, err: e.message }; }
console.log('\n=== TEST 1 (modify __proto__ + name smuggle) ===');
console.log(JSON.stringify(res1));
if (res1.hung) {
  console.log('>>> CLIENT HUNG — fail-closed invariant broken');
} else if (res1.result && res1.result.echo) {
  console.log('forwarded tool name =', res1.result.echo.params.name);
  console.log('forwarded arguments =', JSON.stringify(res1.result.echo.params.arguments));
  console.log('Object.prototype.polluted (in echo proc) is not observable here; check proxy proc below');
}

// Is THIS proxy process polluted? (separate process, but check our own just in case parser shared)
console.log('this-process Object.prototype.polluted =', ({}).polluted);

client.close();
proxy.stdin.end();
await once(proxy, 'close');
