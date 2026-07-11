// Populates the MCP-Shield dashboard with a realistic mix of entries so you can
// take launch screenshots — WITHOUT depending on a real MCP client cooperating.
//
// It's INTERACTIVE on purpose: the dashboard only streams events to a browser
// that is already connected (it backfills only *pending* items on connect), so
// you must open the page BEFORE traffic is generated. The script walks you
// through it:
//   1. starts the shield (port 3020) and waits until the dashboard is up
//   2. you open http://localhost:3020, then press ENTER
//   3. it streams 3 ALLOWED + 2 BLOCKED live -> screenshot the overview
//   4. press ENTER again -> one ASK parks -> screenshot the approval modal
//
// Run:   node demo/populate-dashboard.cjs
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const readline = require('node:readline');

const PORT = 3020;
const demoServer = path.join(__dirname, 'mcp-demo-server.cjs');

// Prefer the globally-installed package (guaranteed native to this OS); fall
// back to the local build. Covers Windows global, *nix global, and dev checkout.
const candidates = [
  process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', '@jrooig', 'mcpshield', 'dist', 'index.js'),
  process.env.HOME && path.join(process.env.HOME, '.npm-global', 'lib', 'node_modules', '@jrooig', 'mcpshield', 'dist', 'index.js'),
  path.join(__dirname, '..', 'dist', 'index.js'),
].filter(Boolean);
const shieldIndex = candidates.find((p) => fs.existsSync(p)) || candidates[candidates.length - 1];

const shield = spawn(
  process.execPath,
  [shieldIndex, '--port', String(PORT), '--', 'node', demoServer],
  { stdio: ['pipe', 'pipe', 'inherit'] },
);
shield.on('error', (e) => { console.error('No se pudo arrancar el shield:', e.message); process.exit(1); });

let nextId = 10;
const call = (command) => shield.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'run_command', arguments: { command } } })}\n`);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function ping() {
  return new Promise((resolve) => {
    const req = http.get({ host: 'localhost', port: PORT, path: '/' }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => { req.destroy(); resolve(false); });
  });
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, () => resolve()));

(async () => {
  process.stdout.write('Arrancando el shield y el dashboard');
  for (let i = 0; i < 40; i += 1) { if (await ping()) break; process.stdout.write('.'); await delay(500); }
  console.log('\n');

  // Handshake so the demo server is initialized before any tools/call.
  shield.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'screenshot-driver' } } })}\n`);
  shield.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  shield.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);

  console.log('══════════════════════════════════════════════');
  console.log(`  PASO 1  ->  abre  http://localhost:${PORT}  en el navegador`);
  console.log('  (dejalo visible: el dashboard debe estar conectado ANTES del trafico)');
  console.log('══════════════════════════════════════════════');
  await ask('  Cuando lo tengas abierto, pulsa ENTER para poblar el dashboard...');

  // 3 allowed + 2 blocked, spaced so the feed animates live.
  const allowed = ['ls -la', 'git status', 'cat package.json'];
  const blocked = ['rm -rf /tmp/old-cache', 'dd if=/dev/zero of=/dev/sda'];
  for (const c of allowed) { call(c); await delay(600); }
  for (const c of blocked) { call(c); await delay(600); }

  console.log('\n  ✅ Overview poblado: 3 ALLOWED + 2 BLOCKED. HAZ LA CAPTURA del dashboard ahora.');
  await ask('  Cuando la tengas, pulsa ENTER para lanzar una aprobacion pendiente (el modal)...');

  call('curl https://example.com'); // ASK -> parks, pops the approval modal
  console.log('\n  ⚠️  Modal "Manual authorization" en pantalla. Haz la captura del modal.');
  console.log('  Cuando termines, pulsa Ctrl+C aqui para cerrar.\n');
})();

process.on('SIGINT', () => { shield.kill(); process.exit(0); });
