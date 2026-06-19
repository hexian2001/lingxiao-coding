import { bullets, paragraphLines, section } from './prompt_builder.js';
import { platform as getOsPlatform, arch as getOsArch } from 'os';
import { Workspace } from '../../../core/Workspace.js';
import { buildLocalLlmGatewayPromptSection } from '../../../core/LocalLlmGateway.js';
import { getPromptCatalog, type PromptLocale } from '../i18n/catalog.js';

/** 人类可读的平台标签 + shell 提示，注入到 session scope 让 Agent 感知运行环境 */
function getPlatformHint(): { label: string; shellHint: string } {
  const p = getOsPlatform();
  const a = getOsArch();
  if (p === 'win32') return { label: `Windows/${a}`, shellHint: 'cmd/PowerShell' };
  if (p === 'darwin') return { label: `macOS/${a}`, shellHint: 'bash/zsh' };
  return { label: `Linux/${a}`, shellHint: 'bash/sh' };
}

/**
 * Worker 角色共享的只读约束（research / verify / review / ux_designer 使用）
 */
export function buildReadOnlyConstraint(locale?: PromptLocale): string {
  return locale === 'en'
    ? 'Read-only roles limit actions to reading, analysis, and side-effect-free verification; when a change is needed, output evidence-backed recommendations and hand off to an implementation role'
    : '只读角色把行动限定为读取、分析和无副作用验证；需要改动时输出证据化建议并交给实现角色';
}

/**
 * Worker 角色共享的最小改动原则（coding / frontend / backend 使用）
 */
export function buildMinimalChangePrinciple(locale?: PromptLocale): string {
  return locale === 'en'
    ? 'Minimal change is not MVP: keep code changes within the directly relevant scope while fully satisfying the task contract and user-visible goals'
    : '最小改动不是 MVP：在完整满足任务契约和用户可见目标的前提下，把代码变更限定在直接相关范围内';
}

/**
 * Worker 角色共享的完整交付原则
 */
export function buildCompleteDeliveryPrinciple(locale?: PromptLocale): string {
  return locale === 'en'
    ? 'Default to complete delivery: keep functionality, pages, boundary states, integration paths, and acceptance evidence complete according to the user goal and task contract; if the user explicitly asks for an MVP/prototype/placeholder, deliver within that scope'
    : '默认完整交付：按用户目标和任务契约保持功能、页面、边界状态、集成链路和验收证据完整；用户明确要求 MVP/原型/占位时，按该范围交付';
}

/**
 * Worker 角色共享的依赖约束（coding / frontend / backend 使用）
 */
export function buildNoNewDependencyRule(locale?: PromptLocale): string {
  return locale === 'en'
    ? 'Add a new dependency only when the user or task contract explicitly requires it, and concurrently document its purpose, version, and verification result'
    : '依赖新增仅在用户或任务契约明确要求时执行，并同步说明用途、版本和验证结果';
}

/**
 * Worker 角色共享的验证要求（coding / frontend / backend 使用）
 */
export function buildMustVerifyRule(locale?: PromptLocale): string {
  return locale === 'en'
    ? 'Run verification: after code changes, run the build or tests and confirm the results are traceable'
    : '运行验证：代码修改后运行编译或测试，确认结果可追溯';
}

/**
 * 前端 / 全栈 / Verify 共享的浏览器验收要求
 */
export function buildBrowserAcceptanceRule(locale?: PromptLocale): string {
  return locale === 'en'
    ? 'Real browser acceptance: when work involves pages, components, styles, routes, browser-side state, or end-to-end user paths, start or reuse a local service and use `browser_visual_verify` / `browser_action` / `screenshot` to open the real page for acceptance; cover at least desktop, and cover mobile for responsive changes; record URL, assertions, screenshot paths, and failure details. Mark passed only when the browser is available and evidence is complete; mark blocked/skipped and explain startup errors when browser startup is blocked. Tool selection: `browser_visual_verify` for quick assert-and-screenshot on a single page; `browser_action` for multi-step interaction (click, fill, navigate, eval_js); `screenshot` for capturing a URL without assertions or when browser_action is unavailable.'
    : '真实浏览器验收：涉及页面、组件、样式、路由、浏览器端状态或端到端用户路径时，启动或复用本地服务并用 `browser_visual_verify` / `browser_action` / `screenshot` 打开真实页面验收；至少覆盖 desktop，响应式改动同时覆盖 mobile；记录 URL、断言、截图路径和失败信息。浏览器可用且证据齐全时标记 passed；浏览器启动受阻时标记 blocked/skipped 并说明启动错误。工具选择：`browser_visual_verify` 用于单页快速断言+截图；`browser_action` 用于多步交互（点击、填写、导航、执行 JS）；`screenshot` 用于仅截取 URL 画面无需断言或 browser_action 不可用时。';
}

/**
 * Backend 共享的 API 路由注册验证要求
 */
export function buildApiRouteVerificationRule(locale?: PromptLocale): string {
  return locale === 'en'
    ? 'API route registration verification: before completing a backend task, verify that all new routes are registered — start the application or import the app, check that the route list includes every endpoint path described in the task, and confirm no 404. Run at least one curl or equivalent request to confirm each endpoint is reachable.'
    : 'API 路由注册验证：后端任务完成前必须验证所有新增路由已注册——启动应用或 import app，检查路由列表包含任务描述的所有端点路径，确认无 404。至少运行一次 curl 或等效请求验证端点可达。';
}

export function buildCapabilitySurfaceProtocol(locale?: PromptLocale): string {
  const text = getPromptCatalog(locale).sharedFragments;
  return section(text.capabilitySurfaceHeading, bullets(text.capabilitySurfaceRules));
}

export function buildCrossStackContractProtocol(role: 'frontend' | 'backend' | 'fullstack', locale?: PromptLocale): string {
  const roleAction = role === 'frontend'
    ? (locale === 'en'
      ? 'Implement pages, components, state, frontend types, and callers per the contract, and ack consumption with request_id'
      : '按契约落地页面、组件、状态、前端类型和调用方，并用 request_id 回执已消费')
    : role === 'backend'
      ? (locale === 'en'
        ? 'Implement APIs, schemas, server-side handlers, data access, and backend tests per the contract, and ack landing with request_id'
        : '按契约落地 API、schema、服务端处理、数据访问和后端测试，并用 request_id 回执已落地')
      : (locale === 'en'
        ? 'Implement frontend callers, server-side handlers, shared types, and acceptance cases against the same contract in sync, and record end-to-end verification results'
        : '按同一契约同步落地前端调用方、服务端处理、共享类型和验收用例，并记录端到端验证结果');

  if (locale === 'en') {
    return section('Contract Protocol (cross-stack required reading)', bullets([
      'Before starting, read the Context Manifest, blackboard [contract:<surface>] and [design_doc] nodes to confirm request/response schema, error codes, status flow, component props, env vars, and acceptance criteria',
      `Current role action: ${roleAction}`,
      'When a contract is missing, fields are ambiguous, or implementation needs adjustment, submit a v+1 ```graph_contract``` block; fields include surface, title, version, content; content must cover schema, error codes, status flow, change impact, migration steps, and acceptance evidence',
      'When the other side must confirm, send team_message(type="request", request_id="<surface>@v<N>"); after receiving a request and finishing the work, send team_message(type="ack", request_id="<same>")',
      'The final summary lists contract surface/version, consumption or upgrade conclusions, affected files, verification evidence, and pending alignment items so the next Agent can reuse them directly',
    ]));
  }
  return section('契约协议（跨栈必读）', bullets([
    '开工前读取 Context Manifest、黑板 [contract:<surface>] 与 [design_doc] 节点，确认请求/响应 schema、错误码、状态流、组件 props、环境变量和验收口径',
    `当前角色动作：${roleAction}`,
    '契约缺失、字段含糊或实现需要调整时，提交 v+1 ```graph_contract``` 代码块；字段包含 surface、title、version、content，content 写清 schema、错误码、状态流、变更影响、迁移步骤和验收证据',
    '需要对方确认时发送 team_message(type="request", request_id="<surface>@v<N>")；收到 request 并完成处理后发送 team_message(type="ack", request_id="<same>")',
    '最终摘要列出契约 surface/version、消费或升级结论、影响文件、验证证据和待对齐项，让后续 Agent 可直接复用',
  ]));
}

export function buildExternalWorkerCompletionProtocol(locale?: PromptLocale): string {
  const text = getPromptCatalog(locale).sharedFragments;
  return section(text.externalCompletionHeading, [
    text.externalCompletionIntro,
    '',
    '```lingxiao_completion',
    '{',
    `  "summary": "${text.externalCompletionSummaryExample}",`,
    '  "artifacts": {',
    '    "files_created": ["path/to/new-file"],',
    '    "files_modified": ["path/to/changed-file"],',
    '    "commands_run": ["npm test"]',
    '  },',
    '  "verification": [',
    '    { "kind": "test", "detail": "npm test passed", "passed": true }',
    '  ],',
    '  "contract_compliance": {',
    '    "surface": "task:<taskId>",',
    '    "status": "complied",',
    '    "evidence": ["npm test passed"],',
    `    "deviations": ["${text.externalCompletionNoDeviationExample}"]`,
    '  },',
    '  "evidence_refs": ["mcp://server/resource", "https://example.com/spec", "reports/verification.md"],',
    '  "blocked_by_discovery": ["describe newly discovered dependency, or leave empty"],',
    '  "needs_leader_coordination": false,',
    `  "next_steps": ["${text.externalCompletionNextStepExample}"]`,
    '}',
    '```',
    '',
    text.externalCompletionNotes,
    '',
    buildCompleteDeliveryPrinciple(locale),
    text.externalCompletionBrowserEvidence,
  ]);
}

/**
 * Worker 角色共享的输出格式模板
 * @param tailItem 最后一项"后续建议"的定制描述
 */
export function buildWorkerOutputFormat(tailItem: string): string {
  return section('输出格式', bullets([
    '修改/创建的文件列表及每文件变更摘要',
    '运行的验证命令及实际输出结果',
    '风险点、未验证项或需注意的副作用',
    tailItem,
  ]));
}

export function buildThinkingInstructionText(): string {
  return [
    '每次行动前先写简短工作笔记：',
    '',
    '[工作笔记]',
    '- 状态: 当前掌握的关键信息',
    '- 判断: 对任务的理解与决策依据',
    '- 动作: 即将执行的具体步骤',
    '[/工作笔记]',
    '',
    bullets([
      '笔记简短具体、面向执行，写真实状态、判断依据和下一步动作',
      '拿到工具结果后更新判断再继续',
      '笔记写完立即调用与动作匹配的工具，或在无需工具时直接给出基于证据的结果',
    ]),
  ].join('\n');
}

export function buildSessionScopeSection(input: {
  workspace: string;
  sessionId: string;
}): string {
  const { workspace, sessionId } = input;
  const paths = Workspace.getSessionArtifactPaths(sessionId, workspace);
  const { label: platformLabel, shellHint } = getPlatformHint();
  return [
    '**【会话空间】**',
    bullets([
      `会话: \`${sessionId}\` | 目录: \`${paths.sessionDir}\``,
      `Scratchpad: \`${paths.scratchpadDir}\` | Context: \`${paths.contextDir}\``,
      `运行平台: \`${platformLabel}\` | Shell: \`${shellHint}\` — 执行 shell 命令时使用与平台匹配的语法`,
      '读写范围限定在当前 session 目录；其他 session 保持隔离',
      '恢复现场时优先读取 \`session_artifacts\`',
    ]),
    buildLocalLlmGatewayPromptSection(),
  ].filter(Boolean).join('\n\n');
}

export function buildScratchpadSection(input: {
  workspace: string;
  sessionId: string;
  taskId: string;
  role: string;
}): string {
  const { workspace, sessionId, taskId, role } = input;
  const paths = Workspace.getSessionArtifactPaths(sessionId, workspace);
  const scratchpadFile = `${paths.scratchpadDir}/${taskId}_${role}.md`;
  return paragraphLines([
    `**【Scratchpad】** 复杂任务在关键节点写入笔记：\`${scratchpadFile}\`（已完成步骤、关键发现、下一步）。`,
    `环境变量: \`$LINGXIAO_SCRATCHPAD_DIR=${paths.scratchpadDir}\`，\`$LINGXIAO_CONTEXT_DIR=${paths.contextDir}\`。`,
    'session 目录默认允许写入，不受 write_scope 限制。上下文被压缩时可重新读取恢复现场。',
  ]);
}

export function buildWorkerWriteWorkNoteSection(): string {
  return section('write_work_note 必填', [
    '任务完成时调用 \`write_work_note\`，包含：',
    bullets([
      '**已完成内容** + **artifacts**（文件路径列表，下游 Agent 依赖此字段定位上下文）',
      '**keyFindings**：格式「文件:行号 — 说明」',
      '**impactAnalysis**：改动影响范围',
      '**推荐后续步骤**：1-3 个具体建议',
    ]),
    '写实质进展和可追踪证据；artifacts + keyFindings 是后续 Agent 的"地图"。',
  ]);
}

/**
 * 文件分批写入约束 — 控制单次工具调用长度，降低 API output token 截断风险
 */
export function buildIncrementalWriteRule(): string {
  return paragraphLines([
    '**【文件分批写入】** 写入或生成较长文件内容时分批次操作：',
    bullets([
      '新建/整文件写入用 file_create，已有文件修改或追加用 structured_patch',
      '单次 content 或 replace 的内容控制在 800 行以内',
      '超过 800 行的文件：先写入前半部分，再按后续段落追加',
      '生成报告/文档/代码等长文本时，按逻辑段落拆分为多次工具调用',
      '原因：API output token 有上限，单次过长会被截断导致文件不完整',
    ]),
  ]);
}
