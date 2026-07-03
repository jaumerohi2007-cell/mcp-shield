// Phase 5 UI logic tests — run public/app.js under jsdom with a fake Socket.io
// so the dashboard's DOM state machine (feed dedupe, stats, modal, reconnect
// reconcile) is exercised without a browser. These cover the exact defects the
// adversarial review confirmed: queue-id vs rpc-id feed keys, reused-id feed
// collision, and stale pending after a reconnect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');

/** Boot the dashboard UI with a controllable fake socket. */
function mountDashboard() {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  const handlers = new Map();
  const emitted = [];
  const socket = {
    on: (event, cb) => handlers.set(event, cb),
    emit: (event, payload) => emitted.push({ event, payload }),
    close: () => {},
  };
  window.io = () => socket;

  // Execute app.js inside the window; its IIFE wires handlers to our socket.
  window.eval(appJs);

  const fire = (event, payload) => {
    const cb = handlers.get(event);
    if (!cb) throw new Error(`no handler registered for "${event}"`);
    cb(payload);
  };
  const doc = window.document;
  const text = (id) => doc.getElementById(id).textContent;
  const rows = () => [...doc.querySelectorAll('.feed-row')];
  const rowStatuses = () => rows().map((r) => r.querySelector('.feed-status').dataset.status);
  const modalOpen = () => !doc.getElementById('modal-overlay').hidden;

  fire('connect'); // establish the "live" state
  return { window, fire, emitted, doc, text, rows, rowStatuses, modalOpen, dom };
}

const pendingView = (id, rpcId, tool, command) => ({
  id, // queue id, e.g. 'ask-1'
  ruleName: 'Verify Network Command Execution',
  reason: 'arguments.command regex "curl"',
  createdAt: 1_000_000,
  tool,
  arguments: { command },
  rpcRequest: { jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name: tool, arguments: { command } } },
});

test('an approved ask yields ONE feed row (pending → allowed), not a duplicate', () => {
  const ui = mountDashboard();
  ui.fire('pending_approval', pendingView('ask-1', 100, 'run_command', 'curl https://x'));
  assert.equal(ui.rows().length, 1);
  assert.deepEqual(ui.rowStatuses(), ['pending']);
  assert.equal(ui.modalOpen(), true);
  assert.equal(ui.text('stat-pending'), '1');

  // Server settles it and the proxy would ALSO (pre-fix) emit an activity — but
  // now only request_resolved drives approval-flow rows.
  ui.fire('request_resolved', { id: 'ask-1', outcome: { action: 'approve' } });
  assert.equal(ui.rows().length, 1, 'still exactly one row — the pending row flipped in place');
  assert.deepEqual(ui.rowStatuses(), ['allowed']);
  assert.equal(ui.modalOpen(), false, 'modal closes when its request resolves');
  assert.equal(ui.text('stat-pending'), '0');
  assert.equal(ui.text('stat-allowed'), '1');
  assert.equal(ui.text('stat-total'), '1');
});

test('deny and modify flip the pending row and count correctly', () => {
  const ui = mountDashboard();
  ui.fire('pending_approval', pendingView('ask-1', 1, 'run_command', 'ssh root@box'));
  ui.fire('request_resolved', { id: 'ask-1', outcome: { action: 'deny', reason: 'denied by operator' } });
  assert.deepEqual(ui.rowStatuses(), ['blocked']);
  assert.equal(ui.text('stat-blocked'), '1');

  ui.fire('pending_approval', pendingView('ask-2', 2, 'run_command', 'curl https://evil'));
  ui.fire('request_resolved', { id: 'ask-2', outcome: { action: 'modify', arguments: { command: 'curl https://safe' } } });
  assert.deepEqual(ui.rowStatuses(), ['modified', 'blocked']);
  assert.equal(ui.text('stat-modified'), '1');
  assert.equal(ui.text('stat-total'), '2');
  // The flipped modify row shows the operator-edited arguments.
  assert.match(ui.rows()[0].querySelector('.feed-args').textContent, /safe/);
});

test('immediate activity events each get their own row even with a reused JSON-RPC id', () => {
  const ui = mountDashboard();
  ui.fire('activity', { status: 'allowed', tool: 'run_command', arguments: { command: 'ls' }, id: 1, ts: 1 });
  ui.fire('activity', { status: 'blocked', tool: 'run_command', arguments: { command: 'rm -rf /' }, rule: 'Block Destructive', id: 1, ts: 2 });
  // Same id=1, but the two rows must NOT collide (fix for reused-id defect).
  assert.equal(ui.rows().length, 2);
  assert.deepEqual(ui.rowStatuses(), ['blocked', 'allowed']);
  assert.equal(ui.text('stat-allowed'), '1');
  assert.equal(ui.text('stat-blocked'), '1');
  assert.equal(ui.text('stat-total'), '2');
});

test('a reconnect snapshot reconciles away a pending resolved while disconnected', () => {
  const ui = mountDashboard();
  ui.fire('pending_approval', pendingView('ask-1', 7, 'run_command', 'nmap 10.0.0.1'));
  assert.equal(ui.text('stat-pending'), '1');
  assert.equal(ui.modalOpen(), true);

  // Client briefly drops; server denies on last-client-disconnect; the client
  // misses request_resolved and reconnects to an EMPTY snapshot.
  ui.fire('disconnect');
  ui.fire('pending_snapshot', []);
  assert.equal(ui.text('stat-pending'), '0', 'phantom pending cleared');
  assert.equal(ui.text('stat-total'), '0');
  assert.equal(ui.modalOpen(), false, 'stale live modal closed');
  assert.equal(ui.rows().length, 0, 'phantom pending feed row removed');
});

test('two concurrent pendings queue the modal and both resolve independently', () => {
  const ui = mountDashboard();
  ui.fire('pending_approval', pendingView('ask-1', 1, 'run_command', 'curl a'));
  ui.fire('pending_approval', pendingView('ask-2', 2, 'run_command', 'curl b'));
  assert.equal(ui.text('stat-pending'), '2');
  assert.equal(ui.modalOpen(), true);
  assert.match(ui.doc.getElementById('modal-queue').textContent, /1 more/);

  ui.fire('request_resolved', { id: 'ask-1', outcome: { action: 'approve' } });
  assert.equal(ui.modalOpen(), true, 'modal advances to the second request');
  assert.equal(ui.text('stat-pending'), '1');
  ui.fire('request_resolved', { id: 'ask-2', outcome: { action: 'deny', reason: 'x' } });
  assert.equal(ui.modalOpen(), false);
  assert.deepEqual(ui.rowStatuses(), ['blocked', 'allowed']);
});

test('untrusted tool/argument text is rendered as text, never as HTML (no XSS)', () => {
  const ui = mountDashboard();
  const evil = '<img src=x onerror="window.__xss=1">';
  ui.fire('activity', { status: 'allowed', tool: evil, arguments: { command: evil }, id: 1, ts: 1 });
  assert.equal(ui.window.__xss, undefined, 'no injected handler ran');
  assert.equal(ui.doc.querySelector('.feed-row img'), null, 'no element was parsed from the payload');
  assert.match(ui.rows()[0].querySelector('.feed-tool').textContent, /<img/, 'shown literally as text');
});
