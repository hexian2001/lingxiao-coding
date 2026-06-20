import {
  getLanguage,
  getSessionLanguage,
  normalizeLanguage,
  type Language,
} from '../../../i18n.js';

export type PromptLocale = Language;

export interface PromptCatalog {
  readonly locale: PromptLocale;
  readonly llmLanguageDirective: string;
  readonly leader: {
    readonly availableSkillsHeading: string;
    readonly availableSkillsIntro: string;
    readonly eternalGoal: {
      /** complete_eternal_goal tool responses */
      readonly evidenceRequired: string;
      readonly summaryRequired: string;
      readonly noActiveGoal: string;
      readonly goalCompleted: (description: string) => string;
      readonly evidenceLabel: string;
      readonly completedStatus: string;
      readonly completedToolResult: (description: string) => string;
      /** Patrol prompt fragments for goal completion guidance */
      readonly patrolDeliveryStep: string;
      readonly patrolCompletionGuidanceEarly: string;
      readonly patrolCompletionGuidanceLate: string;
      /** Leader status labels */
      readonly statusStandby: string;
      /** Tool definition texts */
      readonly toolDescription: string;
      readonly toolEvidenceDescription: string;
      readonly toolSummaryDescription: string;
    };
  };
  readonly workerTask: {
    readonly taskContextHeading: string;
    readonly taskGoalLabel: string;
    readonly taskDescriptionLabel: string;
    readonly workspaceLabel: string;
    readonly writeScopeLabel: string;
    readonly sessionLabel: string;
    readonly budgetFast: string;
    readonly budgetMedium: string;
    readonly budgetLarge: string;
    readonly contextManifestTitle: string;
    readonly leaderContextHeading: string;
    readonly leaderContextIntro: string;
    readonly injectedSkillBodiesTitle: string;
    readonly knowledgeGraphHeading: string;
    readonly knowledgeGraphIntro: string;
    readonly knowledgeGraphAction: string;
    readonly skillPathRulesHeading: string;
    readonly skillPriorityLine: (input: { projectSkillsDir: string; globalSkillsDir: string }) => string;
    readonly skillPathLine: string;
    readonly autoInjectedLine: (names: string[]) => string;
    readonly skillBodiesLine: string;
    readonly deliverySopHeading: string;
    readonly deliveryScopeRule: string;
    readonly deliveryCompletenessRule: string;
    readonly deliveryPageEvidenceRule: string;
    readonly collaborationHeading: string;
    readonly collaborationRules: (input: { taskId: string }) => string[];
    readonly teamCommunicationHeading: string;
    readonly teamCommunicationRules: string[];
    readonly startInstruction: string;
  };
  readonly sharedFragments: {
    readonly capabilitySurfaceHeading: string;
    readonly capabilitySurfaceRules: string[];
    readonly externalCompletionHeading: string;
    readonly externalCompletionIntro: string;
    readonly externalCompletionSummaryExample: string;
    readonly externalCompletionNoDeviationExample: string;
    readonly externalCompletionNextStepExample: string;
    readonly externalCompletionNotes: string;
    readonly externalCompletionBrowserEvidence: string;
  };
  readonly tools: {
    readonly registry: {
      readonly schemaValidationFailed: string;
      readonly deferredToolDescription: (name: string) => string;
      readonly argumentValidationMessage: (formatted: string) => string;
      readonly argumentValidationFix: string;
      readonly toolNotFoundMessage: (name: string) => string;
      readonly toolNotFoundCause: (name: string) => string;
      readonly toolNotFoundFix: (candidates: string[]) => string;
      readonly argumentParseFix: string;
      readonly scopeForbiddenMessage: (name: string) => string;
      readonly scopeForbiddenCause: (name: string) => string;
      readonly scopeForbiddenFix: string;
      readonly validationFailedMessage: string;
      readonly validationFailedFix: string;
      readonly fileMustReadFirstMessage: (path: string) => string;
      readonly fileMustReadFirstCause: string;
      readonly fileMustReadFirstFix: string;
      readonly officeModeRequiredMessage: (name: string) => string;
      readonly officeModeRequiredCause: string;
      readonly officeModeRequiredFix: string;
      readonly permissionRequiredFix: string;
    };
    readonly structuredPatch: {
      readonly reuseOriginalReplace: string;
      readonly reuseOriginalContent: string;
      readonly wholeLineRangeNote: string;
      readonly exactOccurrenceNote: string;
      readonly finalOccurrenceNote: string;
      readonly insertExactOccurrenceNote: string;
      readonly insertFinalOccurrenceNote: string;
      readonly insertWholeRangeNote: string;
      readonly retryRuleSingleShape: string;
      readonly ambiguousSearchFix: string;
    };
    readonly astQuery: {
      readonly actionDescription: string;
      readonly symbolDescription: string;
      readonly fileDescription: string;
      readonly namePatternDescription: string;
      readonly kindsDescription: string;
      readonly maxDepthDescription: string;
      readonly limitDescription: string;
      readonly symbolRequiredMessage: (action: string) => string;
      readonly symbolRequiredFix: (action: string) => string;
    };
  };
  readonly judges: {
    readonly nextSpeaker: {
      readonly toolDescription: string;
      readonly system: string;
    };
    readonly eternalPatrol: {
      readonly toolDescription: string;
      readonly actionDescription: string;
      readonly reasonDescription: string;
      readonly system: string;
    };
    readonly workerCompletion: {
      readonly toolDescription: string;
      readonly reasonDescription: string;
      readonly feedbackDescription: string;
      readonly system: string;
    };
    readonly scratchpadReview: {
      readonly toolDescription: string;
      readonly system: string;
    };
    readonly workflowCondition: {
      readonly taskInstructions: readonly string[];
    };
    readonly taskClassification: {
      readonly toolDescription: string;
      readonly system: string;
    };
    readonly toolSelection: {
      readonly toolDescription: string;
      readonly selectedToolNamesDescription: string;
      readonly system: string;
    };
  };
}

const catalogByLocale: Record<PromptLocale, PromptCatalog> = {
  zh: {
    locale: 'zh',
    llmLanguageDirective: '请使用中文回复。保留 XML tags、JSON keys、tool names、enum values、Context Manifest、graph_contract、lingxiao_completion 等机器协议字段的英文原文；这些协议标识保持原样。',
    leader: {
      availableSkillsHeading: '当前可用 Skills 列表',
      availableSkillsIntro: '以下 Skills 可在创建角色（define_agent_role）或任务（create_task）时通过 skill_names 参数指定，注入 Worker 的执行上下文：',
      eternalGoal: {
        evidenceRequired: '必须提供 evidence（完成证据）才能标记目标为已完成。',
        summaryRequired: '必须提供 summary（完成总结）才能标记目标为已完成。',
        noActiveGoal: '当前没有活跃的 Eternal 目标，无法标记完成。',
        goalCompleted: (description) => `Eternal 目标已完成：${description}`,
        evidenceLabel: '完成证据',
        completedStatus: 'Eternal · 目标已完成，待命中',
        completedToolResult: (description) => `Eternal 目标「${description}」已标记为完成。已自动切回 manual 模式，Leader 进入待命。如需继续可设置新 goal。`,
        patrolDeliveryStep: '5. **收尾交付**：目标完成时调用 complete_eternal_goal(evidence, summary) 标记完成，不要转去无关优化',
        patrolCompletionGuidanceEarly: '如果目标确实已完成（有测试通过、构建成功、代码提交等具体证据），调用 complete_eternal_goal 标记完成；否则继续找下一步。',
        patrolCompletionGuidanceLate: '除非目标已有明确完成证据（此时调用 complete_eternal_goal），否则不要因为本轮空闲而转去无关优化。',
        statusStandby: 'Eternal · 待命中',
        toolDescription: '标记当前 Eternal 目标为已完成。仅当有充分证据证明目标已达成时调用。调用后 goal 被清除，自动切回 manual 模式，Leader 进入 idle 待命。如需继续可设置新 goal。不要在目标仍有未验证部分时调用。',
        toolEvidenceDescription: '目标完成的具体证据（测试通过、构建成功、代码提交等可验证事实）',
        toolSummaryDescription: '目标完成总结，包含完成了什么、关键产出和后续建议',
      },
    },
    workerTask: {
      taskContextHeading: '任务上下文',
      taskGoalLabel: '目标',
      taskDescriptionLabel: '描述',
      workspaceLabel: '工作区',
      writeScopeLabel: '写入范围',
      sessionLabel: '会话',
      budgetFast: '**预算**: 快速任务，聚焦直接证据和最小改动。',
      budgetMedium: '**预算**: 中等任务，先理解再动手，完成后验证。',
      budgetLarge: '**预算**: 大型任务，先规划再执行；复杂度高时写 Scratchpad 跟踪。',
      contextManifestTitle: '### Context Manifest（系统统一注入）',
      leaderContextHeading: 'Leader 背景上下文（启动前必读）',
      leaderContextIntro: '由 Leader 在分配任务时提供，包含用户意图、已知信息、关键决策：',
      injectedSkillBodiesTitle: 'Injected Skill Bodies',
      knowledgeGraphHeading: '知识图谱协议',
      knowledgeGraphIntro: '共享知识图谱是跨 Agent 的实时公共记忆。先阅读 Context Manifest 中的黑板快照；其中 Facts/Intents 会包含 content、tags、evidence 和关系。',
      knowledgeGraphAction: '执行时沿已有事实继续推进；发现新事实、新方向或矛盾时通过结构化代码块补充公共记忆：',
      skillPathRulesHeading: 'Skill 路径规则',
      skillPriorityLine: ({ projectSkillsDir, globalSkillsDir }) => `优先级: 项目级 > 插件贡献 > 用户级 > 内置。项目级目录: ${projectSkillsDir}/ | 用户级目录: ${globalSkillsDir}/ | 插件/内置目录以 Context Manifest 的 skills 路径为准`,
      skillPathLine: 'Skill 文件路径以注入区 <skill path="..."> 的真实 path 字段为准；需要完整技能时读取该 path。',
      autoInjectedLine: (names) => `自动注入: ${names.join(', ')}`,
      skillBodiesLine: '技能正文和插件来源已进入 Context Manifest；若 truncated=true，必须按真实 path 读取完整技能或相对引用文档后再做关键办公产物。',
      deliverySopHeading: '交付完整性与验收 SOP',
      deliveryScopeRule: '发现任务描述只覆盖子集、但用户目标明显是完整项目/完整功能时，先通过 send_message 升级 Leader 对齐范围，并按完整目标继续规划',
      deliveryCompletenessRule: '完成标准包含可用性、集成链路、错误/空/加载态和可追溯验证证据；骨架、占位页面、假数据或未接线功能仅在任务契约明确要求时作为对应阶段产物',
      deliveryPageEvidenceRule: '页面级任务同时提供工程证据和真实页面证据：`npm test`、类型检查或构建成功作为工程证据，浏览器验收作为用户可见路径证据',
      collaborationHeading: '协作与守卫',
      collaborationRules: ({ taskId }) => [
        '前序 Agent 笔记、产物、契约和文件树在 Context Manifest 中；开工先读 manifest，随后用 `read_work_notes` 或 manifest 指向的 artifact 补齐证据',
        `达到验收标准后调用 \`attempt_completion\` 收尾；每个任务都必须提供 \`contract_compliance\` 契约遵守证明（surface/status/evidence/deviations），无跨栈契约时 surface 使用 \`task:${taskId}\``,
        'coding 最终摘要必须含文件路径和验证证据；缺少契约遵守证明时系统会拒绝 complete',
        '代码修改后必须验证：编译（`tsc --noEmit`）或测试，确认无报错',
      ],
      teamCommunicationHeading: 'Team 通信（如果你属于 team）',
      teamCommunicationRules: [
        '启动任务后先调用 `team_inbox(unread_only=true, mark_read=true)`，直接处理已有 P2P 私信和 team 广播，并把同伴消息纳入当前判断',
        '开工前必须阅读 Context Manifest 的黑板快照，优先查找 `[contract]` / `[design_doc]` 节点；跨栈实现按现有 contract 执行，缺失或冲突时先通知 team/Leader 并提交 v+1 契约',
        '需要确认团队成员时调用 `team_manage(action="list_members")`；P2P 目标必须是 `interactive=true` 成员：`team_message(target_type="member", target="成员名", content=...)`。`not_dispatched` 成员走 team 广播，或用 `send_message` 请求 Leader 先 dispatch',
        '想了解同伴进度（谁在做什么、哪些任务就绪/阻塞）时调用 `team_manage(action="task_board")`，读取任务板后主动对齐写入范围、接口契约或集成窗口',
        '需要通知全队时调用 `team_message(target_type="team", target="team名", content=...)`；广播用于接口契约、全局约定、跨模块风险、集成窗口等全队相关事项；目标字段始终使用 `target_type + target`',
        '你的产出会影响其他成员时必须主动通知：API/数据结构/文件路径/组件 props/环境变量/运行命令/验收口径发生新增或变化，都要发 P2P 或广播',
        '需要对方明确答复时用完整调用 `team_message(target_type="member", target="<receiver>", content="...", type="request", request_id="<surface>@v<N>")`；收到 request 并处理后由你本人回给原发送者：`team_message(target_type="member", target="<original sender>", content="...", type="ack", request_id="<same>")`。ack 由处理 request 的成员发出。`team_inbox` 的 `ack_status` 会提示你「还在等谁的 ack」和「你欠谁一个 ack」',
        '收到 `[协商请求]` 时说明你和某成员存在文件/资源冲突：先直接与对方协商收敛（拆分写入路径或串行化），达成一致后按指令里的 request_id 回 ack，且必须填写 target_type/target/content；谈不拢再升级 Leader',
        '跨栈接口/schema/props/env/命令契约发生新增或变化时，最终输出必须包含 `graph_contract` 代码块：字段至少包含 `surface`、`title`、`content`；重要方案沉淀用 `graph_design_doc` 代码块',
        '遇到依赖阻塞时先直接联系对应成员；需要用户/Leader 决策、跨 team 协调或等待超时时升级给 Leader',
        '结束前再调用一次 `team_inbox`，确认没有未处理协作消息和未闭环的 ack；收尾时用 `write_work_note` 汇总已发送/已接收的关键协作信息，并在最终结果摘要里说明',
        '战略级汇报（任务收尾、需要 Leader 决策）走 `send_message(recipient="leader", ...)`；任务完成时直接回复最终结果摘要，系统会自动把它作为完成报告回传给 Leader',
      ],
      startInstruction: '开始执行。完成后直接回复结果摘要；阻塞时用 send_message 联系 Leader。',
    },
    sharedFragments: {
      capabilitySurfaceHeading: '能力面协议（Plugin / Skill / MCP）',
      capabilitySurfaceRules: [
        'Plugin 是本地能力包和分发单元；启用后把 skills、MCP servers、apps/assets、tools/hooks/scripts 贡献到凌霄能力面',
        'Skill 是注入 Agent 上下文的执行知识、流程和领域约束；来源优先级为项目级 > 插件贡献 > 用户级 > 内置，Leader 在 define_agent_role/create_task 中用 skill_names 绑定',
        'MCP 是连接外部系统的 tools/resources/prompts 协议；运行时统一通过 `mcp(action="list_servers|list_tools|call_tool|list_resources|read_resource", ...)` 发现和访问 tools/resources',
        '需要 prompts、resource templates 或服务能力快照时，使用同一 `mcp` 工具的 action="list_prompts|get_prompt|list_resource_templates|capability_snapshot"',
        '插件贡献的 MCP server 会同步到 settings.mcp.servers；所有 MCP server 通过同一个 `mcp` 工具入口访问',
        '插件 tools/hooks/scripts 只有接入 ToolRegistry 或 MCP server 后才属于 runtime 可调用能力；其余情况作为 marketplace、packaging、hook metadata 和本地源码线索进入 Context Manifest',
        '需要完整 Skill 时读取注入区 `<skill path="...">` 的真实路径；调用 MCP 前先 list_servers/list_tools/list_resources，再按真实 schema 调用',
        '能力调用产生的文件、命令、MCP resource URI、URL、截图/报告路径和验证结果写入 write_work_note、attempt_completion.evidence_refs 或 lingxiao_completion.evidence_refs，让 Context Manifest 继续传递给后续 Agent',
      ],
      externalCompletionHeading: '凌霄完成报告协议',
      externalCompletionIntro: '最终答复先写给 Leader 看的自然语言摘要，末尾附加一个 ```lingxiao_completion 代码块，Lingxiao 会解析它并注入后续 Agent 上下文。',
      externalCompletionSummaryExample: '一句话说明完成了什么',
      externalCompletionNoDeviationExample: '无',
      externalCompletionNextStepExample: '可选的后续建议',
      externalCompletionNotes: '路径使用工作区相对路径或绝对路径；contract_compliance 是必填契约遵守证明，包含 surface/status/evidence/deviations；evidence_refs 写 MCP resource URI、URL、截图/报告路径或外部工具结果 ID；blocked_by_discovery 写新发现但未解决的依赖，needs_leader_coordination=true 表示需要 Leader 协调；验证写真实命令与结果；跨栈接口/schema/props/env/命令契约变化同时输出 graph_contract 代码块。',
      externalCompletionBrowserEvidence: '前端/全栈任务完成报告包含真实浏览器验收证据；构建、lint 或单元测试作为工程证据，页面级验收另列真实页面证据。浏览器无法启动时写入 blocked/skipped 与错误原因；视觉或交互 passed 结论只在真实页面证据齐全时给出。',
    },
    tools: {
      registry: {
        schemaValidationFailed: 'schema 校验失败',
        deferredToolDescription: (name) => `延迟加载工具：${name}`,
        argumentValidationMessage: (formatted) => `参数校验失败：${formatted}`,
        argumentValidationFix: '按工具 schema 修正参数；仅传 schema 声明字段，并为互斥目标选择一种表达。可选字段未知时直接省略，不要传空字符串。',
        toolNotFoundMessage: (name) => `未找到工具：${name}`,
        toolNotFoundCause: (name) => `没有注册名为 ${name} 的工具。`,
        toolNotFoundFix: (candidates) => candidates.length > 0 ? `请改用候选工具之一：${candidates.join(', ')}` : '请检查工具名或先加载/注册该工具。',
        argumentParseFix: '工具参数必须直接传 JSON object/array 值；不要把参数包成字符串。',
        scopeForbiddenMessage: (name) => `当前上下文不可用工具：${name}`,
        scopeForbiddenCause: (name) => `工具 ${name} 仅允许 Leader 上下文调用。`,
        scopeForbiddenFix: '不要从 Worker 直接调用 Leader 元工具；需要编排时向 Leader 汇报或使用任务允许的 worker 工具。',
        validationFailedMessage: '参数校验失败。',
        validationFailedFix: '按工具 schema 修正参数。',
        fileMustReadFirstMessage: (path) => `编辑前必须先读取文件：请先使用 file_read 读取 "${path}"，确认文件内容后再进行编辑。`,
        fileMustReadFirstCause: '为避免覆盖未知用户改动，编辑/覆盖已有文件前必须先读文件。',
        fileMustReadFirstFix: '先调用 file_read 读取该 path，再重试当前编辑。',
        officeModeRequiredMessage: (name) => `办公工具需要 Office 模式：${name}`,
        officeModeRequiredCause: '当前会话未开启 Office 模式，办公工具不会执行。',
        officeModeRequiredFix: '请先使用 /office on 或前端 Office 开关开启当前会话的 Office 模式，再重试。',
        permissionRequiredFix: '等待用户授权，或选择无需该权限的替代工具/方案。',
      },
      structuredPatch: {
        reuseOriginalReplace: '<在这里复用原始 replace 文本>',
        reuseOriginalContent: '<在这里复用原始 content 文本>',
        wholeLineRangeNote: '仅在确实要替换列出的整段行范围时使用。',
        exactOccurrenceNote: '仅在确实要替换这一处精确匹配时使用。',
        finalOccurrenceNote: '仅在确实要替换最后一处匹配时使用。',
        insertExactOccurrenceNote: '仅在确实要插入到这一处精确匹配之后时使用。',
        insertFinalOccurrenceNote: '仅在确实要插入到最后一处匹配之后时使用。',
        insertWholeRangeNote: '仅在确实要插入到整段匹配行/范围之后时使用。',
        retryRuleSingleShape: '重试时只传 {path,hunks}；每个 hunk 必须只保留一种合法形态。不要把 received_fields 原样复制回 retry args。',
        ambiguousSearchFix: '优先使用 retry_args.first_occurrence 或 retry_args.last_occurrence 指定目标；确认要全部替换时才使用 retry_args.replace_all。若只是追加长文档，直接用 retry_args.append_eof。',
      },
      astQuery: {
        actionDescription: '基于 AST 的查询动作。',
        symbolDescription: 'definitions、references、call_graph 或 implementors 使用的符号名。',
        fileDescription: '可选的项目相对路径过滤，例如 src/index.ts。',
        namePatternDescription: 'action=pattern 时应用到 AST 声明名称的正则表达式。',
        kindsDescription: 'action=pattern 使用的声明类型。',
        maxDepthDescription: 'action=call_graph 的最大调用图深度。',
        limitDescription: '最大结果数量。',
        symbolRequiredMessage: (action) => `ast_query action "${action}" 需要非空 symbol。`,
        symbolRequiredFix: (action) => `使用 {"action":"${action}","symbol":"TargetName"} 重试。`,
      },
    },
    judges: {
      nextSpeaker: {
        toolDescription: '返回 eternal mode 中 assistant response 在 stop finish reason 后是否应立即继续。',
        system: [
          '你负责判断 eternal mode 中的自主 Leader 在模型返回 stop/end_turn finish reason 后是否应该立即继续。',
          '使用语义判断，不要使用本地文本模式规则。',
          '只有当可见 assistant 输出实质未完成、明显开始了未收尾的结构，或明确显示正处于思路中途且必须在同一轮继续时，才继续。',
          '不要仅因为可能存在未来任务而继续；open work 由 runtime 单独处理。',
          '只调用 submit_next_speaker_verdict 一次作为回复。',
        ].join(' '),
      },
      eternalPatrol: {
        toolDescription: '决定 eternal-mode patrol 现在应运行 LLM patrol、静默跳过，还是把控制权交还给用户。',
        actionDescription: 'patrol: 项目状态有值得调查的新信号；skip: 噪音或已处理变更，不消耗 LLM tokens；yield_user: 没有有意义的剩余工作，把控制权交还给人类。',
        reasonDescription: '简短理由（一句话）。',
        system: [
          '你是 Eternal Mode 自主编排器的 patrol judge。',
          '判断 Leader 是否应消耗 tokens 运行另一轮 patrol、静默跳过，或把控制权交还给用户。',
          '当 eternal_goal 存在时，这是 Goal Mode：保护该目标作为最高优先级，直到有具体证据表明目标已完成，或没有仅靠人类输入就无法继续。',
          '当项目 fingerprint 发生变化，且存在具体失败、新任务、新 blackboard contract 或未回复的 teammate message 时，优先选择 patrol。',
          '存在 active eternal_goal 时，如果目标仍需要规划、创建任务、派发、实现、验证或最终交付，即使项目 fingerprint 未变化，也优先选择 patrol。',
          '当 fingerprint 变化但 diff 看起来像 Leader 自己上一轮输出、heartbeat 或外观噪音时，优先选择 skip。',
          '当没有 eternal_goal、fingerprint 未变化、last_patrol_outcome != productive 且 has_open_work=false 时，优先选择 yield_user。重复泛化 idle patrol 是浪费。',
          '不要仅因为一轮 idle 或 fingerprint 未变化，就对 active eternal_goal 返回 yield_user。',
          '只调用 submit_eternal_verdict 一次作为回复。',
        ].join(' '),
      },
      workerCompletion: {
        toolDescription: '返回 worker final text 是否是有效的任务完成。',
        reasonDescription: '用于 verdict 的简短稳定 reason。',
        feedbackDescription: '如果拒绝完成，给 worker 的具体反馈；如果接受则为空字符串。',
        system: [
          '你是自主软件工程 worker 的 completion judge。',
          '使用语义判断，不要做关键词匹配。',
          '当 worker 已产出与任务相关的有意义输出时应接受，即使输出是部分交付、摘要或报告，且没有覆盖每个请求细节。',
          '只有当文本明显仍在规划未来工作且没有做任何事，或隐藏了未解决的执行失败时，才拒绝。',
          '保持宽松：如果 worker 明确取得进展并产出实质内容，即使并非各方面都完美或完整，也应接受。',
          '只调用 submit_completion_verdict 一次作为回复。',
        ].join(' '),
      },
      scratchpadReview: {
        toolDescription: '返回 scratchpad 是否仍包含有意义的未完成 follow-up 工作。',
        system: [
          '你负责审查 session scratchpad notes 中未完成的尾部工作。',
          '使用语义判断，不要匹配 TODO 关键词。',
          '只有当笔记仍暗示真实待处理的验证、交付、清理或阻塞工作时，才标记 follow-ups。',
          '如果所有 notes 都已完成，返回 has_follow_ups=false。',
          '只调用 submit_scratchpad_followup_review 一次作为回复。',
        ].join(' '),
      },
      workflowCondition: {
        taskInstructions: [
          '使用下面的 input 评估 workflow condition。',
          '只返回以下精确 JSON 值之一: true 或 false。',
          '不要调用工具。不要解释。',
        ],
      },
      taskClassification: {
        toolDescription: '对最匹配 worker assignment 的 task prompt mode 进行分类。',
        system: [
          '你负责为软件编排运行时分类 worker task prompt mode。',
          '综合 assignment 语义、task context 和 graph digest 进行判断。',
          '初始框定或目标发现工作选择 bootstrap。',
          '局势分析、缺口综合或规划下一步探索方向选择 reason。',
          '执行具体 intent、调查、验证或实现路径选择 explore。',
          '普通编码、研究、审查、QA 或交付工作，且不需要 blackboard-specific prompt mode 时选择 generic。',
          '只调用 submit_task_classification 一次作为回复。',
        ].join(' '),
      },
      toolSelection: {
        toolDescription: '选择应暴露给下一次 agent LLM call 的 tool names。',
        selectedToolNamesDescription: '当前任务和角色的工具名，按优先级顺序排列。',
        system: [
          '你为自主软件工程 agent 选择工具。',
          '使用当前 role、task、workspace scope 和 recent conversation，选择支持下一次 LLM call 的工具。',
          '按优先级顺序返回工具名。当规划、执行、验证、协作和完成能力适合任务时，包含足够的相关工具。',
          'runtime 会在你选择之后强制执行 token budget。',
          '只调用 submit_tool_selection 一次作为回复。',
        ].join(' '),
      },
    },
  },
  en: {
    locale: 'en',
    llmLanguageDirective: 'Please respond in English. Preserve machine protocol identifiers exactly as written, including XML tags, JSON keys, tool names, enum values, Context Manifest, graph_contract, and lingxiao_completion.',
    leader: {
      availableSkillsHeading: 'Currently Available Skills',
      availableSkillsIntro: 'The following Skills can be specified through the skill_names parameter when creating roles (define_agent_role) or tasks (create_task), and will be injected into the Worker execution context:',
      eternalGoal: {
        evidenceRequired: 'The evidence parameter is required to mark the goal as complete.',
        summaryRequired: 'The summary parameter is required to mark the goal as complete.',
        noActiveGoal: 'No active Eternal goal exists. Cannot mark as complete.',
        goalCompleted: (description) => `Eternal goal completed: ${description}`,
        evidenceLabel: 'Evidence',
        completedStatus: 'Eternal · Goal completed, standing by',
        completedToolResult: (description) => `Eternal goal "${description}" marked as complete. Auto-switched to manual mode. Leader is standing by — set a new goal to continue.`,
        patrolDeliveryStep: '5. **Deliver**: When the goal is complete, call complete_eternal_goal(evidence, summary) to mark it done. Do not drift to unrelated optimizations.',
        patrolCompletionGuidanceEarly: 'If the goal is truly complete (with concrete evidence such as passing tests, successful builds, or committed code), call complete_eternal_goal to mark it done; otherwise continue to the next step.',
        patrolCompletionGuidanceLate: 'Unless the goal has clear completion evidence (in which case call complete_eternal_goal), do not drift to unrelated optimizations just because this patrol was idle.',
        statusStandby: 'Eternal · Standing by',
        toolDescription: 'Mark the current Eternal goal as complete. Only call when there is concrete evidence the goal has been achieved. After calling, the goal is cleared, control mode auto-switches to manual, and Leader enters idle standby (user can set a new goal to continue). Do not call while parts of the goal are still unverified.',
        toolEvidenceDescription: 'Concrete evidence of goal completion (passing tests, successful builds, committed code, or other verifiable facts)',
        toolSummaryDescription: 'Completion summary including what was accomplished, key outputs, and follow-up recommendations',
      },
    },
    workerTask: {
      taskContextHeading: 'Task Context',
      taskGoalLabel: 'Goal',
      taskDescriptionLabel: 'Description',
      workspaceLabel: 'Workspace',
      writeScopeLabel: 'Write scope',
      sessionLabel: 'Session',
      budgetFast: '**Budget**: Quick task. Focus on direct evidence and minimal changes.',
      budgetMedium: '**Budget**: Medium task. Understand first, then act, and verify after completion.',
      budgetLarge: '**Budget**: Large task. Plan before execution; use Scratchpad to track high-complexity work.',
      contextManifestTitle: '### Context Manifest (system-injected)',
      leaderContextHeading: 'Leader Background Context (read before starting)',
      leaderContextIntro: 'Provided by the Leader when assigning the task. It contains user intent, known facts, and key decisions:',
      injectedSkillBodiesTitle: 'Injected Skill Bodies',
      knowledgeGraphHeading: 'Knowledge Graph Protocol',
      knowledgeGraphIntro: 'The shared knowledge graph is real-time public memory across Agents. First read the blackboard snapshot in Context Manifest; Facts/Intents include content, tags, evidence, and relationships.',
      knowledgeGraphAction: 'Continue from existing facts; when you find new facts, new directions, or contradictions, append public memory with structured code blocks:',
      skillPathRulesHeading: 'Skill Path Rules',
      skillPriorityLine: ({ projectSkillsDir, globalSkillsDir }) => `Priority: project-level > plugin-contributed > user-level > built-in. Project directory: ${projectSkillsDir}/ | User directory: ${globalSkillsDir}/ | plugin/built-in directories follow the skills paths in Context Manifest`,
      skillPathLine: 'Skill file paths must come from the real path field in the injected `<skill path="...">` block; read that path when the full skill is needed.',
      autoInjectedLine: (names) => `Auto-injected: ${names.join(', ')}`,
      skillBodiesLine: 'Skill bodies and plugin sources are included in Context Manifest; if truncated=true, read the full skill from the real path or referenced documents before producing critical office artifacts.',
      deliverySopHeading: 'Delivery Integrity and Acceptance SOP',
      deliveryScopeRule: 'If the task description covers only a subset but the user goal is clearly the whole project or complete feature, escalate to the Leader via send_message to align scope and continue planning against the complete goal',
      deliveryCompletenessRule: 'Acceptance criteria include usability, integration path, error/empty/loading states, and traceable verification evidence; skeletons, placeholder pages, fake data, or disconnected features are stage artifacts only when explicitly required by the task contract',
      deliveryPageEvidenceRule: 'Page-level tasks must provide both engineering evidence and real page evidence: `npm test`, typecheck, or successful build as engineering evidence, and browser acceptance as user-visible path evidence',
      collaborationHeading: 'Collaboration and Guardrails',
      collaborationRules: ({ taskId }) => [
        'Previous Agent notes, artifacts, contracts, and file tree are in Context Manifest; read the manifest before starting, then use `read_work_notes` or manifest-referenced artifacts to fill evidence gaps',
        `After meeting acceptance criteria, call \`attempt_completion\` to finish; every task must provide \`contract_compliance\` proof (surface/status/evidence/deviations). If there is no cross-stack contract, use \`task:${taskId}\` as the surface`,
        'coding final summaries must include file paths and verification evidence; the system rejects complete when contract compliance proof is missing',
        'After code changes, verify with compile (`tsc --noEmit`) or tests and confirm there are no errors',
      ],
      teamCommunicationHeading: 'Team Communication (if you belong to a team)',
      teamCommunicationRules: [
        'After starting the task, first call `team_inbox(unread_only=true, mark_read=true)`, directly handle existing P2P messages and team broadcasts, and incorporate teammate messages into your current judgment',
        'Before starting, read the Context Manifest blackboard snapshot and prioritize `[contract]` / `[design_doc]` nodes; implement cross-stack work against existing contracts, and if missing or conflicting, notify the team/Leader first and submit a v+1 contract',
        'When you need to confirm team members, call `team_manage(action="list_members")`; P2P targets must be `interactive=true` members: `team_message(target_type="member", target="member name", content=...)`. Use team broadcast for `not_dispatched` members, or use `send_message` to ask the Leader to dispatch them first',
        'When you need teammate progress (who is doing what, which tasks are ready/blocked), call `team_manage(action="task_board")`, then proactively align write scopes, interface contracts, or integration windows',
        'When you need to notify the whole team, call `team_message(target_type="team", target="team name", content=...)`; broadcasts are for interface contracts, global conventions, cross-module risks, integration windows, and other team-wide matters; always use `target_type + target` fields',
        'If your output affects others, proactively notify them: new or changed API/data structures/file paths/component props/env vars/run commands/acceptance criteria require P2P or broadcast',
        'When you need an explicit reply, use a complete call `team_message(target_type="member", target="<receiver>", content="...", type="request", request_id="<surface>@v<N>")`; after receiving and handling a request, you personally reply to the original sender with `team_message(target_type="member", target="<original sender>", content="...", type="ack", request_id="<same>")`. The member who handles the request sends the ack. `team_inbox` `ack_status` tells you who you are waiting on and whom you owe an ack',
        'When you receive `[协商请求]`, it means you and another member have a file/resource conflict: negotiate directly first (split write paths or serialize work), then reply ack with the instruction request_id after agreement, and include target_type/target/content; escalate to the Leader only if negotiation fails',
        'When cross-stack interface/schema/props/env/command contracts are added or changed, final output must include a `graph_contract` code block with at least `surface`, `title`, and `content`; use a `graph_design_doc` code block for important design decisions',
        'When blocked by dependencies, contact the relevant member directly first; escalate to the Leader when user/Leader decisions, cross-team coordination, or timeout waiting is needed',
        'Before finishing, call `team_inbox` again to ensure there are no unhandled collaboration messages or open acks; during wrap-up, use `write_work_note` to summarize key collaboration messages sent/received and mention them in the final result summary',
        'Strategic reports (task wrap-up, Leader decision needed) use `send_message(recipient="leader", ...)`; when the task is complete, reply directly with the final result summary, and the system will automatically forward it to the Leader as the completion report',
      ],
      startInstruction: 'Start execution. After completion, reply directly with the result summary; when blocked, contact the Leader with send_message.',
    },
    sharedFragments: {
      capabilitySurfaceHeading: 'Capability Surface Protocol (Plugin / Skill / MCP)',
      capabilitySurfaceRules: [
        'Plugin is a local capability package and distribution unit; when enabled, it contributes skills, MCP servers, apps/assets, tools/hooks/scripts to the Lingxiao capability surface',
        'Skill is execution knowledge, workflow, and domain constraints injected into Agent context; source priority is project-level > plugin-contributed > user-level > built-in, and the Leader binds skills through skill_names in define_agent_role/create_task',
        'MCP is the tools/resources/prompts protocol for connecting external systems; at runtime, discover and access tools/resources through the unified `mcp(action="list_servers|list_tools|call_tool|list_resources|read_resource", ...)` entrypoint',
        'When prompts, resource templates, or service capability snapshots are needed, use the same `mcp` tool actions: action="list_prompts|get_prompt|list_resource_templates|capability_snapshot"',
        'Plugin-contributed MCP servers are synced to settings.mcp.servers; all MCP servers are accessed through the same `mcp` tool entrypoint',
        'Plugin tools/hooks/scripts belong to runtime callable capabilities only after being connected to ToolRegistry or an MCP server; otherwise they enter Context Manifest as marketplace, packaging, hook metadata, and local source clues',
        'When the full Skill is needed, read the real path from the injected `<skill path="...">` block; before calling MCP, run list_servers/list_tools/list_resources, then call according to the real schema',
        'Write files, commands, MCP resource URIs, URLs, screenshot/report paths, and verification results produced by capability calls into write_work_note, attempt_completion.evidence_refs, or lingxiao_completion.evidence_refs so Context Manifest can pass them to later Agents',
      ],
      externalCompletionHeading: 'Lingxiao Completion Report Protocol',
      externalCompletionIntro: 'Write the final reply first as a natural-language summary for the Leader, then append a ```lingxiao_completion code block that Lingxiao parses and injects into later Agent context.',
      externalCompletionSummaryExample: 'One sentence describing what was completed',
      externalCompletionNoDeviationExample: 'none',
      externalCompletionNextStepExample: 'Optional follow-up recommendation',
      externalCompletionNotes: 'Use workspace-relative paths or absolute paths; contract_compliance is required proof of contract compliance and includes surface/status/evidence/deviations; evidence_refs should contain MCP resource URIs, URLs, screenshot/report paths, or external tool result IDs; blocked_by_discovery lists newly discovered unresolved dependencies, and needs_leader_coordination=true asks the Leader to coordinate; verification must record real commands and results; cross-stack interface/schema/props/env/command contract changes must also output a graph_contract code block.',
      externalCompletionBrowserEvidence: 'Frontend/fullstack completion reports include real browser acceptance evidence; build, lint, or unit tests are engineering evidence, while page-level acceptance must list real page evidence separately. If the browser cannot start, write blocked/skipped and the error reason; mark visual or interaction results passed only when real page evidence is complete.',
    },
    tools: {
      registry: {
        schemaValidationFailed: 'schema validation failed',
        deferredToolDescription: (name) => `Deferred tool: ${name}`,
        argumentValidationMessage: (formatted) => `Argument validation failed: ${formatted}`,
        argumentValidationFix: 'Fix arguments according to the tool schema; pass only declared fields and choose one target for mutually exclusive options. Omit unknown optional fields instead of passing empty strings.',
        toolNotFoundMessage: (name) => `Tool not found: ${name}`,
        toolNotFoundCause: (name) => `No tool is registered with the name ${name}.`,
        toolNotFoundFix: (candidates) => candidates.length > 0 ? `Use one of these candidate tools instead: ${candidates.join(', ')}` : 'Check the tool name, or load/register the tool first.',
        argumentParseFix: 'Tool arguments must be passed directly as a JSON object/array value; do not wrap arguments in a string.',
        scopeForbiddenMessage: (name) => `Tool is not available in this context: ${name}`,
        scopeForbiddenCause: (name) => `Tool ${name} can only be called from Leader context.`,
        scopeForbiddenFix: 'Do not call Leader meta-tools directly from a Worker; report to the Leader for orchestration or use worker tools allowed by the task.',
        validationFailedMessage: 'Argument validation failed.',
        validationFailedFix: 'Fix arguments according to the tool schema.',
        fileMustReadFirstMessage: (path) => `File must be read first: use file_read to read "${path}" and confirm its contents before editing.`,
        fileMustReadFirstCause: 'To avoid overwriting unknown user changes, existing files must be read before editing or overwriting.',
        fileMustReadFirstFix: 'Call file_read for this path first, then retry the edit.',
        officeModeRequiredMessage: (name) => `Office tool requires Office mode: ${name}`,
        officeModeRequiredCause: 'Office mode is not enabled for this session, so the office tool will not run.',
        officeModeRequiredFix: 'Enable Office mode for this session with /office on or the frontend Office toggle, then retry.',
        permissionRequiredFix: 'Wait for user authorization, or choose an alternative tool/approach that does not require this permission.',
      },
      structuredPatch: {
        reuseOriginalReplace: '<reuse the original replace text here>',
        reuseOriginalContent: '<reuse the original content text here>',
        wholeLineRangeNote: 'Use only if replacing the whole listed line range is intended.',
        exactOccurrenceNote: 'Use only if this exact occurrence is intended.',
        finalOccurrenceNote: 'Use only if the final occurrence is intended.',
        insertExactOccurrenceNote: 'Use only if inserting after this exact occurrence is intended.',
        insertFinalOccurrenceNote: 'Use only if inserting after the final occurrence is intended.',
        insertWholeRangeNote: 'Use only if inserting after the whole matched line/range is intended.',
        retryRuleSingleShape: 'Retry with only {path,hunks}; each hunk must keep exactly one allowed shape. Do not copy received_fields back into retry args.',
        ambiguousSearchFix: 'Prefer retry_args.first_occurrence or retry_args.last_occurrence to specify the target; use retry_args.replace_all only when you really want every match. If you only meant to append long text, use retry_args.append_eof directly.',
      },
      astQuery: {
        actionDescription: 'AST-backed query action.',
        symbolDescription: 'Symbol name for definitions, references, call_graph, or implementors.',
        fileDescription: 'Optional project-relative file filter, for example src/index.ts.',
        namePatternDescription: 'Regular expression applied to AST declaration names for action=pattern.',
        kindsDescription: 'Declaration kinds for action=pattern.',
        maxDepthDescription: 'Maximum call graph depth for action=call_graph.',
        limitDescription: 'Maximum result count.',
        symbolRequiredMessage: (action) => `ast_query action "${action}" requires a non-empty symbol.`,
        symbolRequiredFix: (action) => `Retry with {"action":"${action}","symbol":"TargetName"}.`,
      },
    },
    judges: {
      nextSpeaker: {
        toolDescription: 'Return whether an eternal-mode assistant response should continue immediately after a stop finish reason.',
        system: [
          'You decide whether an autonomous leader in eternal mode should immediately continue after the model returned a stop/end_turn finish reason.',
          'Use semantic judgment, not local text-pattern rules.',
          'Continue only when the visible assistant output is substantively incomplete, has clearly started a structure it has not finished, or explicitly indicates it is mid-thought and must continue in the same turn.',
          'Do not continue merely because there may be future tasks; open work is handled separately by the runtime.',
          'Reply by calling submit_next_speaker_verdict exactly once.',
        ].join(' '),
      },
      eternalPatrol: {
        toolDescription: 'Decide whether the eternal-mode patrol should run an LLM patrol now, skip silently, or yield control to the user.',
        actionDescription: 'patrol: project state has new signal worth investigating; skip: noise/already-handled change, do not spend LLM tokens; yield_user: nothing meaningful left to do, hand control back to the human.',
        reasonDescription: 'Short justification (one sentence).',
        system: [
          'You are the patrol judge for an Eternal Mode autonomous orchestrator.',
          'Decide if the leader should spend tokens running another patrol round, silently skip, or yield control back to the user.',
          'When eternal_goal is present, this is Goal Mode: protect that objective as the highest priority until there is concrete evidence it is complete or impossible without human-only input.',
          'Prefer patrol when project fingerprint moved AND there is a concrete failure, new task, new blackboard contract, or unanswered teammate message.',
          'With an active eternal_goal, also prefer patrol when the goal still needs planning, task creation, dispatch, implementation, verification, or final delivery, even if the project fingerprint did not move.',
          'Prefer skip when fingerprint changed but the diff looks like the leader\'s own previous output / heartbeat / cosmetic noise.',
          'Prefer yield_user when there is no eternal_goal AND fingerprint did NOT change AND last_patrol_outcome != productive AND has_open_work=false. Repeating generic idle patrols is wasted spend.',
          'Do not yield_user for an active eternal_goal merely because a round was idle or the fingerprint is unchanged.',
          'Reply only by calling submit_eternal_verdict exactly once.',
        ].join(' '),
      },
      workerCompletion: {
        toolDescription: 'Return whether the worker final text is a valid task completion.',
        reasonDescription: 'Short stable reason for the verdict.',
        feedbackDescription: 'Concrete feedback for the worker if completion is rejected; empty string if accepted.',
        system: [
          'You are a completion judge for autonomous software-engineering workers.',
          'Use semantic judgment, not keyword matching.',
          'Accept when the worker has produced meaningful output relevant to the task — even if the output is a partial delivery, a summary, or a report that doesn\'t cover every requested detail.',
          'Only reject when the text is clearly still planning future work without having done anything, or hides an unresolved execution failure.',
          'Be lenient: if the worker has clearly made progress and produced substantive content, accept even if it\'s not perfect or complete in every aspect.',
          'Reply only by calling submit_completion_verdict exactly once.',
        ].join(' '),
      },
      scratchpadReview: {
        toolDescription: 'Return whether the scratchpad still contains meaningful unfinished follow-up work.',
        system: [
          'You review session scratchpad notes for unfinished tail work.',
          'Use semantic judgment, not TODO keyword matching.',
          'Only mark follow-ups when the notes still imply real pending validation, delivery, cleanup, or blocked work.',
          'If all notes are complete, return has_follow_ups=false.',
          'Reply only by calling submit_scratchpad_followup_review exactly once.',
        ].join(' '),
      },
      workflowCondition: {
        taskInstructions: [
          'Evaluate the workflow condition using the input below.',
          'Return only one of these exact JSON values: true or false.',
          'Do not call tools. Do not explain.',
        ],
      },
      taskClassification: {
        toolDescription: 'Classify the task prompt mode that best matches the worker assignment.',
        system: [
          'You classify worker task prompt mode for a software orchestration runtime.',
          'Use the assignment semantics, task context, and graph digest together.',
          'Choose bootstrap for initial framing or goal discovery work.',
          'Choose reason for situation analysis, gap synthesis, or planning the next exploration direction.',
          'Choose explore for executing a specific intent, investigation, validation, or implementation path.',
          'Choose generic for ordinary coding, research, review, QA, or delivery work that does not need a blackboard-specific prompt mode.',
          'Reply by calling submit_task_classification exactly once.',
        ].join(' '),
      },
      toolSelection: {
        toolDescription: 'Select the tool names that should be exposed to the next agent LLM call.',
        selectedToolNamesDescription: 'Tool names in priority order for the current task and role.',
        system: [
          'You select tools for an autonomous software-engineering agent.',
          'Use the current role, task, workspace scope, and recent conversation to choose the tools that support the next LLM call.',
          'Return tool names in priority order. Include enough tools for planning, execution, verification, coordination, and completion when those capabilities fit the task.',
          'The runtime will enforce the token budget after your selection.',
          'Reply by calling submit_tool_selection exactly once.',
        ].join(' '),
      },
    },
  },
};

export function normalizePromptLocale(raw: string): PromptLocale {
  return normalizeLanguage(raw);
}

export function resolvePromptLocale(input?: {
  sessionLanguage?: string | null;
  currentLanguage?: string | null;
}): PromptLocale {
  if (input?.sessionLanguage) return normalizePromptLocale(input.sessionLanguage);
  if (input?.currentLanguage) return normalizePromptLocale(input.currentLanguage);
  return getSessionLanguage() || getLanguage();
}

export function getPromptLocale(): PromptLocale {
  return resolvePromptLocale({
    sessionLanguage: getSessionLanguage(),
    currentLanguage: getLanguage(),
  });
}

export function getPromptCatalog(locale: PromptLocale = getPromptLocale()): PromptCatalog {
  return catalogByLocale[locale];
}

export function getPromptLanguageDirective(locale: PromptLocale = getPromptLocale()): string {
  return `\n\n${getPromptCatalog(locale).llmLanguageDirective}`;
}
