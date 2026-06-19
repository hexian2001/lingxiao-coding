/**
 * WikiAgentFactory — 创建 WikiAgent 实例的工厂
 *
 * 提供:
 * - 最小化的 MessageBus（Wiki Agent 无需与其他 Agent 通信）
 * - 最小化的 TokenTracker（纯内存实现）
 * - 只读工具注册表: file_read, list_dir, code_search
 * - Wiki 文档生成的系统提示词
 * - 独立 EventEmitter：wiki agent 事件不污染主 TUI
 */

import { WikiAgent } from './WikiAgent.js';
import { type TokenTracker } from '../agents/BaseAgentRuntime.js';
import { MessageBus } from '../core/MessageBus.js';
import { ToolRegistry } from '../tools/Registry.js';
import { FileReadTool } from '../tools/implementations/FileRead.js';
import { ListDirTool } from '../tools/implementations/ListDir.js';
import { CodeSearchTool } from '../tools/implementations/CodeSearchTool.js';
import { createLLMClient } from '../llm/Client.js';
import EventEmitter, {
  type EventMap,
  type EventEmitter as IEventEmitter,
} from '../core/EventEmitter.js';
import type { WikiLanguage } from './types.js';
import type { DatabaseManager } from '../core/Database.js';

/**
 * 纯内存的 TokenTracker，用于 Wiki 生成场景
 */
class WikiTokenTracker implements TokenTracker {
  private total = 0;
  private history = new Map<string, { prompt: number; completion: number; total: number }>();
  usageMap = this.history;

  addUsage(agentId: string, usage: { prompt: number; completion: number; total: number }) {
    const existing = this.history.get(agentId);
    if (existing) {
      existing.prompt += usage.prompt;
      existing.completion += usage.completion;
      existing.total += usage.total;
    } else {
      this.history.set(agentId, { ...usage });
    }
    this.total += usage.total;
  }

  getTotal() { return this.total; }
  loadHistory() {}
  getSessionTotal() { return this.total; }
}

/**
 * 创建只读工具注册表
 */
function createWikiToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new FileReadTool());
  registry.register(new ListDirTool());
  registry.register(new CodeSearchTool());
  return registry;
}

/**
 * 创建独立的 wiki EventEmitter，并把 wiki:* 事件桥接到主 emitter。
 * agent:* / leader:* / session:* 等事件被隔离，不流入主 TUI。
 */
function createIsolatedWikiEmitter(mainEmitter: IEventEmitter): IEventEmitter {
  const isolated = new EventEmitter();

  type WikiBridgeEventName =
    | 'wiki:generation_stream'
    | 'wiki:generation_progress'
    | 'wiki:generation_started'
    | 'wiki:generation_completed'
    | 'wiki:generation_failed';

  const bridgeWikiEvent = <T extends WikiBridgeEventName>(event: T) => {
    isolated.on(event, (data: EventMap[T]) => {
      mainEmitter.emit(event, data);
    });
  };

  // 只把 wiki:generation_stream / wiki:generation_progress 等事件透传给主 emitter
  const wikiEvents: readonly WikiBridgeEventName[] = [
    'wiki:generation_stream',
    'wiki:generation_progress',
    'wiki:generation_started',
    'wiki:generation_completed',
    'wiki:generation_failed',
  ];

  for (const event of wikiEvents) {
    bridgeWikiEvent(event);
  }

  return isolated;
}

/**
 * 生成 Wiki 系统提示词
 */
function getWikiSystemPrompt(lang: WikiLanguage): string {
  const langDir = lang === 'zh' ? '中文' : 'English';
  return `You are a professional technical documentation writer for software projects.
Write in ${langDir}.

You have access to tools to explore the codebase:
- file_read: Read file contents (with optional line range)
- list_dir: List directory contents
- code_search: Search code patterns with grep

Use these tools to thoroughly understand the codebase before writing documentation.
Always read relevant source files, check directory structures, and search for patterns before writing.
Ground every documentation claim in actual source code and cite the source evidence.

## Documentation format
- Use Markdown with proper headings, code blocks, and links
- Include mermaid diagrams where appropriate (architecture, flows)
- Add source file references with relative paths
- Be concise but thorough

## MANDATORY STRUCTURE

Every document MUST follow this structure:

1. **Title** — # heading matching the section title

2. **<cite> block** — At the very top (after the title), list ALL source files referenced:
<cite>
**Referenced files**
- [path/to/file.ts](file://path/to/file.ts)
</cite>

3. **Table of Contents** — A numbered ## 目录 section with anchor links to all subsequent sections

4. **Content sections** — Detailed explanations with:
   - Mermaid diagrams where appropriate (architecture, flows, dependencies)
   - Code examples with language-specific syntax highlighting
   - Per-section source annotations

5. **Source annotations** — After each major section, add:
**章节来源**
- [path/to/file.ts:10-50](file://path/to/file.ts#L10-L50)

## MERMAID DIAGRAM REQUIREMENTS

- Use \`\`\`mermaid code blocks for all diagrams
- For architecture/structure: use \`graph TB\` or \`flowchart TD\` with styled subgraphs
- For process flows: use \`sequenceDiagram\` with named participants
- For dependencies: use \`graph LR\` showing import relationships
- ALWAYS label nodes with: FileName["FileName<br/>Brief description"]
- ALWAYS wrap related nodes in subgraph blocks with descriptive names
- Include a **图表来源** annotation after each diagram listing the source files

## CODE EXAMPLES

- Use \`\`\`language code blocks with proper language tags (typescript, python, bash, etc.)
- Show real code from the source, not invented examples
- Keep snippets focused — show the essential logic, not entire files

## STYLE GUIDELINES

- Write in ${langDir}
- Use clear ## and ### headings with descriptive names
- Be specific and accurate — only describe what you can derive from the source code
- Use relative file paths for references like [src/foo.ts](file://src/foo.ts)
- Add line ranges to source annotations where possible: [file.ts:10-50](file://file.ts#L10-L50)
- Be concise but thorough — every section should add value
- Use bold for key terms, inline code for identifiers

## IMPORTANT

After you have gathered enough information using tools, write the complete Markdown document as your final output.
Return the complete Markdown document text directly in the final output.`;
}

export interface CreateWikiAgentOptions {
  projectPath: string;
  sessionId: string;
  model: string;
  lang: WikiLanguage;
  emitter: IEventEmitter;
  db: DatabaseManager;
  sectionTitle: string;
  sectionDescription: string;
  sourceFiles: string[];
  existingContent?: string;
}

/**
 * 创建 WikiAgent 实例
 *
 * 使用独立 EventEmitter 隔离 wiki agent 内部事件（agent:status 等），
 * 只把 wiki:* 事件转发给主 emitter，避免干扰主 TUI。
 */
export function createWikiAgent(options: CreateWikiAgentOptions): WikiAgent {
  const bus = new MessageBus();
  const tracker = new WikiTokenTracker();
  const toolRegistry = createWikiToolRegistry();
  const llm = createLLMClient();

  const { projectPath, sessionId, model, lang, emitter, db, sectionTitle, sectionDescription, sourceFiles, existingContent } = options;

  // 独立 emitter：wiki agent 内部事件不泄漏到主 TUI
  const isolatedEmitter = createIsolatedWikiEmitter(emitter);

  const filesList = sourceFiles.map(f => `- ${f}`).join('\n');
  const taskDescription = existingContent
    ? `Update the "${sectionTitle}" section of the wiki documentation.\n\nSection description: ${sectionDescription}\n\nSource files:\n${filesList}\n\nExisting content to update:\n${existingContent}\n\nFirst, use your tools to read the source files and understand what has changed. Then write the updated documentation.`
    : `Write the "${sectionTitle}" section of the wiki documentation.\n\nSection description: ${sectionDescription}\n\nSource files to reference:\n${filesList}\n\nFirst, use your tools to read the source files and understand the code. Then write comprehensive documentation based on what you find.`;

  return new WikiAgent({
    agentId: `wiki-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: `wiki-${sectionTitle}`,
    role: 'wiki-writer',
    systemPrompt: getWikiSystemPrompt(lang),
    toolNames: ['file_read', 'list_dir', 'code_search'],
    llmClient: llm,
    toolRegistry,
    messageBus: bus,
    tokenTracker: tracker,
    workspace: projectPath,
    sessionId,
    model,
    eventEmitter: isolatedEmitter,
    db,
    maxIterations: 15,
    maxRuntimeMinutes: 10,
  });
}
