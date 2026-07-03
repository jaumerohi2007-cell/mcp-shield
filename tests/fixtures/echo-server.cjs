// Minimal line-delimited JSON-RPC echo server used to smoke-test the proxy.
// Answers every request with a result that mirrors the method and params;
// ignores notifications and anything that is not JSON.
const readline = require('node:readline');

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return; // a real MCP server would ignore non-JSON noise too
  }
  if (message === null || message.id === undefined || message.method === undefined) {
    return; // notification or response — nothing to answer
  }

  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { echo: { method: message.method, params: message.params ?? null } },
    })}\n`,
  );
});
