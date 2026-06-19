import type { McpServerConfig } from '../config.js';
import {
  getInstalledMcpServers,
  installMarketplaceEntry,
  listMarketplaceEntries,
  removeMcpServer,
  updateMcpServerEnabled,
  upsertMcpServer,
} from '../core/MarketplaceService.js';
import { getRuntimeMcpClient } from '../core/McpClient.js';
import { syncPluginMcpContributions } from '../core/plugins/PluginStore.js';

function formatServer(server: McpServerConfig): string {
  const target = server.transport === 'stdio' ? server.command : server.url;
  return [
    `- ${server.enabled === false ? '[off]' : '[on]'} ${server.id}`,
    `  name: ${server.name}`,
    server.title ? `  title: ${server.title}` : '',
    `  transport: ${server.transport}`,
    `  target: ${target}`,
    server.registry?.server_name ? `  registry: ${server.registry.server_name}${server.registry.version ? `@${server.registry.version}` : ''}` : '',
  ].filter(Boolean).join('\n');
}

function usage(): string {
  return [
    'MCP 用法:',
    '- /mcp list',
    '- /mcp search <query>',
    '- /mcp install <marketplace-entry-id>',
    '- /mcp tools [server-id]',
    '- /mcp call <server-id> <tool-name> [json|key=value ...]',
    '- /mcp resources [server-id]',
    '- /mcp read-resource <server-id> <uri>',
    '- /mcp prompts [server-id]',
    '- /mcp get-prompt <server-id> <prompt-name> [json|key=value ...]',
    '- /mcp templates [server-id]',
    '- /mcp snapshot [server-id]',
    '- /mcp enable <server-id>',
    '- /mcp disable <server-id>',
    '- /mcp remove <server-id>',
    '- /mcp add-remote <id> <url> [name]',
    '- /mcp add-stdio <id> <command> [args...]',
  ].join('\n');
}

function parseValue(input: string): unknown {
  if (input === 'true') return true;
  if (input === 'false') return false;
  if (input === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(input)) return Number(input);
  try {
    return JSON.parse(input);
  } catch {/* expected: fallback to default */
    return input;
  }
}

function parseStructuredArgs(args: string[]): Record<string, unknown> {
  const raw = args.join(' ').trim();
  if (!raw) return {};
  if (raw.startsWith('{')) {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('MCP arguments JSON must be an object.');
    }
    return parsed as Record<string, unknown>;
  }
  const output: Record<string, unknown> = {};
  for (const token of args) {
    const index = token.indexOf('=');
    if (index <= 0) {
      throw new Error(`Invalid argument "${token}". Use JSON or key=value pairs.`);
    }
    const key = token.slice(0, index).trim();
    if (!key) throw new Error(`Invalid argument "${token}".`);
    output[key] = parseValue(token.slice(index + 1));
  }
  return output;
}

export async function handleMcpCommand(args: string[], workspace: string): Promise<string> {
  const action = (args[0] || 'list').toLowerCase();
  syncPluginMcpContributions(workspace);

  if (action === 'help' || action === '-h' || action === '--help') {
    return usage();
  }

  if (action === 'list') {
    const servers = getInstalledMcpServers();
    return [
      `Installed MCP servers: ${servers.length}`,
      '',
      servers.length > 0 ? servers.map(formatServer).join('\n\n') : '(none)',
      '',
      '统一工具入口: mcp(action="list_servers|list_tools|call_tool|list_resources|read_resource|list_prompts|get_prompt|list_resource_templates|capability_snapshot", ...)',
    ].join('\n');
  }

  if (action === 'search') {
    const query = args.slice(1).join(' ').trim();
    if (!query) return '用法: /mcp search <query>';
    const result = await listMarketplaceEntries({ workspace, query, limit: 12 });
    const entries = result.entries.filter((entry) => entry.kind === 'mcp');
    if (entries.length === 0) return `未找到 MCP server: ${query}`;
    return [
      `MCP marketplace search: ${query}`,
      '',
      ...entries.map((entry, index) => [
        `${index + 1}. ${entry.title || entry.name}${entry.installed ? ' [installed]' : ''}`,
        `   id: ${entry.id}`,
        `   version: ${entry.version || 'unknown'} · transport: ${entry.transport || 'n/a'} · installable: ${entry.installable ? 'yes' : 'no'}`,
        `   ${entry.description || ''}`,
      ].join('\n')),
      '',
      '安装: /mcp install <id>',
    ].join('\n');
  }

  if (action === 'install') {
    const id = args[1];
    if (!id) return '用法: /mcp install <marketplace-entry-id>';
    const result = await installMarketplaceEntry({ id, workspace });
    return `已安装 ${result.kind}: ${JSON.stringify(result.installed, null, 2)}`;
  }

  if (action === 'tools') {
    const server = args[1];
    const result = await getRuntimeMcpClient().listTools(server);
    return JSON.stringify(result, null, 2);
  }

  if (action === 'call' || action === 'call-tool') {
    const [server, toolName] = args.slice(1, 3);
    if (!server || !toolName) return '用法: /mcp call <server-id> <tool-name> [json|key=value ...]';
    const result = await getRuntimeMcpClient().callTool(server, toolName, parseStructuredArgs(args.slice(3)));
    return JSON.stringify(result, null, 2);
  }

  if (action === 'resources') {
    const server = args[1];
    const result = await getRuntimeMcpClient().listResources(server);
    return JSON.stringify(result, null, 2);
  }

  if (action === 'read-resource' || action === 'read') {
    const [server, uri] = args.slice(1, 3);
    if (!server || !uri) return '用法: /mcp read-resource <server-id> <uri>';
    const result = await getRuntimeMcpClient().readResource(server, uri);
    return JSON.stringify(result, null, 2);
  }

  if (action === 'prompts') {
    const server = args[1];
    const result = await getRuntimeMcpClient().listPrompts(server);
    return JSON.stringify(result, null, 2);
  }

  if (action === 'get-prompt' || action === 'prompt') {
    const [server, name] = args.slice(1, 3);
    if (!server || !name) return '用法: /mcp get-prompt <server-id> <prompt-name> [json|key=value ...]';
    const result = await getRuntimeMcpClient().getPrompt(server, name, parseStructuredArgs(args.slice(3)));
    return JSON.stringify(result, null, 2);
  }

  if (action === 'templates' || action === 'resource-templates') {
    const server = args[1];
    const result = await getRuntimeMcpClient().listResourceTemplates(server);
    return JSON.stringify(result, null, 2);
  }

  if (action === 'snapshot' || action === 'capabilities') {
    const server = args[1];
    const result = await getRuntimeMcpClient().getCapabilitySnapshot(server);
    return JSON.stringify(result, null, 2);
  }

  if (action === 'enable' || action === 'disable') {
    const serverId = args[1];
    if (!serverId) return `用法: /mcp ${action} <server-id>`;
    const updated = updateMcpServerEnabled(serverId, action === 'enable');
    if (!updated) return `MCP server 不存在: ${serverId}`;
    return `${updated.id} 已${updated.enabled === false ? '禁用' : '启用'}`;
  }

  if (action === 'remove' || action === 'delete') {
    const serverId = args[1];
    if (!serverId) return `用法: /mcp ${action} <server-id>`;
    return removeMcpServer(serverId) ? `已删除 MCP server: ${serverId}` : `MCP server 不存在: ${serverId}`;
  }

  if (action === 'add-remote') {
    const [id, url, name] = args.slice(1);
    if (!id || !url) return '用法: /mcp add-remote <id> <url> [name]';
    const server = upsertMcpServer({
      id,
      name: name || id,
      enabled: true,
      transport: 'streamable-http',
      url,
      headers: [],
    });
    return `已保存 remote MCP server:\n${formatServer(server)}`;
  }

  if (action === 'add-stdio') {
    const [id, command, ...stdioArgs] = args.slice(1);
    if (!id || !command) return '用法: /mcp add-stdio <id> <command> [args...]';
    const server = upsertMcpServer({
      id,
      name: id,
      enabled: true,
      transport: 'stdio',
      command,
      args: stdioArgs,
      env: {},
    });
    return `已保存 stdio MCP server:\n${formatServer(server)}`;
  }

  return `${usage()}\n\n未知 MCP 子命令: ${action}`;
}
