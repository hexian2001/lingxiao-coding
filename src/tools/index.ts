import { ToolRegistry } from './Registry.js';
import type { RegisteredTool } from './Registry.js';
import { config as runtimeConfig, getConfigValue, type UserToolSpec } from '../config.js';
import { buildUserTool } from './UserToolFactory.js';
import { LazyToolProxy, objectSchema } from './LazyToolProxy.js';
import { coreLogger } from '../core/Log.js';

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

// Non-core tools — can be deferred.  Heavy optional tools are registered via
// LazyToolProxy below so importing this barrel does not eagerly load Playwright,
// tesseract, sharp, JSZip, docx/pptx/xlsx parsers or other heavy optional runtimes.
import { PythonExecTool } from './implementations/PythonExecTool.js';
import { HttpRequestTool } from './implementations/HttpRequestTool.js';
import { MemoryTool, MemoryReadTool, MemoryWriteTool } from './implementations/MemoryTool.js';

import { SessionArtifactsTool } from './implementations/SessionArtifacts.js';
import { WebFetchTool } from './implementations/WebFetch.js';
import { WebSearchTool } from './implementations/WebSearch.js';
import { GetTerminalOutputTool } from './implementations/GetTerminalOutput.js';
import { TerminalControlTool } from './implementations/TerminalControl.js';
import { GitTool } from './implementations/GitTool.js';
import { TeamInboxTool } from './implementations/TeamInboxTool.js';
import { TeamManageTool } from './implementations/TeamManageTool.js';
import { TeamMessageTool } from './implementations/TeamMessageTool.js';
import { NodeReplTool } from './implementations/NodeReplTool.js';
import { BlackboardTool } from './implementations/BlackboardTool.js';
import { DesignAssetTool } from './implementations/DesignAssetTool.js';

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

type LazyToolClassModule = Record<string, unknown> & { default?: unknown };

type LazyToolSpec = {
  name: string;
  description: string;
  modulePath: string;
  exportName?: string;
  schema?: ReturnType<typeof objectSchema>;
};

const stringProp = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) });
const numberProp = (description?: string) => ({ type: 'number', ...(description ? { description } : {}) });
const booleanProp = (description?: string) => ({ type: 'boolean', ...(description ? { description } : {}) });
const arrayProp = (items: Record<string, unknown> = {}, description?: string) => ({ type: 'array', items, ...(description ? { description } : {}) });
const enumProp = (values: string[], description?: string) => ({ enum: values, ...(description ? { description } : {}) });

function lazyTool(spec: LazyToolSpec): RegisteredTool {
  return new LazyToolProxy({
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    loader: async () => {
      const moduleValue = await import(spec.modulePath) as LazyToolClassModule;
      const ctor = spec.exportName ? moduleValue[spec.exportName] : moduleValue.default;
      if (typeof ctor !== 'function') {
        throw new Error(`Lazy tool module ${spec.modulePath} did not export ${spec.exportName ?? 'default'}`);
      }
      return new (ctor as new () => RegisteredTool)();
    },
  });
}

const NON_CORE_TOOLS: ReadonlyArray<{ name: string; factory: ToolFactory }> = Object.freeze([
  { name: 'python_exec', factory: () => new PythonExecTool() },
  { name: 'http_request', factory: () => new HttpRequestTool() },
  { name: 'memory', factory: () => new MemoryTool() },
  { name: 'memory_read', factory: () => new MemoryReadTool() },
  { name: 'memory_write', factory: () => new MemoryWriteTool() },
  { name: 'session_artifacts', factory: () => new SessionArtifactsTool() },
  { name: 'web_fetch', factory: () => new WebFetchTool() },
  { name: 'web_search', factory: () => new WebSearchTool() },
  { name: 'screenshot', factory: () => lazyTool({
    name: 'screenshot',
    description: '对网页截图。vision 模型直接以图像形式返回；非 vision 模型自动 OCR 为文字。图片始终保存到磁盘并返回路径',
    modulePath: './implementations/ScreenshotTool.js',
    schema: objectSchema({
      url: stringProp('要截图的网页 URL'),
      full_page: booleanProp('是否截取完整页面'),
      format: enumProp(['png', 'jpeg'], '图片格式'),
      quality: numberProp('jpeg 质量'),
      screenshot_path: stringProp('截图保存路径'),
    }, ['url']),
  }) },
  { name: 'visual_contact_sheet', factory: () => lazyTool({
    name: 'visual_contact_sheet',
    description: '把一组 PC 截图或图片拼成带标签的总览拼图，用于快速比较页面、主题、状态和视觉层级。',
    modulePath: './implementations/VisualContactSheetTool.js',
    schema: objectSchema({
      images: arrayProp({}, '要拼接的图片路径列表'),
      directory: stringProp('从目录读取图片'),
      pattern: stringProp('directory 模式下的 glob pattern'),
      recursive: booleanProp('是否递归读取子目录'),
      output_path: stringProp('输出 PNG 路径'),
      columns: numberProp('列数'),
      return_image: booleanProp('vision 模型下是否同时返回拼图图片内容'),
    }),
  }) },
  { name: 'browser_visual_verify', factory: () => lazyTool({
    name: 'browser_visual_verify',
    description: '浏览器视觉验收：打开页面、设置视口、检查文本/selector、保存截图，并返回页面标题、尺寸和失败断言。',
    modulePath: './implementations/BrowserVisualVerifyTool.js',
    schema: objectSchema({
      url: stringProp('要打开并验证的 URL'),
      wait_until: enumProp(['load', 'domcontentloaded', 'networkidle'], '等待事件'),
      viewport: { type: 'object', additionalProperties: true },
      assertions: { type: 'object', additionalProperties: true },
      screenshot_path: stringProp('截图输出路径'),
      full_page: booleanProp('是否截取完整页面'),
    }, ['url']),
  }) },
  { name: 'ocr', factory: () => lazyTool({
    name: 'ocr',
    description: '使用本地 OCR 引擎从图片中提取文字。支持中文简体 + 英文识别，无需外部 API Key。',
    modulePath: './implementations/OCRTool.js',
    schema: objectSchema({
      image: stringProp('图片来源：本地文件路径、URL 或 base64 data URI'),
      languages: arrayProp({ type: 'string' }, '识别语言列表'),
      from: enumProp(['file', 'url', 'base64'], '图片来源类型'),
    }, ['image']),
  }) },
  { name: 'browser_action', factory: () => lazyTool({
    name: 'browser_action',
    description: '在真实浏览器中执行交互操作：导航、点击、填写表单、等待元素、读取文本、执行 JS。',
    modulePath: './implementations/BrowserActionTool.js',
    schema: objectSchema({
      action: stringProp('操作类型'),
      launch: booleanProp('check 时是否实际尝试启动浏览器'),
      url: stringProp('navigate 时要导航到的 URL'),
      selector: stringProp('CSS 选择器或 text=文本选择器'),
      value: stringProp('fill/select 时要填写或选择的值'),
      script: stringProp('eval_js 时执行的 JavaScript'),
      timeout: numberProp('等待超时 ms'),
    }, ['action']),
  }) },
  { name: 'mcp', factory: () => lazyTool({
    name: 'mcp',
    description: '统一 MCP 入口：列出 server/tools/resources/prompts，调用 MCP tools，读取 resources/prompts，并查看 server capability snapshot。',
    modulePath: './implementations/McpTool.js',
    schema: objectSchema({
      action: enumProp(['list_servers', 'list_tools', 'call_tool', 'list_resources', 'read_resource', 'list_prompts', 'get_prompt', 'list_resource_templates', 'capability_snapshot'], 'MCP action'),
      server: stringProp('MCP server id 或 registry name'),
      tool: stringProp('MCP server 暴露的 tool name'),
      uri: stringProp('MCP resource URI'),
      name: stringProp('MCP prompt name'),
      arguments: { type: 'object', additionalProperties: true },
    }, ['action']),
  }) },
  { name: 'node_repl', factory: () => new NodeReplTool() },
  { name: 'get_terminal_output', factory: () => new GetTerminalOutputTool() },
  { name: 'terminal_control', factory: () => new TerminalControlTool() },
  { name: 'git', factory: () => new GitTool() },
  { name: 'parse_file', factory: () => lazyTool({
    name: 'parse_file',
    description: '解析文件内容，支持 PDF/Word/Excel/CSV/PowerPoint/ZIP 等格式。可分页/分 sheet 提取。',
    modulePath: './implementations/ParseFileTool.js',
    schema: objectSchema({
      path: stringProp('文件路径'),
      mode: enumProp(['preview', 'full', 'page', 'sheet'], '解析模式'),
      page: numberProp('页码'),
      sheet: stringProp('工作表名称'),
    }, ['path']),
  }) },
  { name: 'team_manage', factory: () => new TeamManageTool() },
  { name: 'team_message', factory: () => new TeamMessageTool() },
  { name: 'team_inbox', factory: () => new TeamInboxTool() },
  { name: 'blackboard', factory: () => new BlackboardTool() },
  { name: 'design_asset', factory: () => new DesignAssetTool() },
  { name: 'office_ops', factory: () => lazyTool({
    name: 'office_ops',
    description: 'Office 辅助操作入口：缩略图、PDF 渲染、资产检索和渲染 QA 等。',
    modulePath: './implementations/OfficeOpsTool.js',
    schema: objectSchema({ action: stringProp('操作类型') }, ['action']),
  }) },
  { name: 'bughunt_full_scan', factory: () => lazyTool({
    name: 'bughunt_full_scan',
    description: '运行综合 bughunt 扫描入口。',
    modulePath: './implementations/BughuntScanToolWrappers.js',
    exportName: 'BughuntFullScanTool',
  }) },
  // Experimental: LSP code intelligence (LINGXIAO_EXPERIMENTAL_LSP=1)
  ...(process.env.LINGXIAO_EXPERIMENTAL_LSP === '1'
    ? [{ name: 'lsp', factory: () => lazyTool({ name: 'lsp', description: 'Experimental LSP code intelligence tool.', modulePath: './implementations/LspTool.js', exportName: 'LspTool' }) } as { name: string; factory: ToolFactory }]
    : []),
]);

type BuiltinToolSpec = {
  name: string;
  factory: ToolFactory;
  deferable?: boolean;
};

interface ToolRegistryApplyResult {
  registeredUserTools: string[];
  removedUserTools: string[];
  removedDisabledTools: string[];
  skippedUserTools: string[];
  changedNames: string[];
}

export interface ToolRegistryReconcileResult extends ToolRegistryApplyResult {
  restoredBuiltinTools: string[];
  changed: boolean;
}

const appliedUserToolNames = new WeakMap<ToolRegistry, Set<string>>();

function getToolsConfig(): ToolsConfigDto {
  return runtimeConfig.tools || { user_defined: [], disabled_names: [] };
}

function buildBuiltinToolSpecs(registry: ToolRegistry): BuiltinToolSpec[] {
  return [
    { name: 'file_read', factory: () => new FileReadTool() },
    { name: 'file_create', factory: () => new FileCreateTool() },
    { name: 'structured_patch', factory: () => new StructuredPatchTool() },
    { name: 'list_dir', factory: () => new ListDirTool() },
    { name: 'shell', factory: () => new ShellTool() },
    { name: 'code_search', factory: () => new CodeSearchTool() },
    { name: 'ast_query', factory: () => new AstQueryTool() },
    { name: 'send_message', factory: () => new SendMessageTool() },
    { name: 'glob', factory: () => new GlobTool() },
    { name: 'find_tools', factory: () => new ToolDiscoveryTool(registry) },
    { name: 'tool_preflight', factory: () => new ToolPreflightTool(registry) },
    { name: 'parallel_read_batch', factory: () => new ParallelReadBatchTool(registry) },
    { name: 'write_work_note', factory: () => new WriteWorkNoteTool() },
    { name: 'read_work_notes', factory: () => new ReadWorkNotesTool() },
    { name: 'request_work_note', factory: () => new RequestWorkNoteTool() },
    { name: 'declare_assumption', factory: () => new DeclareAssumptionTool() },
    { name: 'attempt_completion', factory: () => new AttemptCompletionTool() },
    { name: 'workflow', factory: () => lazyTool({
      name: 'workflow',
      description: 'Workflow 统一入口：优先用 action=apply 一次性提交完整 DAG DSL；也支持 create/add_node/connect/execute/get_status/inspect/validate/audit。',
      modulePath: './implementations/workflow/WorkflowTool.js',
      schema: objectSchema({
        action: enumProp(['create', 'apply', 'audit', 'add_node', 'connect', 'execute', 'get_status', 'inspect', 'validate'], 'Workflow action to run.'),
        workflow_id: stringProp('Existing workflow id'),
        execution_id: stringProp('Workflow execution id'),
        name: stringProp('Workflow name'),
      }, ['action']),
    }) },
    ...NON_CORE_TOOLS.map((tool) => ({ ...tool, deferable: true })),
  ];
}

function registerBuiltinTool(registry: ToolRegistry, spec: BuiltinToolSpec, deferLoading: boolean): void {
  if (spec.deferable && deferLoading) {
    registry.registerDeferred(spec.name, spec.factory);
  } else {
    registry.register(spec.factory());
  }
}

function registerBuiltinTools(registry: ToolRegistry, deferLoading: boolean, disabledSet = new Set<string>()): string[] {
  const registered: string[] = [];
  for (const spec of buildBuiltinToolSpecs(registry)) {
    if (disabledSet.has(spec.name)) continue;
    registerBuiltinTool(registry, spec, deferLoading);
    registered.push(spec.name);
  }
  return registered;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}


/**
 * 创建并配置工具注册表
 */
export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const deferLoading = !!getConfigValue('advanced.defer_tool_loading');

  registerBuiltinTools(registry, deferLoading);
  applyUserToolsConfig(registry);

  return registry;
}

/**
 * 应用 settings.tools 配置：
 *   1. 注册/更新启用的 user_defined 工具（同名内置自动跳过）
 *   2. 移除已从配置删除或被禁用的 user_defined 工具
 *   3. 移除 disabled_names 中列出的工具（含内置）
 *
 * 由 createToolRegistry/reconcileToolRegistryFromConfig 调用；返回变更摘要便于热加载广播。
 */
export function applyUserToolsConfig(registry: ToolRegistry): ToolRegistryApplyResult {
  const toolsCfg = getToolsConfig();
  const userDefined = Array.isArray(toolsCfg.user_defined) ? toolsCfg.user_defined : [];
  const disabledNames = Array.isArray(toolsCfg.disabled_names) ? toolsCfg.disabled_names : [];
  const disabledSet = new Set(disabledNames);
  const builtinNames = new Set(buildBuiltinToolSpecs(registry).map((spec) => spec.name));
  const previousUserNames = appliedUserToolNames.get(registry) ?? new Set<string>();
  const desiredUserNames = new Set<string>();
  const registeredUserTools: string[] = [];
  const removedUserTools: string[] = [];
  const removedDisabledTools: string[] = [];
  const skippedUserTools: string[] = [];

  const desiredSpecs = userDefined.filter((spec): spec is UserToolSpec => {
    if (!spec || typeof spec !== 'object' || !spec.name) return false;
    if (spec.enabled === false || disabledSet.has(spec.name)) return false;
    if (builtinNames.has(spec.name)) {
      skippedUserTools.push(spec.name);
      return false;
    }
    desiredUserNames.add(spec.name);
    return true;
  });

  for (const name of previousUserNames) {
    if (!desiredUserNames.has(name) && registry.unregister(name)) {
      removedUserTools.push(name);
    }
  }

  const nextUserNames = new Set<string>();
  for (const spec of desiredSpecs) {
    const name = spec.name;
    // 用户工具是配置驱动的无状态 wrapper，热加载时直接替换，保证 shell/http/python 模板更新立刻生效。
    if (previousUserNames.has(name) && registry.has(name)) {
      registry.unregister(name);
    }
    if (registry.has(name)) {
      // 防御：避免覆盖非本轮配置管理的工具（例如 Leader meta/plugin runtime 注入）。
      skippedUserTools.push(name);
      continue;
    }
    try {
      registry.register(buildUserTool(spec));
      registeredUserTools.push(name);
      nextUserNames.add(name);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      skippedUserTools.push(name);
      coreLogger.warn(`[tools] user_defined tool "${name}" 注册失败，已跳过: ${reason}`);
    }
  }

  appliedUserToolNames.set(registry, nextUserNames);

  // disabled_names：内置 + 用户工具均可禁用
  for (const name of disabledNames) {
    if (registry.unregister(name)) {
      removedDisabledTools.push(name);
    }
  }

  const changedNames = unique([...registeredUserTools, ...removedUserTools, ...removedDisabledTools]);
  return { registeredUserTools, removedUserTools, removedDisabledTools, skippedUserTools, changedNames };
}

/**
 * Reconcile an existing registry after settings.json hot reload without rebuilding
 * stateful tool instances.  This restores newly un-disabled builtins, applies
 * user_defined changes, and removes disabled tools while preserving active tool
 * state for tools that are still enabled.
 */
export function reconcileToolRegistryFromConfig(registry: ToolRegistry): ToolRegistryReconcileResult {
  const deferLoading = !!getConfigValue('advanced.defer_tool_loading');
  const toolsCfg = getToolsConfig();
  const disabledSet = new Set(Array.isArray(toolsCfg.disabled_names) ? toolsCfg.disabled_names : []);
  const restoredBuiltinTools: string[] = [];

  for (const spec of buildBuiltinToolSpecs(registry)) {
    if (disabledSet.has(spec.name) || registry.has(spec.name)) continue;
    registerBuiltinTool(registry, spec, deferLoading);
    restoredBuiltinTools.push(spec.name);
  }

  const applied = applyUserToolsConfig(registry);
  const changedNames = unique([...restoredBuiltinTools, ...applied.changedNames]);
  return {
    ...applied,
    restoredBuiltinTools,
    changedNames,
    changed: changedNames.length > 0,
  };
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
// Heavy optional tool classes are intentionally not re-exported from this barrel:
// importing them here would defeat module-level lazy loading.  Use direct
// implementation imports in tests/tools that explicitly need the concrete class.
