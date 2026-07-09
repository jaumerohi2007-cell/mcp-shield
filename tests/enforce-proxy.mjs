// E2E de ENFORCEMENT a través del proxy real: dist/index.js delante del
// echo-server. Comprueba que un tools/call benigno se REENVÍA (result.echo) y
// uno destructivo se BLOQUEA (error "Access Denied by Policy") sin llegar al
// target. Sigue el patrón del smoke (stdin.end + 'close', sin kill).
// MCP_SHIELD_SERVER_URL a un puerto muerto → el sync falla al instante y no
// depende del cold-start de Render. Ejecutar: npm run build && node tests/rev_enforce.mjs
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// HOME aislado → hasSession()=false → el proxy salta el enterprise sync/telemetry
// y evalúa con las reglas POR DEFECTO (ruta Community CLI, sin red).
const isoHome = mkdtempSync(path.join(tmpdir(), 'mcpshield-enforce-'));

const proxy = spawn(
  'node',
  ['dist/index.js', '--port', '3126', '--', 'node', 'tests/fixtures/echo-server.cjs'],
  { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, HOME: isoHome, USERPROFILE: isoHome } },
);

const byId = new Map();
let buffer = '';
proxy.stdout.setEncoding('utf8');
proxy.stdout.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line === '') continue;
    try { const m = JSON.parse(line); if (m.id !== undefined) byId.set(m.id, m); } catch {}
  }
});

const send = (obj) => proxy.stdin.write(`${JSON.stringify(obj)}\n`);

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'enforce-test' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
// Benigno → debe reenviarse (ALLOW).
send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_command', arguments: { command: 'ls -la' } } });
// Destructivo → debe BLOQUEARSE por la regla block-destructive (rm -rf).
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_command', arguments: { command: 'rm -rf /tmp/victim' } } });

await delay(600);
proxy.stdin.end();
// Espera cierre graceful, con guardia de 8s por si el proxy no cerrara.
await Promise.race([
  new Promise((resolve) => proxy.on('close', resolve)),
  delay(8000).then(() => proxy.kill()),
]);

let fail = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? '  ok  ' : 'FAIL  ') + label + (cond ? '' : ' — ' + extra)); if (!cond) fail++; };

const r2 = byId.get(2);
const r3 = byId.get(3);
ok('benigno (ls -la) recibe respuesta', !!r2, 'sin respuesta id=2');
ok('benigno se REENVIA al target (result.echo)', !!(r2 && r2.result && r2.result.echo), JSON.stringify(r2));
ok('destructivo (rm -rf) recibe respuesta', !!r3, 'sin respuesta id=3');
ok('destructivo BLOQUEADO (error, no result)', !!(r3 && r3.error && !r3.result), JSON.stringify(r3));
ok('mensaje "Access Denied by Policy"', !!(r3 && r3.error && r3.error.message === 'Access Denied by Policy'), JSON.stringify(r3 && r3.error));
ok('el bloqueo NO llego al target (sin echo del rm)', !(r3 && r3.result && r3.result.echo), 'el target ejecuto el comando bloqueado');

console.log(fail === 0 ? '\nENFORCEMENT E2E PASSED' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
