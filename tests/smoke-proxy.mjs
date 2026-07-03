// Manual smoke test for the Phase 2 stdio proxy.
// Drives dist/index.js against tests/fixtures/echo-server.cjs and asserts that
// messages survive the round trip through the interceptor.
//
//   npm run build && node tests/smoke-proxy.mjs
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const proxy = spawn(
  'node',
  ['dist/index.js', '--port', '3123', '--', 'node', 'tests/fixtures/echo-server.cjs'],
  { stdio: ['pipe', 'pipe', 'inherit'] },
);

const received = [];
let buffer = '';
proxy.stdout.setEncoding('utf8');
proxy.stdout.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line !== '') received.push(JSON.parse(line));
  }
});

// 1. initialize request, deliberately split across two writes to prove the
//    proxy's LineBuffer reassembles partial chunks.
const init = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { clientInfo: { name: 'smoke-test' } },
})}\n`;
proxy.stdin.write(init.slice(0, 25));
await delay(50);
proxy.stdin.write(init.slice(25));

// 2. a notification — no id, the echo server ignores it, the proxy must
//    forward it without answering or breaking the stream.
proxy.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

// 3. a CRLF-terminated tools/call — the packet the firewall will care about.
proxy.stdin.write(
  `${JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'run_command', arguments: { command: 'ls -la' } },
  })}\r\n`,
);

await delay(400);
proxy.stdin.end();
await new Promise((resolve) => proxy.on('close', resolve));

let failed = false;
const assert = (cond, label) => {
  if (cond) {
    console.log(`ok: ${label}`);
  } else {
    console.error(`FAIL: ${label}`);
    failed = true;
  }
};

assert(received.length === 2, `exactly 2 responses (got ${received.length})`);
assert(
  received[0]?.id === 1 && received[0]?.result?.echo?.method === 'initialize',
  'initialize round-trip (split-chunk framing)',
);
assert(
  received[1]?.id === 2 && received[1]?.result?.echo?.params?.name === 'run_command',
  'tools/call round-trip (CRLF framing)',
);

console.log(failed ? 'SMOKE FAILED' : 'SMOKE PASSED');
process.exit(failed ? 1 : 0);
