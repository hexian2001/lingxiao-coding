import { z } from 'zod';
import { Tool, createToolError, type ToolContext, type ToolResult } from '../Tool.js';
import { getRuntimeMcpClient, type McpClientLike } from '../../core/McpClient.js';
import { syncPluginMcpContributions } from '../../core/plugins/PluginStore.js';

const McpSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('list_servers'),
  }).strict(),
  z.object({
    action: z.literal('list_tools'),
    server: z.string().optional().describe('可选 MCP server id 或 registry name；省略时列出全部已启用 server 的 tools'),
  }).strict(),
  z.object({
    action: z.literal('call_tool'),
    server: z.string().describe('MCP server id 或 registry name'),
    tool: z.string().describe('MCP server 暴露的 tool name'),
    arguments: z.record(z.string(), z.unknown()).default({}).describe('传给 MCP tool 的 JSON 参数'),
  }).strict(),
  z.object({
    action: z.literal('list_resources'),
    server: z.string().optional().describe('可选 MCP server id 或 registry name；省略时列出全部已启用 server 的 resources'),
  }).strict(),
  z.object({
    action: z.literal('read_resource'),
    server: z.string().describe('MCP server id 或 registry name'),
    uri: z.string().describe('MCP resource URI'),
  }).strict(),
  z.object({
    action: z.literal('list_prompts'),
    server: z.string().optional().describe('可选 MCP server id 或 registry name；省略时列出全部已启用 server 的 prompts'),
  }).strict(),
  z.object({
    action: z.literal('get_prompt'),
    server: z.string().describe('MCP server id 或 registry name'),
    name: z.string().describe('MCP prompt name'),
    arguments: z.record(z.string(), z.unknown()).default({}).describe('传给 MCP prompt 的 JSON 参数'),
  }).strict(),
  z.object({
    action: z.literal('list_resource_templates'),
    server: z.string().optional().describe('可选 MCP server id 或 registry name；省略时列出全部已启用 server 的 resource templates'),
  }).strict(),
  z.object({
    action: z.literal('capability_snapshot'),
    server: z.string().optional().describe('可选 MCP server id 或 registry name；省略时返回全部已启用 server 的 initialize capability snapshot'),
  }).strict(),
]);

function getClient(context?: ToolContext): McpClientLike {
  const injected = context?.mcpClient || context?.mcp;
  if (injected && typeof injected === 'object') {
    return injected as McpClientLike;
  }
  return getRuntimeMcpClient();
}

function formatError(error: unknown): ToolResult {
  return createToolError({
    code: 'MCP_REQUEST_FAILED',
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
    cause: error instanceof Error ? error.stack || error.message : String(error),
    fix: '先用 mcp(action="list_servers") 确认 server 已安装并启用，再用 list_tools/list_resources/list_prompts/list_resource_templates 查看真实能力和 schema。',
  });
}

export class McpTool extends Tool {
  readonly name = 'mcp';
  readonly description = '统一 MCP 入口：列出已安装 MCP servers，发现 tools/resources/prompts/resource templates，调用 MCP tools，读取 resources/prompts，并查看 server capability snapshot。MCP server 通过插件市场或 settings.mcp.servers 安装。';
  readonly parameters = McpSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof McpSchema>;
    if (!context?.mcpClient && !context?.mcp) {
      syncPluginMcpContributions(context?.workspace);
    }
    const client = getClient(context);
    try {
      switch (params.action) {
        case 'list_servers':
          return { success: true, data: client.listServers() };
        case 'list_tools':
          return { success: true, data: await client.listTools(params.server) };
        case 'call_tool':
          return { success: true, data: await client.callTool(params.server, params.tool, params.arguments) };
        case 'list_resources':
          return { success: true, data: await client.listResources(params.server) };
        case 'read_resource':
          return { success: true, data: await client.readResource(params.server, params.uri) };
        case 'list_prompts':
          return { success: true, data: await client.listPrompts(params.server) };
        case 'get_prompt':
          return { success: true, data: await client.getPrompt(params.server, params.name, params.arguments) };
        case 'list_resource_templates':
          return { success: true, data: await client.listResourceTemplates(params.server) };
        case 'capability_snapshot':
          return { success: true, data: await client.getCapabilitySnapshot(params.server) };
        default:
          return { success: false, data: null, error: 'Unknown MCP action' };
      }
    } catch (error) {
      return formatError(error);
    }
  }
}

export default McpTool;
