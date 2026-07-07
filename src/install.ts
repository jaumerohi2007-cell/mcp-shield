import { readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

function fail(message: string): never {
  process.stderr.write(`[mcp-shield] ${message}\n`);
  process.exit(1);
}

export async function runInstallCommand(targetApp: string): Promise<void> {
  if (targetApp !== 'claude' && targetApp !== 'cursor') {
    fail(`unknown app "${targetApp}". Supported: claude, cursor`);
  }

  let configPath = '';
  if (targetApp === 'claude') {
    if (process.platform === 'win32') {
      configPath = path.join(process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
    } else if (process.platform === 'darwin') {
      configPath = path.join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    } else {
      fail('Claude Desktop is currently only supported on Windows and macOS.');
    }
  } else if (targetApp === 'cursor') {
    if (process.platform === 'win32') {
      configPath = path.join(process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'cline_mcp_settings.json');
    } else if (process.platform === 'darwin') {
      configPath = path.join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'cline_mcp_settings.json');
    } else {
      configPath = path.join(homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'cline_mcp_settings.json');
    }
  }

  let raw: string | null = null;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      fail(`Could not find config file at ${configPath}. Please ensure ${targetApp} is installed and has been run at least once.`);
    }
    fail(`cannot read ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let config: Record<string, unknown> = {};
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      fail(`${configPath} is not valid JSON. Please fix it manually first.`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      fail(`${configPath} does not contain a JSON object at the top level`);
    }
    config = parsed as Record<string, unknown>;
  }

  const existingServers = config['mcpServers'];
  if (!existingServers || typeof existingServers !== 'object' || Array.isArray(existingServers)) {
    fail(`No "mcpServers" found in ${configPath} to protect. Add some servers first!`);
  }

  const servers = existingServers as Record<string, any>;
  let modifiedCount = 0;

  for (const [serverName, serverConfig] of Object.entries(servers)) {
    if (!serverConfig || typeof serverConfig !== 'object') continue;
    
    if (serverConfig.command === 'mcp-shield' || (typeof serverConfig.command === 'string' && serverConfig.command.includes('mcp-shield'))) {
      continue;
    }

    const originalCommand = serverConfig.command;
    const originalArgs = serverConfig.args || [];

    serverConfig.command = 'mcp-shield';
    serverConfig.args = ['--', originalCommand, ...originalArgs];
    modifiedCount++;
  }

  if (modifiedCount === 0) {
    process.stderr.write(`[mcp-shield] All servers in ${targetApp} are already protected!\n`);
    return;
  }

  let destPath = configPath;
  try {
    destPath = await realpath(configPath);
  } catch {}
  
  const tmpPath = `${destPath}.${process.pid}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await rename(tmpPath, destPath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    fail(`cannot write ${destPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const message = `[mcp-shield] Successfully shielded ${modifiedCount} server(s) in ${targetApp}. Please restart ${targetApp} to apply changes.`;
  const line = process.stderr.isTTY ? `\x1b[32m${message}\x1b[0m\n` : `${message}\n`;
  
  await new Promise<void>((resolve) => {
    process.stderr.write(line, () => resolve());
  });
}
