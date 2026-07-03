/* MCP-Shield dashboard client (blueprint §4, Phase 5).
 *
 * Speaks the Socket.io contract the proxy exposes:
 *   server → client:  pending_snapshot | pending_approval | request_resolved | activity
 *   client → server:  approve {id} | deny {id} | modify {id, arguments}
 *
 * SECURITY: tool names and arguments originate from the (untrusted) MCP client,
 * so every dynamic value is written with textContent — never innerHTML.
 */
(() => {
  'use strict';

  const APPROVAL_TIMEOUT_MS = 120_000; // matches DEFAULT_APPROVAL_TIMEOUT_MS

  const $ = (id) => document.getElementById(id);
  const els = {
    conn: $('conn'),
    connLabel: $('conn-label'),
    statTotal: $('stat-total'),
    statAllowed: $('stat-allowed'),
    statBlocked: $('stat-blocked'),
    statModified: $('stat-modified'),
    statPending: $('stat-pending'),
    pendingCard: $('pending-card'),
    feed: $('feed'),
    feedEmpty: $('feed-empty'),
    clearFeed: $('clear-feed'),
    overlay: $('modal-overlay'),
    badge: $('modal-badge'),
    countdown: $('modal-countdown'),
    ruleName: $('modal-rule-name'),
    ruleReason: $('modal-rule-reason'),
    tool: $('modal-tool'),
    args: $('modal-args'),
    error: $('modal-error'),
    btnDeny: $('btn-deny'),
    btnReset: $('btn-reset'),
    btnApprove: $('btn-approve'),
    queue: $('modal-queue'),
  };

  // --- State ---------------------------------------------------------------
  const stats = { allowed: 0, blocked: 0, modified: 0 };
  const pending = new Map(); // id → view
  const feedRows = new Map(); // dedupe key → <li>
  const modalQueue = []; // ids awaiting operator decision, in arrival order
  let syntheticKey = 0;
  let current = null; // { id, originalArgs } of the request shown in the modal
  let countdownTimer = null;

  // --- Helpers -------------------------------------------------------------
  function prettyArgs(args) {
    if (args === undefined || args === null) return '{}';
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return String(args);
    }
  }

  function inlineArgs(args) {
    if (args === undefined || args === null) return '';
    try {
      return JSON.stringify(args);
    } catch {
      return String(args);
    }
  }

  function timeLabel(ts) {
    const d = ts ? new Date(ts) : new Date();
    return d.toLocaleTimeString([], { hour12: false });
  }

  function updateStats() {
    els.statAllowed.textContent = String(stats.allowed);
    els.statBlocked.textContent = String(stats.blocked);
    els.statModified.textContent = String(stats.modified);
    els.statPending.textContent = String(pending.size);
    els.statTotal.textContent = String(stats.allowed + stats.blocked + stats.modified + pending.size);
    els.pendingCard.classList.toggle('active', pending.size > 0);
  }

  // --- Feed ----------------------------------------------------------------
  function buildRow(entry) {
    const li = document.createElement('li');
    li.className = 'feed-row';

    const status = document.createElement('span');
    status.className = 'feed-status';
    status.dataset.status = entry.status;
    status.textContent = entry.status;

    const main = document.createElement('div');
    main.className = 'feed-main';
    const tool = document.createElement('div');
    tool.className = 'feed-tool';
    tool.textContent = entry.tool || '(non-tool traffic)';
    main.appendChild(tool);

    const argText = inlineArgs(entry.arguments);
    if (argText) {
      const args = document.createElement('div');
      args.className = 'feed-args';
      args.textContent = argText;
      main.appendChild(args);
    }
    const ruleText = [entry.rule, entry.reason].filter(Boolean).join(' — ');
    if (ruleText) {
      const rule = document.createElement('div');
      rule.className = 'feed-rule';
      rule.textContent = ruleText;
      main.appendChild(rule);
    }

    const time = document.createElement('span');
    time.className = 'feed-time';
    time.textContent = timeLabel(entry.ts);

    li.append(status, main, time);
    return li;
  }

  function upsertFeed(key, entry) {
    els.feedEmpty.hidden = true;
    const row = buildRow(entry);
    const existing = key != null ? feedRows.get(key) : undefined;
    if (existing && existing.parentNode === els.feed) {
      // Flip in place (e.g. a pending row → its resolved status).
      els.feed.replaceChild(row, existing);
    } else {
      els.feed.prepend(row);
      // Cap the DOM at a sane length so a long session stays snappy.
      while (els.feed.children.length > 200) {
        const last = els.feed.lastElementChild;
        if (!last) break;
        if (last.dataset.key) feedRows.delete(last.dataset.key);
        els.feed.removeChild(last);
      }
    }
    if (key != null) {
      row.dataset.key = key;
      feedRows.set(key, row);
    }
  }

  function removeFeedRow(key) {
    const row = feedRows.get(key);
    if (row) {
      if (row.parentNode === els.feed) els.feed.removeChild(row);
      feedRows.delete(key);
    }
  }

  // --- Modal ---------------------------------------------------------------
  function refreshApproveLabel() {
    const edited = els.args.value !== current?.originalArgs;
    els.args.classList.toggle('edited', edited);
    els.btnApprove.classList.toggle('will-modify', edited);
    els.btnApprove.textContent = edited ? 'Approve edited' : 'Approve';
  }

  function startCountdown() {
    stopCountdown();
    // Count from when THIS browser first showed the request, not the server's
    // createdAt: the two clocks can differ, which would otherwise show >120s or
    // a premature 0s. This is advisory anyway — the server enforces the real
    // timeout — so a slight network-delay skew is fine.
    const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
    const tick = () => {
      const remaining = Math.max(0, deadline - Date.now());
      const secs = Math.ceil(remaining / 1000);
      els.countdown.textContent = `${secs}s`;
      els.countdown.classList.toggle('urgent', secs <= 15);
      if (remaining <= 0) stopCountdown();
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  function stopCountdown() {
    if (countdownTimer !== null) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function setButtonsEnabled(enabled) {
    els.btnDeny.disabled = !enabled;
    els.btnReset.disabled = !enabled;
    els.btnApprove.disabled = !enabled;
  }

  function showModal(view) {
    current = { id: view.id, originalArgs: prettyArgs(view.arguments) };
    els.ruleName.textContent = view.ruleName || 'Manual review';
    els.ruleReason.textContent = view.reason || '';
    els.tool.textContent = view.tool || '(unknown tool)';
    els.args.value = current.originalArgs;
    els.error.hidden = true;
    setButtonsEnabled(true);
    refreshApproveLabel();
    startCountdown();

    const others = modalQueue.length - 1;
    els.queue.hidden = others <= 0;
    if (others > 0) els.queue.textContent = `${others} more request${others > 1 ? 's' : ''} waiting`;

    els.overlay.hidden = false;
  }

  function hideModal() {
    els.overlay.hidden = true;
    current = null;
    stopCountdown();
  }

  /** Show the next queued request, or close the modal when the queue is empty. */
  function advanceModal() {
    while (modalQueue.length > 0 && !pending.has(modalQueue[0])) {
      modalQueue.shift(); // drop ids already resolved elsewhere
    }
    if (modalQueue.length === 0) {
      hideModal();
      return;
    }
    showModal(pending.get(modalQueue[0]));
  }

  function submit(kind) {
    if (!current) return;
    const id = current.id;

    if (kind === 'approve') {
      let parsed;
      try {
        parsed = JSON.parse(els.args.value);
      } catch (err) {
        els.error.textContent = `Invalid JSON: ${err.message}`;
        els.error.hidden = false;
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        els.error.textContent = 'Arguments must be a JSON object.';
        els.error.hidden = false;
        return;
      }
      if (els.args.value === current.originalArgs) {
        socket.emit('approve', { id });
      } else {
        socket.emit('modify', { id, arguments: parsed });
      }
    } else {
      socket.emit('deny', { id });
    }
    // Lock the modal until the server confirms via request_resolved.
    setButtonsEnabled(false);
    els.error.hidden = true;
  }

  // --- Pending lifecycle ---------------------------------------------------
  function addPending(view, openModal) {
    if (pending.has(view.id)) return;
    pending.set(view.id, view);
    modalQueue.push(view.id);
    updateStats();
    // Live 'pending' feed row keyed on the QUEUE id (view.id, e.g. 'ask-1').
    // request_resolved carries the same queue id and flips this row in place
    // to its final status — the 'activity' event (JSON-RPC id) is not used for
    // approval-flow requests, so the two id namespaces never have to match.
    upsertFeed(`req:${view.id}`, {
      status: 'pending',
      tool: view.tool,
      arguments: view.arguments,
      rule: view.ruleName,
      reason: view.reason,
      ts: view.createdAt,
    });
    if (openModal && els.overlay.hidden) {
      advanceModal();
    } else if (openModal && current && modalQueue.length > 1) {
      // Modal already open on another request: just refresh the "N more" note.
      const others = modalQueue.length - 1;
      els.queue.hidden = others <= 0;
      if (others > 0) els.queue.textContent = `${others} more request${others > 1 ? 's' : ''} waiting`;
    }
  }

  /**
   * Settle a parked request. With an `outcome` (a real request_resolved), flip
   * its feed row to the final status and bump the matching counter. Without one
   * (reconciled away by a snapshot after we missed the resolution while briefly
   * disconnected), just drop the stale pending row — we don't know its verdict,
   * so it isn't counted.
   */
  function resolvePending(id, outcome) {
    const view = pending.get(id);
    if (view === undefined) return;
    pending.delete(id);

    if (outcome && typeof outcome.action === 'string') {
      const status =
        outcome.action === 'approve' ? 'allowed' : outcome.action === 'modify' ? 'modified' : 'blocked';
      stats[status] += 1;
      upsertFeed(`req:${id}`, {
        status,
        tool: view.tool,
        arguments: outcome.action === 'modify' ? outcome.arguments : view.arguments,
        rule: view.ruleName,
        reason: outcome.action === 'deny' ? outcome.reason : view.reason,
        ts: Date.now(),
      });
    } else {
      removeFeedRow(`req:${id}`);
    }

    updateStats();
    if (current && current.id === id) {
      advanceModal();
    }
  }

  // --- Socket wiring --------------------------------------------------------
  const socket = io({ reconnection: true });

  socket.on('connect', () => {
    els.conn.dataset.state = 'connected';
    els.connLabel.textContent = 'Live';
  });
  socket.on('disconnect', () => {
    els.conn.dataset.state = 'disconnected';
    els.connLabel.textContent = 'Disconnected';
  });

  socket.on('pending_snapshot', (list) => {
    if (!Array.isArray(list)) return;
    // The snapshot is the server's full truth. Drop any local pending it no
    // longer knows about — it was resolved (often disconnect-denied) while we
    // were briefly disconnected and we missed the request_resolved — so its
    // phantom stat, feed row, and live modal are all cleared on reconnect.
    const live = new Set();
    for (const view of list) if (view && typeof view.id === 'string') live.add(view.id);
    for (const id of [...pending.keys()]) {
      if (!live.has(id)) resolvePending(id); // no outcome → reconcile away
    }
    list.forEach((view) => addPending(view, true));
  });

  socket.on('pending_approval', (view) => {
    if (view && typeof view.id === 'string') addPending(view, true);
  });

  socket.on('request_resolved', (payload) => {
    if (payload && typeof payload.id === 'string') resolvePending(payload.id, payload.outcome);
  });

  socket.on('activity', (a) => {
    if (!a || typeof a.status !== 'string') return;
    if (a.status === 'allowed') stats.allowed += 1;
    else if (a.status === 'blocked') stats.blocked += 1;
    else if (a.status === 'modified') stats.modified += 1;
    updateStats();
    // Immediate (non-approval) decisions only — approval-flow requests are
    // handled by pending_approval/request_resolved. Every activity is its own
    // row under a unique key: the JSON-RPC id is untrusted and a hostile client
    // could reuse it, which would otherwise let one row clobber another while
    // stats still count both.
    upsertFeed(`syn:${++syntheticKey}`, a);
  });

  // --- DOM events ----------------------------------------------------------
  els.args.addEventListener('input', refreshApproveLabel);
  els.btnApprove.addEventListener('click', () => submit('approve'));
  els.btnDeny.addEventListener('click', () => submit('deny'));
  els.btnReset.addEventListener('click', () => {
    if (current) {
      els.args.value = current.originalArgs;
      els.error.hidden = true;
      refreshApproveLabel();
    }
  });
  els.clearFeed.addEventListener('click', () => {
    els.feed.replaceChildren();
    feedRows.clear();
    els.feedEmpty.hidden = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.overlay.hidden && current && !els.btnDeny.disabled) {
      submit('deny'); // Esc = fail closed, consistent with the proxy's default
    }
  });

  updateStats();
})();
