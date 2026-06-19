import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { unknown as unknownSchema } from 'zod';
import { config as runtimeConfig, type McpServerConfig } from '../config.js';
import { getScopedProxyFetch, withToolProxyEnv } from './ProxyConfig.js';
import { PRODUCT_NAME, VERSION } from '../version.js';

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpResourceDefinition {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

export interface McpPromptDefinition {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpResourceTemplateDefinition {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpCapabilitySnapshot {
  server: string;
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo?: Record<string, unknown>;
  schemaVersion: string;
}

export interface McpClientLike {
  listServers(): McpServerConfig[];
  listTools(serverId?: string): Promise<Array<{ server: string; tools: McpToolDefinition[] }>>;
  callTool(serverId: string, toolName: string, args?: Record<string, unknown>): Promise<unknown>;
  listResources(serverId?: string): Promise<Array<{ server: string; resources: McpResourceDefinition[] }>>;
  readResource(serverId: string, uri: string): Promise<unknown>;
  listPrompts(serverId?: string): Promise<Array<{ server: string; prompts: McpPromptDefinition[] }>>;
  getPrompt(serverId: string, name: string, args?: Record<string, unknown>): Promise<unknown>;
  listResourceTemplates(serverId?: string): Promise<Array<{ server: string; resourceTemplates: McpResourceTemplateDefinition[] }>>;
  getCapabilitySnapshot(serverId?: string): Promise<McpCapabilitySnapshot[]>;
  close(): Promise<void>;
}

// Pin the MCP protocol version we negotiate. The official SDK ships a newer
// LATEST_PROTOCOL_VERSION, but lingxiao advertises 2025-06-18 as the baseline
// for capability snapshots (servers that do not echo a version fall back here).
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

function timeoutMs(): number {
  return Math.max(1_000, Math.min(runtimeConfig.mcp?.tool_timeout_ms || 60_000, 600_000));
}

function enabledServers(): McpServerConfig[] {
  if (runtimeConfig.mcp?.enabled === false) return [];
  return (runtimeConfig.mcp?.servers || []).filter((server) => server.enabled !== false);
}

function headersFromConfig(server: McpServerConfig): Record<string, string> {
  if (server.transport === 'stdio') return {};
  const headers: Record<string, string> = {};
  for (const item of server.headers || []) {
    if (item.name) headers[item.name] = item.value;
  }
  return headers;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stableRecord(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function connectionSignature(server: McpServerConfig): string {
  if (server.transport === 'stdio') {
    return JSON.stringify({
      transport: server.transport,
      command: server.command,
      args: server.args || [],
      env: stableRecord(server.env),
      cwd: server.cwd || '',
    });
  }
  return JSON.stringify({
    transport: server.transport,
    url: server.url,
    headers: (server.headers || []).map((header) => [header.name, header.value]),
  });
}

// A single connection backed by the official @modelcontextprotocol/sdk Client.
// The SDK owns stdio framing / Streamable HTTP transport / initialize handshake
// / JSON-RPC request multiplexing / process teardown — all of which lingxiao
// previously reimplemented by hand.
class SdkConnection {
  private client: Client | null = null;
  private initializeResult: Record<string, unknown> | null = null;
  private readonly protocolVersionHint: string;

  constructor(private readonly server: McpServerConfig) {
    this.protocolVersionHint = DEFAULT_PROTOCOL_VERSION;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const client = await this.ensureConnected();
    // Cast to the SDK's JSONRPCRequest shape: RuntimeMcpClient forwards raw
    // method strings (e.g. 'tools/list'), so the params type stays loose.
    const request = {
      method,
      ...(params !== undefined ? { params: params as Record<string, unknown> } : {}),
    } as Parameters<typeof client.request>[0];
    // z.unknown() keeps the result untyped so RuntimeMcpClient can keep its
    // generic `request('tools/list', ...)` shape verbatim.
    const result = await client.request(request, unknownSchema(), { timeout: timeoutMs() });
    return result;
  }

  async getCapabilitySnapshot(): Promise<McpCapabilitySnapshot> {
    const client = await this.ensureConnected();
    return buildCapabilitySnapshot(
      this.server,
      this.initializeResult,
      client.getServerCapabilities(),
      client.getServerVersion(),
      this.protocolVersionHint,
    );
  }

  async close(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.client = null;
    this.initializeResult = null;
    // client.close() tears down the underlying transport (kills the stdio
    // child process / closes the HTTP session) and rejects in-flight requests.
    await client.close().catch(() => undefined);
  }

  private ensureConnected(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    return this.connect();
  }

  private async connect(): Promise<Client> {
    const transport = this.server.transport === 'stdio'
      ? this.buildStdioTransport(this.server)
      : this.buildHttpTransport(this.server);

    const client = new Client(
      { name: PRODUCT_NAME, version: VERSION },
      { capabilities: {} },
    );

    // client.connect() performs the full MCP handshake: transport start,
    // initialize request, capabilities/serverInfo capture and the
    // notifications/initialized ack. The negotiated capabilities/serverInfo are
    // surfaced via getServerCapabilities()/getServerVersion() below.
    await client.connect(transport);
    this.client = client;
    // initializeResult is retained for snapshot fallback parity with the prior
    // hand-rolled implementation; the SDK getters remain the primary source.
    this.initializeResult = {
      protocolVersion: this.protocolVersionHint,
      capabilities: client.getServerCapabilities() ?? {},
      serverInfo: client.getServerVersion() ?? undefined,
    };
    return client;
  }

  private buildStdioTransport(server: Extract<McpServerConfig, { transport: 'stdio' }>): StdioClientTransport {
    // Merge the tool-scope proxy env on top of the server-configured env so the
    // spawned child process inherits the same proxy resolution as the rest of
    // lingxiao. The SDK merges its own default env underneath what we pass.
    const env = withToolProxyEnv({
      ...process.env,
      ...(server.env || {}),
    });
    return new StdioClientTransport({
      command: server.command,
      args: server.args || [],
      env: env as Record<string, string>,
      cwd: server.cwd || process.cwd(),
      stderr: 'pipe',
    });
  }

  private buildHttpTransport(server: Extract<McpServerConfig, { transport: 'streamable-http' }>): StreamableHTTPClientTransport {
    const scopedFetch = getScopedProxyFetch('tools');
    const headers = headersFromConfig(server);
    const options: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {};
    if (scopedFetch) {
      // The tool-scope proxy fetch (undici-backed) is structurally compatible
      // with the SDK's FetchLike: (url, init) => Promise<Response>.
      options.fetch = scopedFetch as unknown as NonNullable<typeof options.fetch>;
    }
    if (Object.keys(headers).length > 0) {
      options.requestInit = { headers };
    }
    return new StreamableHTTPClientTransport(new URL(server.url), options);
  }
}

function buildCapabilitySnapshot(
  server: McpServerConfig,
  initializeResult: Record<string, unknown> | null,
  capabilities: Record<string, unknown> | undefined,
  serverInfo: Record<string, unknown> | undefined,
  fallbackProtocolVersion: string,
): McpCapabilitySnapshot {
  const protocolVersion = typeof initializeResult?.protocolVersion === 'string'
    ? initializeResult.protocolVersion
    : fallbackProtocolVersion;
  return {
    server: server.id,
    protocolVersion,
    capabilities: capabilities ? asRecord(capabilities) : asRecord(initializeResult?.capabilities),
    serverInfo: Object.keys(asRecord(serverInfo ?? initializeResult?.serverInfo)).length > 0
      ? asRecord(serverInfo ?? initializeResult?.serverInfo)
      : undefined,
    schemaVersion: server.registry?.version || protocolVersion,
  };
}

export class RuntimeMcpClient implements McpClientLike {
  private connections = new Map<string, { signature: string; connection: SdkConnection }>();

  listServers(): McpServerConfig[] {
    return enabledServers();
  }

  async listTools(serverId?: string): Promise<Array<{ server: string; tools: McpToolDefinition[] }>> {
    const servers = this.selectServers(serverId);
    const output: Array<{ server: string; tools: McpToolDefinition[] }> = [];
    for (const server of servers) {
      const result = asRecord(await this.connection(server).request('tools/list'));
      const tools = Array.isArray(result.tools) ? result.tools as McpToolDefinition[] : [];
      output.push({ server: server.id, tools });
    }
    return output;
  }

  async callTool(serverId: string, toolName: string, args?: Record<string, unknown>): Promise<unknown> {
    const server = this.requireServer(serverId);
    return await this.connection(server).request('tools/call', {
      name: toolName,
      arguments: args || {},
    });
  }

  async listResources(serverId?: string): Promise<Array<{ server: string; resources: McpResourceDefinition[] }>> {
    const servers = this.selectServers(serverId);
    const output: Array<{ server: string; resources: McpResourceDefinition[] }> = [];
    for (const server of servers) {
      const result = asRecord(await this.connection(server).request('resources/list'));
      const resources = Array.isArray(result.resources) ? result.resources as McpResourceDefinition[] : [];
      output.push({ server: server.id, resources });
    }
    return output;
  }

  async readResource(serverId: string, uri: string): Promise<unknown> {
    const server = this.requireServer(serverId);
    return await this.connection(server).request('resources/read', { uri });
  }

  async listPrompts(serverId?: string): Promise<Array<{ server: string; prompts: McpPromptDefinition[] }>> {
    const servers = this.selectServers(serverId);
    const output: Array<{ server: string; prompts: McpPromptDefinition[] }> = [];
    for (const server of servers) {
      const result = asRecord(await this.connection(server).request('prompts/list'));
      const prompts = Array.isArray(result.prompts) ? result.prompts as McpPromptDefinition[] : [];
      output.push({ server: server.id, prompts });
    }
    return output;
  }

  async getPrompt(serverId: string, name: string, args?: Record<string, unknown>): Promise<unknown> {
    const server = this.requireServer(serverId);
    return await this.connection(server).request('prompts/get', {
      name,
      arguments: args || {},
    });
  }

  async listResourceTemplates(serverId?: string): Promise<Array<{ server: string; resourceTemplates: McpResourceTemplateDefinition[] }>> {
    const servers = this.selectServers(serverId);
    const output: Array<{ server: string; resourceTemplates: McpResourceTemplateDefinition[] }> = [];
    for (const server of servers) {
      const result = asRecord(await this.connection(server).request('resources/templates/list'));
      const resourceTemplates = Array.isArray(result.resourceTemplates)
        ? result.resourceTemplates as McpResourceTemplateDefinition[]
        : [];
      output.push({ server: server.id, resourceTemplates });
    }
    return output;
  }

  async getCapabilitySnapshot(serverId?: string): Promise<McpCapabilitySnapshot[]> {
    const servers = this.selectServers(serverId);
    const output: McpCapabilitySnapshot[] = [];
    for (const server of servers) {
      output.push(await this.connection(server).getCapabilitySnapshot());
    }
    return output;
  }

  async close(): Promise<void> {
    const closing = Array.from(this.connections.values()).map((entry) => entry.connection.close());
    this.connections.clear();
    await Promise.allSettled(closing);
  }

  private selectServers(serverId?: string): McpServerConfig[] {
    if (!serverId) return this.listServers();
    return [this.requireServer(serverId)];
  }

  private requireServer(serverId: string): McpServerConfig {
    const server = this.listServers().find((item) => item.id === serverId || item.name === serverId);
    if (!server) throw new Error(`MCP server is not installed or enabled: ${serverId}`);
    return server;
  }

  private connection(server: McpServerConfig): SdkConnection {
    const signature = connectionSignature(server);
    const existing = this.connections.get(server.id);
    if (existing && existing.signature === signature) return existing.connection;
    if (existing) {
      void existing.connection.close().catch(() => undefined);
    }
    const connection = new SdkConnection(server);
    this.connections.set(server.id, { signature, connection });
    return connection;
  }
}

let sharedClient: RuntimeMcpClient | null = null;

export function getRuntimeMcpClient(): RuntimeMcpClient {
  sharedClient ||= new RuntimeMcpClient();
  return sharedClient;
}

export async function resetRuntimeMcpClient(): Promise<void> {
  const client = sharedClient;
  sharedClient = null;
  if (client) await client.close();
}
