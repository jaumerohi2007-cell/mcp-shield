/**
 * Dashboard server (blueprint Component D): Express for the static Web UI plus
 * a Socket.io channel carrying the manual-approval flow.
 *
 * The proxy launches this on the CLI `--port` and hands the returned
 * `ApprovalQueue` to its `ask` hook. If the preferred port is busy the server
 * walks forward to the next free one rather than failing, so a second shielded
 * server on the same machine still gets a dashboard.
 *
 * Diagnostics go to stderr only: stdout is the MCP protocol channel.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { Server as SocketIoServer } from 'socket.io';

import { ApprovalQueue, attachApprovalHandlers } from './wsHandler.js';

/** Static assets live in <project>/public; this file compiles to <project>/dist/server/. */
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

const MAX_PORT_PROBES = 20;

export interface DashboardServer {
  /** The port actually bound (may differ from the requested one). */
  port: number;
  /** The approval queue the proxy parks `ask` requests in. */
  queue: ApprovalQueue;
  /** Push an event to every connected dashboard client (activity feed, etc.). */
  broadcast(event: string, payload: unknown): void;
  /** Number of connected dashboard clients right now. */
  clientCount(): number;
  /** Stop accepting connections and release the port. */
  close(): Promise<void>;
}

export interface DashboardOptions {
  /** Diagnostic sink (stderr in the proxy). */
  log?: (message: string) => void;
  /** Per-request approval timeout; forwarded to the ApprovalQueue. */
  approvalTimeoutMs?: number;
  /** How many sequential ports to try before giving up. */
  maxPortProbes?: number;
}

/**
 * Start the dashboard, probing forward from `preferredPort` on EADDRINUSE.
 * Resolves once a port is bound; rejects if none is free within the probe
 * budget or on any non-address error.
 */
export async function startDashboardServer(
  preferredPort: number,
  options: DashboardOptions = {},
): Promise<DashboardServer> {
  const log = options.log ?? (() => {});
  const maxProbes = options.maxPortProbes ?? MAX_PORT_PROBES;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.static(PUBLIC_DIR));

  const httpServer = createServer(app);
  const io = new SocketIoServer(httpServer, {
    // The dashboard is a local operator tool; allow any origin to load it.
    cors: { origin: '*' },
  });

  const queue = new ApprovalQueue({
    broadcast: (event, payload) => io.emit(event, payload),
    timeoutMs: options.approvalTimeoutMs,
  });
  attachApprovalHandlers(io, queue);

  const port = await listenWithFallback(httpServer, preferredPort, maxProbes, log);

  // Keep a permanent 'error' listener once bound: listenWithFallback removes
  // its own on success, and an EventEmitter 'error' with no listener throws —
  // which would crash the whole proxy, taking the stdout protocol channel with
  // it. A dashboard-side failure must never do that; log and carry on.
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    log(`dashboard server error (ignored): ${err.message}`);
  });

  log(`dashboard listening on http://localhost:${port} (static: ${PUBLIC_DIR})`);

  return {
    port,
    queue,
    broadcast: (event, payload) => io.emit(event, payload),
    clientCount: () => io.engine.clientsCount,
    close: () =>
      new Promise<void>((resolve) => {
        io.close(() => httpServer.close(() => resolve()));
      }),
  };
}

function listenWithFallback(
  httpServer: HttpServer,
  startPort: number,
  maxProbes: number,
  log: (message: string) => void,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let port = startPort;
    let attempts = 0;

    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && attempts < maxProbes) {
        log(`port ${port} in use, trying ${port + 1}`);
        attempts += 1;
        port += 1;
        // Retry on the next port; the 'error' listener stays attached.
        setImmediate(tryListen);
        return;
      }
      httpServer.removeListener('error', onError);
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`no free port found in ${startPort}..${startPort + maxProbes}`)
          : err,
      );
    };

    const tryListen = () => {
      httpServer.listen(port, () => {
        httpServer.removeListener('error', onError);
        // Read the bound port from the socket, so port 0 (OS-assigned, used by
        // tests for a hermetic ephemeral port) resolves to the real number.
        const address = httpServer.address();
        resolve(typeof address === 'object' && address !== null ? address.port : port);
      });
    };

    httpServer.on('error', onError);
    tryListen();
  });
}
