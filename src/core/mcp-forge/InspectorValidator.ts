/**
 * MCP Forge Inspector 验证器 — MCP Inspector 自动验证
 *
 * 契约: contract:mcp-forge-core v1 §3.4
 *
 * 用 MCP SDK Client 对生成的 server 做 tools/list + tools/call 验证。
 * 启动 server 子进程 → 连接 MCP Client → list tools → call each tool → 汇总结果。
 */

import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import type {
  GeneratedCode,
  ValidationResult,
  InspectorToolResult,
  ForgeAnalysis,
} from './types.js';
import { ForgeError, ForgeErrorCode } from './errors.js';

// ── 动态导入 MCP SDK ──────────────────────────────────────────────────────

interface McpClientLike {
  close(): Promise<void>;
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export interface InspectorOptions {
  timeoutMs?: number;
  customEnv?: Record<string, string>;
  /** HTTP port for streamable-http servers */
  httpPort?: number;
}

export class InspectorValidator {
  /**
   * 启动生成的 server 并验证 tools/list + tools/call。
   */
  static async validate(
    code: GeneratedCode,
    analysis: ForgeAnalysis,
    options: InspectorOptions = {},
  ): Promise<ValidationResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    const warnings: string[] = [];
    const timeoutMs = options.timeoutMs ?? 30000;

    let serverProcess: ChildProcess | null = null;
    let mcpClient: McpClientLike | null = null;

    try {
      // 1. Start the server process
      const serverStartResult = await InspectorValidator.startServer(code, options);
      serverProcess = serverStartResult.process;

      if (!serverProcess || serverProcess.killed) {
        errors.push('Server process failed to start');
        return {
          sandboxCompiled: true,
          sandboxStarted: false,
          inspectorConnected: false,
          toolsDiscovered: [],
          errors,
          warnings,
          duration: Date.now() - startTime,
        };
      }

      // 2. Connect MCP Client
      try {
        mcpClient = await InspectorValidator.connectClient(code, serverStartResult, options);
      } catch (err) {
        errors.push(`Inspector connection failed: ${err instanceof Error ? err.message : String(err)}`);
        return {
          sandboxCompiled: true,
          sandboxStarted: true,
          inspectorConnected: false,
          toolsDiscovered: [],
          errors,
          warnings,
          duration: Date.now() - startTime,
        };
      }

      // 3. List tools
      let discoveredTools: McpToolInfo[] = [];
      try {
        discoveredTools = await InspectorValidator.listTools(mcpClient, code);
      } catch (err) {
        errors.push(`tools/list failed: ${err instanceof Error ? err.message : String(err)}`);
        return {
          sandboxCompiled: true,
          sandboxStarted: true,
          inspectorConnected: true,
          toolsDiscovered: [],
          errors,
          warnings,
          duration: Date.now() - startTime,
        };
      }

      // 4. Call each tool with empty/minimal args
      const toolResults: InspectorToolResult[] = [];
      for (const tool of discoveredTools) {
        const result = await InspectorValidator.callTool(mcpClient, code, tool.name, {});
        toolResults.push({
          name: tool.name,
          description: tool.description,
          callSuccess: result.success,
          callResult: result.result,
          callError: result.error,
        });
        if (!result.success) {
          warnings.push(`Tool '${tool.name}' call returned error: ${result.error}`);
        }
      }

      // 5. Verify expected tools are present
      const expectedToolNames = analysis.tools.map(t => t.name);
      const actualToolNames = discoveredTools.map(t => t.name);
      const missingTools = expectedToolNames.filter(name => !actualToolNames.includes(name));
      if (missingTools.length > 0) {
        warnings.push(`Missing expected tools: ${missingTools.join(', ')}`);
      }

      const allToolsCalled = toolResults.length > 0 && toolResults.every(t => t.callSuccess);

      return {
        sandboxCompiled: true,
        sandboxStarted: true,
        inspectorConnected: true,
        toolsDiscovered: toolResults,
        errors,
        warnings,
        duration: Date.now() - startTime,
      };
    } finally {
      // Cleanup: close client and kill server
      if (mcpClient) {
        try { await mcpClient.close(); } catch { /* ignore */ }
      }
      if (serverProcess && !serverProcess.killed) {
        try {
          serverProcess.kill('SIGTERM');
          setTimeout(() => {
            try { serverProcess?.kill('SIGKILL'); } catch { /* ignore */ }
          }, 2000);
        } catch { /* ignore */ }
      }
    }
  }

  // ── Server 启动 ────────────────────────────────────────────────────────

  private static async startServer(
    code: GeneratedCode,
    options: InspectorOptions,
  ): Promise<{ process: ChildProcess; port?: number }> {
    const cwd = code.outputDir;
    let command: string;
    let args: string[];
    const env = { ...process.env, ...(options.customEnv || {}) };

    if (code.language === 'python') {
      command = 'python3';
      args = [code.entryPoint];
    } else {
      // Ensure node_modules exist
      if (!existsSync(join(cwd, 'node_modules'))) {
        // Inline npm install
        const { SandboxRunner } = await import('./SandboxRunner.js');
        await SandboxRunner.run({ ...code, outputDir: cwd }, { timeoutMs: 120000 });
      }
      command = 'node';
      args = [code.entryPoint];
    }

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Wait for server to be ready (check stderr for startup messages or just wait)
    await new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(undefined);
        }
      }, 3000);

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        // Many servers print a "listening" message
        if (!settled && (text.includes('listening') || text.includes('ready') || text.includes('started'))) {
          settled = true;
          clearTimeout(timer);
          resolve(undefined);
        }
      });

      child.on('error', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(undefined);
        }
      });

      child.on('exit', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(undefined);
        }
      });
    });

    return { process: child };
  }

  // ── MCP Client 连接 ────────────────────────────────────────────────────

  private static async connectClient(
    code: GeneratedCode,
    serverInfo: { process: ChildProcess; port?: number },
    options: InspectorOptions,
  ): Promise<McpClientLike> {
    // Dynamically import MCP SDK
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');

    if (code.language === 'python' || code.templateId === 'nodejs-stdio') {
      // stdio transport — connect to the server's stdio
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

      // The server process is already started with stdio
      // We need to create a new connection via stdio transport
      // Since we can't easily attach to existing process's stdio,
      // we'll spawn a new process for the client connection
      const command = code.language === 'python' ? 'python3' : 'node';
      const args = [code.entryPoint];
      const cwd = code.outputDir;

      const transport = new StdioClientTransport({
        command,
        args,
        cwd,
        env: { ...process.env, ...(options.customEnv || {}) } as Record<string, string>,
      });

      const client = new Client(
        { name: 'lingxiao-forge-inspector', version: '1.0.0' },
        { capabilities: {} },
      );

      await client.connect(transport);
      return client as unknown as McpClientLike;
    } else {
      // HTTP transport
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      );

      const port = options.httpPort || 3000;
      const url = new URL(`http://localhost:${port}/mcp`);

      const transport = new StreamableHTTPClientTransport(url);
      const client = new Client(
        { name: 'lingxiao-forge-inspector', version: '1.0.0' },
        { capabilities: {} },
      );

      await client.connect(transport);
      return client as unknown as McpClientLike;
    }
  }

  // ── tools/list ─────────────────────────────────────────────────────────

  private static async listTools(
    client: McpClientLike,
    code: GeneratedCode,
  ): Promise<McpToolInfo[]> {
    // Use dynamic method call since we imported Client dynamically
    const anyClient = client as unknown as {
      listTools(): Promise<{ tools: McpToolInfo[] }>;
    };
    const result = await anyClient.listTools();
    return result.tools || [];
  }

  // ── tools/call ─────────────────────────────────────────────────────────

  private static async callTool(
    client: McpClientLike,
    code: GeneratedCode,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; result?: string; error?: string }> {
    try {
      const anyClient = client as unknown as {
        callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<McpCallResult>;
      };
      const result = await anyClient.callTool({ name: toolName, arguments: args });

      if (result.isError) {
        const text = result.content?.map(c => c.text || '').join('\n') || '';
        return { success: false, error: text || 'Tool returned error' };
      }

      const text = result.content?.map(c => c.text || '').join('\n') || '';
      return { success: true, result: text };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
