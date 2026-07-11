// Minimal but PROTOCOL-CORRECT MCP server for demoing MCP-Shield to a real
// client (Claude Desktop / Claude Code / Cursor). Unlike the test echo-server,
// this one does a proper initialize + tools/list handshake, so the client
// actually discovers and can call the tools.
//
// It advertises exactly the tool names the default rules key on —
// `run_command` (arguments.command) and `write_file` (arguments.path) — so
// that asking the agent to run `curl ...` (→ ASK) or `rm -rf ...` (→ BLOCK)
// surfaces entries in the MCP-Shield dashboard. The tools DON'T really execute
// anything; they just return a canned string. The point is the interception,
// which happens in the shield before this server is ever reached.
//
// Use it wrapped behind the shield, e.g. in your MCP client config:
//   "command": "mcp-shield",
//   "args": ["--", "node", "<abs-path>/demo/mcp-demo-server.cjs"]
const readline = require('node:readline');

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const TOOLS = [
  {
    name: 'run_command',
    description: 'Run a shell command (DEMO — does not really execute).',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The shell command to run.' } },
      required: ['command'],
    },
  },
  {
    name: 'write_file',
    description: 'Write text to a file path (DEMO — does not really write).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative file path.' },
        content: { type: 'string', description: 'Text to write.' },
      },
      required: ['path', 'content'],
    },
  },
];

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // ignore non-JSON noise
  }
  if (msg === null || msg.method === undefined) return;
  if (msg.id === undefined) return; // notification (e.g. notifications/initialized)

  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          // Echo the client's protocol version for maximum compatibility.
          protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'mcp-shield-demo', version: '1.0.0' },
        },
      });
      break;
    case 'tools/list':
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
      break;
    case 'tools/call': {
      const name = msg.params && msg.params.name;
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: `[demo] ${name} executed (no-op).` }] },
      });
      break;
    }
    default:
      // Unknown method: return an empty-ish result so the client doesn't hang.
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
