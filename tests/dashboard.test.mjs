// Phase 4 tests: approval queue, dashboard server (static + fallback port),
// and an end-to-end approve / deny / modify / timeout flow through the real
// proxy over Socket.io.
//
//   npm test   (= npm run build && node --test tests/*.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { io as ioClient } from 'socket.io-client';

import { ApprovalQueue } from '../dist/server/wsHandler.js';
import { startDashboardServer } from '../dist/server/dashboardServer.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const toolCall = (name, args, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const runCommand = (command, id = 1) => toolCall('run_command', { command }, id);

// ---------------------------------------------------------------------------
// ApprovalQueue — transport-agnostic logic
// ---------------------------------------------------------------------------

function makeQueue(overrides = {}) {
  const events = [];
  const queue = new ApprovalQueue({
    broadcast: (event, payload) => events.push({ event, payload }),
    idFactory: (() => {
      let n = 0;
      return () => `q-${++n}`;
    })(),
    ...overrides,
  });
  return { queue, events };
}

test('approve resolves with the approve outcome and broadcasts the lifecycle', async () => {
  const { queue, events } = makeQueue();
  const p = queue.enqueue(runCommand('curl https://x'), 'ask-network');
  assert.equal(queue.size, 1);
  assert.equal(events[0].event, 'pending_approval');
  assert.equal(events[0].payload.id, 'q-1');
  assert.equal(events[0].payload.tool, 'run_command');

  assert.equal(queue.approve('q-1'), true);
  assert.deepEqual(await p, { action: 'approve' });
  assert.equal(queue.size, 0);
  assert.equal(events.at(-1).event, 'request_resolved');
});

test('deny resolves with a reason', async () => {
  const { queue } = makeQueue();
  const p = queue.enqueue(runCommand('curl https://x'), 'ask-network');
  queue.deny('q-1', 'nope');
  assert.deepEqual(await p, { action: 'deny', reason: 'nope' });
});

test('modify resolves with the operator-edited arguments', async () => {
  const { queue } = makeQueue();
  const p = queue.enqueue(runCommand('curl https://evil'), 'ask-network');
  queue.modify('q-1', { command: 'curl https://safe' });
  assert.deepEqual(await p, { action: 'modify', arguments: { command: 'curl https://safe' } });
});

test('a request auto-denies (fail-closed) when the approval times out', async () => {
  const { queue } = makeQueue({ timeoutMs: 40 });
  const outcome = await queue.enqueue(runCommand('curl https://x'), 'ask-network');
  assert.equal(outcome.action, 'deny');
  assert.match(outcome.reason, /timed out/);
  assert.equal(queue.size, 0);
});

test('denyAll fails closed on every parked request', async () => {
  const { queue } = makeQueue();
  const a = queue.enqueue(runCommand('curl a'), 'r');
  const b = queue.enqueue(runCommand('curl b'), 'r');
  assert.equal(queue.size, 2);
  queue.denyAll('dashboard gone');
  assert.equal((await a).action, 'deny');
  assert.equal((await b).action, 'deny');
  assert.equal((await b).reason, 'dashboard gone');
});

test('acting on an unknown or already-settled id is a harmless no-op', async () => {
  const { queue } = makeQueue();
  assert.equal(queue.approve('does-not-exist'), false);
  const p = queue.enqueue(runCommand('curl x'), 'r');
  queue.approve('q-1');
  assert.equal(queue.approve('q-1'), false); // second time: already settled
  await p;
});

test('snapshot exposes the pending requests for a newly connected client', () => {
  const { queue } = makeQueue();
  queue.enqueue(runCommand('curl x'), 'ask-network');
  const snap = queue.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].id, 'q-1');
  assert.equal(snap[0].ruleName, 'ask-network');
  assert.equal(snap[0].arguments.command, 'curl x');
  queue.denyAll('cleanup'); // settle the parked request so its timer clears
});

// ---------------------------------------------------------------------------
// Dashboard server — static + port fallback
// ---------------------------------------------------------------------------

test('dashboard binds an ephemeral port and accepts a Socket.io connection', async () => {
  const server = await startDashboardServer(0);
  try {
    assert.ok(server.port > 0);
    const client = ioClient(`http://localhost:${server.port}`, { transports: ['websocket'], reconnection: false });
    // Attach the snapshot listener BEFORE awaiting connect: the server emits
    // pending_snapshot on connection, which can arrive before a listener
    // added after `await once(connect)` — a race that would hang forever.
    const snapshotP = once(client, 'pending_snapshot', { signal: AbortSignal.timeout(10000) });
    await once(client, 'connect', { signal: AbortSignal.timeout(10000) });
    const [snapshot] = await snapshotP;
    assert.deepEqual(snapshot, []);
    client.close();
  } finally {
    await server.close();
  }
});

test('dashboard walks forward to a free port when the preferred one is taken', async () => {
  const blocker = createNetServer();
  await new Promise((resolve) => blocker.listen(0, resolve));
  const takenPort = blocker.address().port;
  try {
    const server = await startDashboardServer(takenPort, { maxPortProbes: 5 });
    assert.notEqual(server.port, takenPort);
    assert.ok(server.port > takenPort);
    await server.close();
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('dashboard serves the static UI (index.html, app.css, app.js) and the socket.io client', async () => {
  const server = await startDashboardServer(0);
  try {
    const base = `http://localhost:${server.port}`;
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /MCP.?Shield/i);
    assert.match(html, /\/app\.js/);

    for (const [path, needle] of [
      ['/app.css', '--danger'],
      ['/app.js', 'pending_approval'],
      ['/socket.io/socket.io.js', 'socket.io'],
    ]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, `${path} should be served`);
      assert.match(await res.text(), new RegExp(needle));
    }
  } finally {
    await server.close();
  }
});

test('broadcast pushes an event to every connected dashboard client', async () => {
  const server = await startDashboardServer(0);
  try {
    const client = ioClient(`http://localhost:${server.port}`, { transports: ['websocket'], reconnection: false });
    const activityP = once(client, 'activity', { signal: AbortSignal.timeout(10000) });
    await once(client, 'connect', { signal: AbortSignal.timeout(10000) });
    server.broadcast('activity', { status: 'blocked', tool: 'run_command', rule: 'Block Destructive Shell Commands' });
    const [activity] = await activityP;
    assert.equal(activity.status, 'blocked');
    assert.equal(activity.rule, 'Block Destructive Shell Commands');
    client.close();
  } finally {
    await server.close();
  }
});

test('pending_approval carries the triggering rule reason for the modal', async () => {
  const events = [];
  const queue = new ApprovalQueue({ broadcast: (event, payload) => events.push({ event, payload }), idFactory: () => 'q-1' });
  queue.enqueue(runCommand('curl https://x'), 'Verify Network Command Execution', 'arguments.command regex "curl|wget"');
  const view = events.find((e) => e.event === 'pending_approval').payload;
  assert.equal(view.ruleName, 'Verify Network Command Execution');
  assert.equal(view.reason, 'arguments.command regex "curl|wget"');
  queue.denyAll('cleanup');
});

// ---------------------------------------------------------------------------
// End-to-end through the real proxy + Socket.io dashboard
// ---------------------------------------------------------------------------

/** Spawn the proxy on an OS-assigned port and resolve once its dashboard port is known. */
async function spawnProxy() {
  // Isolated home: the proxy loads ~/.mcp-shield/rules.cache.json and
  // session.json from the real home when they exist, which would swap in
  // enterprise-synced rules and change which calls park as 'ask' here.
  const home = await mkdtemp(path.join(tmpdir(), 'shield-e2e-'));
  const proxy = spawn('node', ['dist/index.js', '--port', '0', '--', 'node', 'tests/fixtures/echo-server.cjs'], {
    cwd: projectRoot,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ['pipe', 'pipe', 'pipe'],
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
  // Loading express + socket.io from the (Windows-mounted) node_modules can
  // take 10+ s per cold `node` spawn, so give startup a generous window.
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no dashboard port in stderr:\n${errBuf}`)), 30000);
    proxy.stderr.on('data', (chunk) => {
      errBuf += chunk;
      const m = errBuf.match(/dashboard listening on http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
  });

  const waitForResponse = (id, timeoutMs = 5000) =>
    new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        const found = responses.find((r) => r.id === id);
        if (found) return resolve(found);
        if (Date.now() > deadline) return reject(new Error(`timeout waiting for response id=${id}`));
        setTimeout(poll, 20);
      };
      poll();
    });

  return { proxy, port, responses, waitForResponse };
}

// approve / deny / modify share one proxy + client to pay the ~10 s cold-start
// once. The sequential client queue parks one ask at a time, so we send each
// command only after the previous response lands; the handler applies the
// verdict scripted for the current pending request.
test('e2e: approve / deny / modify each drive the target correctly', async () => {
  const { proxy, port, waitForResponse } = await spawnProxy();
  const client = ioClient(`http://localhost:${port}`, { transports: ['websocket'], reconnection: false });
  await once(client, 'connect', { signal: AbortSignal.timeout(15000) });

  const activity = []; // immediate (non-approval) feed events
  const resolved = []; // approval-flow outcomes
  client.on('activity', (a) => activity.push(a));
  client.on('request_resolved', (r) => resolved.push(r));

  let verdict = null; // set before each command; the handler applies it
  client.on('pending_approval', (req) => {
    // The modal must know WHY the request was held.
    assert.equal(typeof req.reason, 'string');
    if (verdict === 'approve') client.emit('approve', { id: req.id });
    else if (verdict === 'deny') client.emit('deny', { id: req.id });
    else if (verdict === 'modify') client.emit('modify', { id: req.id, arguments: { command: 'curl https://SAFE.example' } });
  });

  const drive = async (cmd, id, action) => {
    verdict = action;
    proxy.stdin.write(`${JSON.stringify(runCommand(cmd, id))}\n`);
    return waitForResponse(id);
  };

  // An immediate (non-ask) allowed call: this DOES emit an activity event.
  const listed = await drive('ls -la', 50, null);
  assert.equal(listed.result.echo.params.name, 'run_command', 'benign call must round-trip');

  const approved = await drive('curl https://example.com', 100, 'approve');
  assert.equal(approved.result.echo.params.name, 'run_command', 'approved call must reach the server');
  assert.equal(approved.result.echo.params.arguments.command, 'curl https://example.com');

  const denied = await drive('ssh root@box', 200, 'deny');
  assert.equal(denied.error.code, -32003, 'denied call must return Access Denied');

  const modified = await drive('curl https://EVIL.example', 300, 'modify');
  assert.equal(
    modified.result.echo.params.arguments.command,
    'curl https://SAFE.example',
    'server must receive the operator-edited arguments',
  );

  await new Promise((r) => setTimeout(r, 250)); // let trailing events land

  // Approval-flow requests are carried by request_resolved (in order), NOT by
  // activity — else the dashboard would double-render them.
  assert.deepEqual(
    resolved.map((r) => r.outcome.action),
    ['approve', 'deny', 'modify'],
    'each ask resolves through request_resolved in order',
  );
  assert.equal(activity.length, 1, 'only the immediate ls call produces an activity event');
  assert.equal(activity[0].status, 'allowed');
  assert.equal(activity[0].id, 50);

  client.close();
  proxy.stdin.end();
  await once(proxy, 'close');
});

test('e2e: closing the client stdin while a request is parked shuts down promptly (no 120s stall)', async () => {
  const { proxy } = await spawnProxy();
  // 'ssh ...' → firewall 'ask' → parked on the queue (the dashboard server is
  // up but no operator answers). Nothing approves or denies it.
  proxy.stdin.write(`${JSON.stringify(runCommand('ssh root@box', 500))}\n`);
  // Give the firewall a beat to park the request, then hang up the client.
  await new Promise((r) => setTimeout(r, 300));
  proxy.stdin.end();

  // Without the MCP-client-disconnect denyAll backstop this would wait the full
  // 120 s approval timeout; with it the proxy shuts down in seconds.
  const closed = await Promise.race([
    once(proxy, 'close').then(() => 'closed'),
    new Promise((resolve) => setTimeout(() => resolve('stalled'), 20000)),
  ]);
  if (closed !== 'closed') proxy.kill('SIGKILL');
  assert.equal(closed, 'closed', 'proxy must shut down promptly when the client hangs up mid-approval');
});

// Exercised in-process (real Socket.io, no proxy spawn) so the disconnect →
// fail-closed path is deterministic; the proxy ↔ dashboard integration itself
// is already proven by the approve/deny/modify e2e above.
test('a request pending when the dashboard disconnects fails closed', async () => {
  const server = await startDashboardServer(0, { approvalTimeoutMs: 60000 });
  try {
    const client = ioClient(`http://localhost:${server.port}`, { transports: ['websocket'], reconnection: false });
    await once(client, 'connect', { signal: AbortSignal.timeout(10000) });
    // The operator's browser goes away the moment the request surfaces.
    client.on('pending_approval', () => client.close());

    const outcome = await server.queue.enqueue(runCommand('nmap 10.0.0.1'), 'ask-network');
    assert.equal(outcome.action, 'deny', 'a disconnect before a verdict must fail closed');
    assert.match(outcome.reason, /disconnect/);
  } finally {
    await server.close();
  }
});
