/**
 * IPC MCP server over stdio for Codex CLI.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createIpcMcp } from './ipc-mcp.js';

function getEnvBool(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

async function main(): Promise<void> {
  const chatJid = process.env.NANOCLAW_CHAT_JID || '';
  const groupFolder = process.env.NANOCLAW_GROUP_FOLDER || '';
  const isMain = getEnvBool(process.env.NANOCLAW_IS_MAIN);
  const isScheduledTask = getEnvBool(process.env.NANOCLAW_IS_SCHEDULED_TASK);

  if (!chatJid || !groupFolder) {
    console.error('[ipc-mcp-stdio] Missing NANOCLAW_CHAT_JID or NANOCLAW_GROUP_FOLDER');
    process.exit(1);
  }

  const mcpServer = createIpcMcp({
    chatJid,
    groupFolder,
    isMain,
    isScheduledTask
  });

  const transport = new StdioServerTransport();
  await mcpServer.instance.connect(transport);
  console.error('[ipc-mcp-stdio] MCP server connected');
}

main().catch((err) => {
  console.error('[ipc-mcp-stdio] Server error:', err);
  process.exit(1);
});
