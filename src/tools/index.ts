import { ToolRegistry } from './Registry.js';
import type { RegisteredTool } from './Registry.js';
import { config as runtimeConfig, getConfigValue, type UserToolSpec } from '../config.js';
import { buildUserTool } from './UserToolFactory.js';

// Core tools — always loaded immediately
import { FileReadTool } from './implementations/FileRead.js';
import { FileCreateTool } from './implementations/FileCreate.js';
import { ListDirTool } from './implementations/ListDir.js';
import { ShellTool } from './implementations/Shell.js';
import { CodeSearchTool } from './implementations/CodeSearchTool.js';
import { AstQueryTool } from './implementations/AstQueryTool.js';
import { SendMessageTool } from './implementations/SendMessageTool.js';
import { GlobTool } from './implementations/GlobTool.js';
import { ReadWorkNotesTool, RequestWorkNoteTool, WriteWorkNoteTool } from './implementations/WorkNoteTool.js';
import { AttemptCompletionTool } from './implementations/AttemptCompletionTool.js';
import { DeclareAssumptionTool } from './implementations/DeclareAssumptionTool.js';
import { ToolDiscoveryTool } from './implementations/ToolDiscoveryTool.js';
import { ToolPreflightTool } from './implementations/ToolPreflightTool.js';
import { ParallelReadBatchTool } from './implementations/ParallelReadBatchTool.js';
import { StructuredPatchTool } from './implementations/StructuredPatchTool.js';

// Non-core tools — can be deferred
import { PythonExecTool } from './implementations/PythonExecTool.js';
import { HttpRequestTool } from './implementations/HttpRequestTool.js';
import { MemoryTool, MemoryReadTool, MemoryWriteTool } from './implementations/MemoryTool.js';

import { SessionArtifactsTool } from './implementations/SessionArtifacts.js';
import { WebFetchTool } from './implementations/WebFetch.js';
import { WebSearchTool } from './implementations/WebSearch.js';
import { ScreenshotTool } from './implementations/ScreenshotTool.js';
import { OCRTool } from './implementations/OCRTool.js';
import { GetTerminalOutputTool } from './implementations/GetTerminalOutput.js';
import { TerminalControlTool } from './implementations/TerminalControl.js';
import { GitTool } from './implementations/GitTool.js';
import { ParseFileTool } from './implementations/ParseFileTool.js';
import { VisualContactSheetTool } from './implementations/VisualContactSheetTool.js';
import { TeamInboxTool } from './implementations/TeamInboxTool.js';
import { TeamManageTool } from './implementations/TeamManageTool.js';
import { TeamMessageTool } from './implementations/TeamMessageTool.js';
import { BrowserActionTool } from './implementations/BrowserActionTool.js';
import { BrowserVisualVerifyTool } from './implementations/BrowserVisualVerifyTool.js';
import { McpTool } from './implementations/McpTool.js';
import { NodeReplTool } from './implementations/NodeReplTool.js';
import { BlackboardTool } from './implementations/BlackboardTool.js';
import { DesignAssetTool } from './implementations/DesignAssetTool.js';
import { GenerateXlsxTool } from './implementations/GenerateXlsxTool.js';
import { EditXlsxTool } from './implementations/EditXlsxTool.js';
import { GenerateDocxTool } from './implementations/GenerateDocxTool.js';
import { EditDocxTool } from './implementations/EditDocxTool.js';
import { InspectDocxTool } from './implementations/InspectDocxTool.js';
import { GeneratePptxTool } from './implementations/GeneratePptxTool.js';
import { EditPptxTool } from './implementations/EditPptxTool.js';
import { InspectPptxTool } from './implementations/InspectPptxTool.js';
import { OfficeOpsTool } from './implementations/OfficeOpsTool.js';
import { GenerateCanvasTool } from './implementations/GenerateCanvasTool.js';
import { GenerateHtmlPresentationTool } from './implementations/GenerateHtmlPresentationTool.js';
import { GenerateHtmlDocumentTool } from './implementations/GenerateHtmlDocumentTool.js';
import { GenerateSlidevTool } from './implementations/GenerateSlidevTool.js';
import { GeneratePdfTool } from './implementations/GeneratePdfTool.js';
import { WorkflowTool } from './implementations/workflow/WorkflowTool.js';
import {
  BughuntFullScanTool,
} from './implementations/BughuntScanToolWrappers.js';
import { LspTool } from './implementations/LspTool.js';

interface ToolsConfigDto {
  user_defined?: UserToolSpec[];
  disabled_names?: string[];
}

// 非核心工具的单一事实源：tool 名 → 工厂。
// defer 与非 defer 两条路径都消费此清单，避免两份手写漂移。
// 合并说明：原 BughuntScanToolWrappers 暴露了 4 个 Tool 类（full/semgrep/tsc/npm_audit），
// 但 semgrep/tsc/npm_audit 三个子扫描器从未注册、无测试、且 bughunt_full_scan 已通过
// skip* 参数覆盖全部子扫描 —— 真正重叠的死代码，已合并删除，仅保留 full 统一入口。
type ToolFactory = () => RegisteredTool;

const NON_CORE_TOOLS: ReadonlyArray<{ name: string; factory: ToolFactory }> = Object.freeze([
  { name: 'python_exec', factory: () => new PythonExecTool() },
  { name: 'http_request', factory: () => new HttpRequestTool() },
  { name: 'memory', factory: () => new MemoryTool() },
  { name: 'memory_read', factory: () => new MemoryReadTool() },
  { name: 'memory_write', factory: () => new MemoryWriteTool() },
  { name: 'session_artifacts', factory: () => new SessionArtifactsTool() },
  { name: 'web_fetch', factory: () => new WebFetchTool() },
  { name: 'web_search', factory: () => new WebSearchTool() },
  { name: 'screenshot', factory: () => new ScreenshotTool() },
  { name: 'visual_contact_sheet', factory: () => new VisualContactSheetTool() },
  { name: 'browser_visual_verify', factory: () => new BrowserVisualVerifyTool() },
  { name: 'ocr', factory: () => new OCRTool() },
  { name: 'browser_action', factory: () => new BrowserActionTool() },
  { name: 'mcp', factory: () => new McpTool() },
  { name: 'node_repl', factory: () => new NodeReplTool() },
  { name: 'get_terminal_output', factory: () => new GetTerminalOutputTool() },
  { name: 'terminal_control', factory: () => new TerminalControlTool() },
  { name: 'git', factory: () => new GitTool() },
  { name: 'parse_file', factory: () => new ParseFileTool() },
  { name: 'team_manage', factory: () => new TeamManageTool() },
  { name: 'team_message', factory: () => new TeamMessageTool() },
  { name: 'team_inbox', factory: () => new TeamInboxTool() },
  { name: 'blackboard', factory: () => new BlackboardTool() },
  { name: 'design_asset', factory: () => new DesignAssetTool() },
  { name: 'generate_xlsx', factory: () => new GenerateXlsxTool() },
  { name: 'edit_xlsx', factory: () => new EditXlsxTool() },
  { name: 'generate_docx', factory: () => new GenerateDocxTool() },
  { name: 'edit_docx', factory: () => new EditDocxTool() },
  { name: 'inspect_docx', factory: () => new InspectDocxTool() },
  { name: 'generate_pptx', factory: () => new GeneratePptxTool() },
  { name: 'edit_pptx', factory: () => new EditPptxTool() },
  { name: 'inspect_pptx', factory: () => new InspectPptxTool() },
  { name: 'office_ops', factory: () => new OfficeOpsTool() },
  { name: 'generate_canvas', factory: () => new GenerateCanvasTool() },
  { name: 'generate_html_presentation', factory: () => new GenerateHtmlPresentationTool() },
  { name: 'generate_html_document', factory: () => new GenerateHtmlDocumentTool() },
  { name: 'generate_slidev', factory: () => new GenerateSlidevTool() },
  { name: 'generate_pdf', factory: () => new GeneratePdfTool() },
  { name: 'bughunt_full_scan', factory: () => new BughuntFullScanTool() },
  // Experimental: LSP code intelligence (LINGXIAO_EXPERIMENTAL_LSP=1)
  ...(process.env.LINGXIAO_EXPERIMENTAL_LSP === '1'
    ? [{ name: 'lsp', factory: () => new LspTool() } as { name: string; factory: ToolFactory }]
    : []),
]);

/**
 * 创建并配置工具注册表
 */
export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const deferLoading = !!getConfigValue('advanced.defer_tool_loading');

  // 核心工具 — 始终立即加载
  registry.register(new FileReadTool());
  registry.register(new FileCreateTool());
  registry.register(new StructuredPatchTool());
  registry.register(new ListDirTool());
  registry.register(new ShellTool());
  registry.register(new CodeSearchTool());
  registry.register(new AstQueryTool());
  registry.register(new SendMessageTool());
  registry.register(new GlobTool());
  registry.register(new ToolDiscoveryTool(registry));
  registry.register(new ToolPreflightTool(registry));
  registry.register(new ParallelReadBatchTool(registry));
  registry.register(new WriteWorkNoteTool());
  registry.register(new ReadWorkNotesTool());
  registry.register(new RequestWorkNoteTool());
  registry.register(new DeclareAssumptionTool());
  // 任务收尾工具 — Worker 唯一的"声明完成"入口，必须始终立即可用
  registry.register(new AttemptCompletionTool());

  // Workflow 工具 — LLM 面只暴露统一入口；原子实现由 WorkflowTool 内部委托。
  registry.register(new WorkflowTool());

  // 非核心工具 — 单一事实源驱动；defer 开关只影响立即实例化 vs 首次访问实例化。
  for (const { name, factory } of NON_CORE_TOOLS) {
    if (deferLoading) {
      registry.registerDeferred(name, factory);
    } else {
      registry.register(factory());
    }
  }

  applyUserToolsConfig(registry);

  return registry;
}

/**
 * 应用 settings.tools 配置：
 *   1. 注册启用的 user_defined 工具（同名内置自动跳过）
 *   2. 移除 disabled_names 中列出的工具（含内置）
 *
 * 由 createToolRegistry 内部调用，外部一般无需直接使用；导出便于测试。
 */
export function applyUserToolsConfig(registry: ToolRegistry): void {
  const toolsCfg: ToolsConfigDto = runtimeConfig.tools
    || { user_defined: [], disabled_names: [] };

  const userDefined = Array.isArray(toolsCfg.user_defined) ? toolsCfg.user_defined : [];
  const disabledNames = Array.isArray(toolsCfg.disabled_names) ? toolsCfg.disabled_names : [];
  const disabledSet = new Set(disabledNames);

  for (const spec of userDefined) {
    if (!spec || typeof spec !== 'object') continue;
    const name = spec.name;
    if (!name) continue;
    if (spec.enabled === false) continue;
    if (disabledSet.has(name)) continue;
    if (registry.has(name)) {
      // 与内置工具同名 → 拒绝覆盖；前端创建路径已校验，这里是防御
      continue;
    }
    try {
      registry.register(buildUserTool(spec));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[tools] user_defined tool "${name}" 注册失败，已跳过: ${reason}`);
    }
  }

  // disabled_names：内置 + 用户工具均可禁用
  for (const name of disabledNames) {
    if (registry.has(name)) {
      registry.unregister(name);
    }
  }
}

// 导出类型和基类
export { Tool } from './Tool.js';
export type { ToolContext, ToolResult } from './Tool.js';
export type { JsonSchema, ToolContract, ToolScope } from '../contracts/types/Tool.js';
export { ToolRegistry } from './Registry.js';
export { getToolRegistry } from './Registry.js';

// 导出被外部文件单独引用的工具类（非 registry 批量注册）
export { FileReadTool } from './implementations/FileRead.js';
export { FileCreateTool } from './implementations/FileCreate.js';
export { StructuredPatchTool } from './implementations/StructuredPatchTool.js';
export { ListDirTool } from './implementations/ListDir.js';
export { ShellTool } from './implementations/Shell.js';
export { CodeSearchTool } from './implementations/CodeSearchTool.js';
export { AstQueryTool } from './implementations/AstQueryTool.js';
export { WebFetchTool } from './implementations/WebFetch.js';
export { WebSearchTool } from './implementations/WebSearch.js';
export { TerminalSessionManager, getTerminalSessionManager, resetTerminalSessionManager } from './implementations/TerminalSessionManager.js';
export type { TerminalSession, TerminalSessionStatus, CreateSessionParams } from './implementations/TerminalSessionManager.js';
export { GenerateXlsxTool } from './implementations/GenerateXlsxTool.js';
export { EditXlsxTool } from './implementations/EditXlsxTool.js';
export { OfficeOpsTool } from './implementations/OfficeOpsTool.js';
export { GenerateSlidevTool } from './implementations/GenerateSlidevTool.js';
