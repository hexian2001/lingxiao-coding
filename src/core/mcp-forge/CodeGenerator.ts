/**
 * MCP Forge 代码生成器 — LLM 驱动的代码生成
 *
 * 契约: contract:mcp-forge-core v1 §3.2
 *
 * 使用凌霄 LLM 路由 (ContentGenerator) 进行需求分析和代码生成。
 * 支持从自然语言需求生成 MCP Server 代码。
 */

import type { ContentGenerator } from '../../llm/ContentGenerator.js';
import type {
  ForgeRequest,
  ForgeAnalysis,
  ForgeToolSpec,
  GeneratedCode,
  GeneratedFile,
  TemplateId,
} from './types.js';
import { TemplateLibrary } from './TemplateLibrary.js';
import { ForgeError, ForgeErrorCode } from './errors.js';
import { config as runtimeConfig } from '../../config.js';
import { contentToPlainText } from '../../llm/types.js';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs';

// ── 辅助 ──────────────────────────────────────────────────────────────────

function now(): number {
  return Date.now();
}

/** 生成 server id: 小写 + 下划线 */
function slugifyServerId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  // Ensure starts with lowercase letter, prefix 's_' if starts with digit
  if (/^\d/.test(slug)) return `s_${slug}`;
  if (slug.length < 2) return `s_${slug || 'server'}`;
  return slug.slice(0, 80);
}

function getForgeBaseDir(): string {
  return join(homedir(), '.lingxiao', 'mcp-forge', 'servers');
}

function getServerOutputDir(serverId: string): string {
  return join(getForgeBaseDir(), serverId);
}

// ── LLM Prompt 构建 ────────────────────────────────────────────────────────

function buildAnalysisSystemPrompt(): string {
  return `You are an MCP Server architect. Analyze the user's natural language requirement and produce a JSON specification for an MCP Server.

Return a JSON object with this exact structure:
{
  "templateId": "python-fastmcp-stdio" | "nodejs-stdio" | "http-api-wrapper",
  "serverName": "Human-readable server name",
  "serverId": "lowercase_with_underscores_id",
  "transport": "stdio" | "streamable-http",
  "summary": "One-sentence summary of what the server does",
  "tools": [
    {
      "name": "tool_name",
      "description": "What this tool does",
      "inputSchema": {
        "type": "object",
        "properties": { ... },
        "required": [ ... ]
      }
    }
  ],
  "resources": []
}

Rules:
- Choose "python-fastmcp-stdio" for Python-based tools, "nodejs-stdio" for JS/TS tools, "http-api-wrapper" for wrapping existing HTTP APIs.
- Use "stdio" transport for python-fastmcp-stdio and nodejs-stdio; "streamable-http" for http-api-wrapper.
- Tool names must be lowercase with underscores.
- Provide 1-5 tools that cover the user's requirements.
- Return ONLY the JSON, no markdown fences or explanation.`;
}

function buildAnalysisUserPrompt(request: ForgeRequest): string {
  const parts = [`Requirement: ${request.description}`];
  if (request.serverName) parts.push(`Preferred server name: ${request.serverName}`);
  if (request.templateId) parts.push(`Preferred template: ${request.templateId}`);
  if (request.options?.transport) parts.push(`Preferred transport: ${request.options.transport}`);
  return parts.join('\n');
}

function buildGenerationSystemPrompt(templateId: TemplateId, analysis: ForgeAnalysis): string {
  const template = TemplateLibrary.getTemplate(templateId);
  return `You are an MCP Server code generator. Generate complete, runnable server code based on the analysis specification.

Template: ${template.id} (${template.name})
Language: ${template.language}
Transport: ${template.transport}
Framework: ${template.framework}

The server must implement these tools:
${analysis.tools.map(t => `- ${t.name}: ${t.description}`).join('\n')}

Generate the code following the template structure. Use the template's framework conventions.
Return ONLY the file contents in this exact JSON format:
{
  "files": [
    { "path": "filename", "content": "file content" }
  ]
}

Rules:
- Include all necessary imports.
- Implement every tool from the analysis spec.
- Make the code production-ready and runnable.
- Do not include markdown fences in the response.
- For Python: use FastMCP decorators (@mcp.tool).
- For Node.js: use McpServer from @modelcontextprotocol/sdk.
- For HTTP wrapper: use StreamableHTTPServerTransport and expose /mcp endpoint.`;
}

function buildGenerationUserPrompt(analysis: ForgeAnalysis): string {
  return `Generate MCP Server code for:
Server: ${analysis.serverName} (id: ${analysis.serverId})
Template: ${analysis.templateId}
Transport: ${analysis.transport}

Tools to implement:
${JSON.stringify(analysis.tools, null, 2)}

${analysis.resources?.length ? `Resources:\n${JSON.stringify(analysis.resources, null, 2)}` : ''}

Summary: ${analysis.summary}`;
}

// ── JSON 提取 ──────────────────────────────────────────────────────────────

/** 从 LLM 响应中提取 JSON，处理 markdown fence 和前后文本 */
function extractJson(text: string): unknown {
  // Remove markdown code fences
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }
  // Try direct parse
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to find first { ... last }
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const jsonStr = cleaned.slice(firstBrace, lastBrace + 1);
      return JSON.parse(jsonStr);
    }
    throw new Error(`Could not extract JSON from LLM response`);
  }
}

// ── 代码生成器 ─────────────────────────────────────────────────────────────

export interface CodeGeneratorOptions {
  llmClient?: ContentGenerator;
  model?: string;
  maxTokens?: number;
}

export class CodeGenerator {
  private _llmClient: ContentGenerator | null = null;
  private _llmClientPromise: Promise<ContentGenerator> | null = null;
  private defaultModel: string;

  constructor(options: CodeGeneratorOptions) {
    if (options.llmClient) {
      this._llmClient = options.llmClient;
    }
    this.defaultModel = options.model ||
      runtimeConfig.llm?.agent_model ||
      runtimeConfig.llm?.leader_model ||
      'default';
  }

  private async getLlmClient(): Promise<ContentGenerator> {
    if (this._llmClient) return this._llmClient;
    if (!this._llmClientPromise) {
      this._llmClientPromise = createDefaultLlmClient();
    }
    this._llmClient = await this._llmClientPromise;
    return this._llmClient;
  }

  /**
   * 需求分析阶段：从自然语言需求生成 ForgeAnalysis。
   */
  async analyze(request: ForgeRequest): Promise<ForgeAnalysis> {
    const systemPrompt = buildAnalysisSystemPrompt();
    const userPrompt = buildAnalysisUserPrompt(request);

    let response;
    try {
      response = await (await this.getLlmClient()).generateContent({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        model: this.defaultModel,
        maxTokens: 4096,
        sampling: { temperature: 0.3 },
      });
    } catch (err) {
      throw new ForgeError(
        ForgeErrorCode.FORGE_LLM_UNAVAILABLE,
        `LLM call failed during analysis: ${err instanceof Error ? err.message : String(err)}`,
        { phase: 'analyzing', detail: String(err) },
      );
    }

    const responseText = contentToPlainText(response.content).trim();
    if (!responseText) {
      throw new ForgeError(
        ForgeErrorCode.FORGE_ANALYSIS_FAILED,
        'LLM returned empty response during analysis',
        { phase: 'analyzing' },
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = extractJson(responseText) as Record<string, unknown>;
    } catch {
      throw new ForgeError(
        ForgeErrorCode.FORGE_ANALYSIS_FAILED,
        'Failed to parse LLM response as JSON during analysis',
        { phase: 'analyzing', detail: responseText.slice(0, 500) },
      );
    }

    // Validate and construct ForgeAnalysis
    const templateId = parsed.templateId as TemplateId;
    if (!templateId || !['python-fastmcp-stdio', 'nodejs-stdio', 'http-api-wrapper'].includes(templateId)) {
      throw new ForgeError(
        ForgeErrorCode.FORGE_ANALYSIS_FAILED,
        `Invalid templateId in analysis result: ${templateId}`,
        { phase: 'analyzing' },
      );
    }

    const tools = Array.isArray(parsed.tools) ? (parsed.tools as ForgeToolSpec[]).map(t => ({
      name: String(t.name || ''),
      description: String(t.description || ''),
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    })) : [];

    if (tools.length === 0) {
      throw new ForgeError(
        ForgeErrorCode.FORGE_ANALYSIS_FAILED,
        'Analysis produced no tools',
        { phase: 'analyzing' },
      );
    }

    const serverName = String(parsed.serverName || request.serverName);
    const serverId = slugifyServerId(String(parsed.serverId || serverName));
    const transport = (parsed.transport as 'stdio' | 'streamable-http') ||
      (templateId === 'http-api-wrapper' ? 'streamable-http' : 'stdio');

    const analysis: ForgeAnalysis = {
      templateId,
      serverName,
      serverId,
      tools,
      resources: Array.isArray(parsed.resources) ? parsed.resources as ForgeAnalysis['resources'] : undefined,
      transport,
      summary: String(parsed.summary || `MCP Server: ${serverName}`),
      rawResponse: responseText,
    };

    return analysis;
  }

  /**
   * 代码生成阶段：从 ForgeAnalysis 生成完整项目代码。
   */
  async generate(analysis: ForgeAnalysis): Promise<GeneratedCode> {
    const template = TemplateLibrary.getTemplate(analysis.templateId);
    const outputDir = getServerOutputDir(analysis.serverId);

    // Check if dir already exists and is non-empty
    if (existsSync(outputDir) && readdirSync(outputDir).length > 0) {
      // Append timestamp to avoid conflict
      const ts = Date.now();
      const altDir = `${outputDir}_${ts}`;
      mkdirSync(altDir, { recursive: true });
      return await this.generateToDir(analysis, altDir, template.entryPoint);
    }

    mkdirSync(outputDir, { recursive: true });
    return await this.generateToDir(analysis, outputDir, template.entryPoint);
  }

  private async generateToDir(
    analysis: ForgeAnalysis,
    outputDir: string,
    entryPoint: string,
  ): Promise<GeneratedCode> {
    // Use LLM to generate code
    const systemPrompt = buildGenerationSystemPrompt(analysis.templateId, analysis);
    const userPrompt = buildGenerationUserPrompt(analysis);

    let response;
    try {
      response = await (await this.getLlmClient()).generateContent({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        model: this.defaultModel,
        maxTokens: 8192,
        sampling: { temperature: 0.2 },
      });
    } catch (err) {
      throw new ForgeError(
        ForgeErrorCode.FORGE_LLM_UNAVAILABLE,
        `LLM call failed during generation: ${err instanceof Error ? err.message : String(err)}`,
        { phase: 'generating', detail: String(err) },
      );
    }

    const responseText = contentToPlainText(response.content).trim();
    if (!responseText) {
      throw new ForgeError(
        ForgeErrorCode.FORGE_GENERATION_FAILED,
        'LLM returned empty response during generation',
        { phase: 'generating' },
      );
    }

    // Parse generated files
    let files: GeneratedFile[];
    try {
      const parsed = extractJson(responseText) as { files: GeneratedFile[] };
      if (!parsed.files || !Array.isArray(parsed.files) || parsed.files.length === 0) {
        throw new Error('No files in response');
      }
      files = parsed.files;
    } catch {
      // Fallback: use template skeleton with LLM as raw content
      // Try to extract code blocks from the response
      files = this.extractCodeBlocks(responseText, analysis.templateId);
      if (files.length === 0) {
        throw new ForgeError(
          ForgeErrorCode.FORGE_GENERATION_FAILED,
          'Failed to parse LLM response as file structure during generation',
          { phase: 'generating', detail: responseText.slice(0, 500) },
        );
      }
    }

    // Write files to output directory
    for (const file of files) {
      const filePath = join(outputDir, file.path);
      const fileDir = filePath.substring(0, filePath.lastIndexOf('/'));
      if (fileDir && !existsSync(fileDir)) {
        mkdirSync(fileDir, { recursive: true });
      }
      writeFileSync(filePath, file.content, 'utf-8');
    }

    // Write forge metadata
    const metaPath = join(outputDir, '.forge-meta.json');
    writeFileSync(metaPath, JSON.stringify({
      serverId: analysis.serverId,
      serverName: analysis.serverName,
      templateId: analysis.templateId,
      transport: analysis.transport,
      generatedAt: now(),
      tools: analysis.tools,
    }, null, 2), 'utf-8');

    const template = TemplateLibrary.getTemplate(analysis.templateId);

    return {
      files,
      outputDir,
      entryPoint,
      language: template.language,
      templateId: analysis.templateId,
    };
  }

  /**
   * 从 LLM 响应中提取代码块作为后备方案。
   */
  private extractCodeBlocks(text: string, templateId: TemplateId): GeneratedFile[] {
    const files: GeneratedFile[] = [];
    const template = TemplateLibrary.getTemplate(templateId);

    // Match ```language\n...code...\n``` or ```\n...code...\n```
    const codeBlockRegex = /```(?:\w+)?\s*\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    let index = 0;

    while ((match = codeBlockRegex.exec(text)) !== null) {
      const code = match[1].trim();
      if (!code) continue;
      // Use template file order for naming
      const templateFile = template.files[index];
      if (templateFile) {
        files.push({ path: templateFile.path, content: code });
      }
      index++;
    }

    return files;
  }
}

// ── 默认 LLM 客户端创建 ────────────────────────────────────────────────────

async function createDefaultLlmClient(): Promise<ContentGenerator> {
  // Lazy import to avoid circular dependency issues
  const { LLMClientManager } = await import('../../llm/Client.js');
  return new LLMClientManager();
}
