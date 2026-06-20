/**
 * Leader 元工具 schema 定义。
 *
 * 历史上整段挂在 LeaderAgent.ts 文件首部约 750 行，与运行时类纠缠在一起；
 * 这里抽出来作为纯数据模块，零状态依赖。消费者直接从本模块导入这些常量。
 *
 * 模块只描述工具的 OpenAI/Anthropic function 协议；具体执行逻辑分散在：
 *   - LeaderToolsExecutor（带 Leader 状态副作用）
 *   - BughuntLedger（ledger 元工具）
 *   - ToolRegistry（普通 Tool，包括下放的 bughunt scan / team_manage 等）
 */

import type { ToolDefinition } from '../types/Tool.js';
export { OFFICE_TOOL_NAMES } from './toolNames.js';

// ─── BugHunt 模式专用元工具（仍走 LeaderToolsExecutor） ───
//
// 注：4 个 bughunt scan 工具已下放为普通 Tool（src/tools/implementations/
// BughuntScanToolWrappers.ts），通过 directToolsExecutor → ToolRegistry 调用，
// BUGHUNT_TOOL_NAMES 仅保留 ledger 类元工具；BUGHUNT_MODE_TOOL_NAMES 是 UI/状态接口的完整集合。
export const BUGHUNT_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'set_bughunt_dag',
      description: 'Bughunt 模式专用：建立/修订调查调度核心 DAG。节点 evidence_gate 是硬门控（结构化：finding_status/event_present/artifact_present/all），blocked_by 决定拓扑序。写入后反馈就绪候选；就绪节点须经 get_ready_dag_nodes 查询、再由你 dispatch_agent 派发（不自动派发）。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '本次 Bughunt 的目标范围' },
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'DAG 节点 ID' },
                phase: { type: 'string', enum: ['surface_map', 'finding_triage', 'repro_instrument', 'blackbox_verify', 'fix', 'review_close'], description: '调查阶段' },
                role: { type: 'string', description: '节点角色（如 research/coding/verify）' },
                objective: { type: 'string', description: '节点目标描述' },
                read_scope: { type: 'array', items: { type: 'string' }, description: '只读范围' },
                write_scope: { type: 'array', items: { type: 'string' }, description: '写入范围' },
                blocked_by: { type: 'array', items: { type: 'string' }, description: '依赖的节点 ID 列表' },
                evidence_gate: {
                  description: '结构化硬门控。object 形态：{kind:"finding_status",findingId,status} | {kind:"event_present",eventKind:"compile|blackbox_probe|..."} | {kind:"artifact_present",field:"repro_artifact|whitebox_artifacts|compile_artifacts|blackbox_artifacts"} | {kind:"all",gates:[...]};字符串或留空=无门（向后兼容）。',
                },
                expected_artifact: { type: 'string', description: '预期产物路径' },
                task_id: { type: 'string', description: '关联的任务 ID' },
                status: { type: 'string', enum: ['planned', 'dispatched', 'completed', 'blocked'], description: '节点状态' },
              },
              required: ['id', 'phase', 'role', 'objective'],
            },
          },
        },
        required: ['nodes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_ready_dag_nodes',
      description: 'Bughunt 模式专用：返回就绪可派发的 DAG 节点候选（拓扑序 + blocked_by 全 completed + evidence_gate 硬门控通过）。仅提供候选，不自动 dispatch——派发经 create_task + dispatch_agent 由你决策。brief 已附 ready_dag_nodes 摘要。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_finding',
      description: 'Bughunt 模式专用：对 finding 跑真实执行验证。compile 层（必，跑 compile_commands 如 tsc --noEmit/npm test/build，捕获 exit_code）+ 可选 blackbox 层（起目标服务 + HTTP probe，需 authorize_blackbox=true，默认关闭）。产物回写 compile_artifacts/blackbox_artifacts，verified 门认真实执行产物（非 LLM 手填）。',
      parameters: {
        type: 'object',
        properties: {
          finding_id: { type: 'string', description: '要验证的 finding ID' },
          compile_commands: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                command: { type: 'string', description: '编译/测试命令' },
                args: { type: 'array', items: { type: 'string' }, description: '命令参数' },
                cwd: { type: 'string', description: '执行目录（worktree/workspace 内）' },
              },
              required: ['command', 'cwd'],
            },
          },
          authorize_blackbox: { type: 'boolean', description: '显式授权 blackbox 层（起服务+联网 probe，默认关闭）' },
          blackbox_probe: {
            type: 'object',
            properties: {
              cwd: { type: 'string', description: '服务启动目录' },
              start_command: { type: 'string', description: '服务启动命令' },
              start_args: { type: 'array', items: { type: 'string' }, description: '启动参数' },
              health_path: { type: 'string', description: '健康检查路径（如 /health）' },
              request_path: { type: 'string', description: '探测请求路径' },
              expected_status: { type: 'number', description: '期望 HTTP 状态码' },
            },
            required: ['cwd', 'start_command'],
          },
        },
        required: ['finding_id', 'compile_commands'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'upsert_bughunt_finding',
      description: 'Bughunt 模式专用：新增或更新 finding ledger。扫描只能写 hypothesis/likely；confirmed 必须补 source/sink、taint_path 或 whitebox/repro 证据；verified 必须补 compile/test 信号和 blackbox_commands 输出证据。',
      parameters: {
        type: 'object',
        properties: {
          finding: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'finding ID' },
              title: { type: 'string', description: 'finding 标题' },
              severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'], description: '严重程度' },
              status: { type: 'string', enum: ['hypothesis', 'likely', 'confirmed', 'fixed', 'verified', 'closed', 'false_positive', 'blocked'], description: 'finding 状态' },
              files: { type: 'array', items: { type: 'string' }, description: '相关文件列表' },
              cwe: { type: 'string', description: 'CWE 编号，例如 CWE-78/CWE-89' },
              owasp: { type: 'string', description: 'OWASP 分类，例如 A03:2021' },
              cvss: { type: 'string', description: 'CVSS 向量或评分' },
              attack_vector: { type: 'string', description: '攻击入口，例如 HTTP route、CLI arg、env、file upload、dependency install' },
              trust_boundary: { type: 'string', description: '跨越的信任边界/权限边界' },
              source: { type: 'string', description: '不可信输入源，例如 req.query.path' },
              sink: { type: 'string', description: '危险汇点，例如 exec、raw SQL、readFile、innerHTML' },
              taint_path: { type: 'array', items: { type: 'string' }, description: 'source 到 sink 的关键调用链/数据流节点' },
              preconditions: { type: 'array', items: { type: 'string' }, description: '触发该漏洞需要满足的前置条件' },
              payloads: { type: 'array', items: { type: 'string' }, description: '最小 payload 或攻击输入样例；使用脱敏占位符表示外部凭证' },
              trigger: { type: 'string', description: '触发条件' },
              impact: { type: 'string', description: '影响描述' },
              exploitability: { type: 'string', enum: ['proven', 'probable', 'possible', 'unknown', 'not_exploitable'] },
              blast_radius: { type: 'string', description: '影响范围、权限提升范围、数据暴露范围' },
              evidence: { type: 'array', items: { type: 'string' }, description: '证据列表' },
              evidence_gap: { type: 'array', items: { type: 'string' }, description: '证据缺口' },
              repro_artifact: { type: 'string', description: '复现产物路径' },
              whitebox_artifacts: { type: 'array', items: { type: 'string' }, description: '源码审计/调用链/断言/最小复现产物路径或摘要' },
              instrumentation_artifacts: { type: 'array', items: { type: 'string' }, description: '插桩、trace、probe、临时测试脚手架产物' },
              compile_commands: { type: 'array', items: { type: 'string' }, description: '编译/类型检查/测试命令' },
              compile_artifacts: { type: 'array', items: { type: 'string' }, description: '编译/测试输出、日志或证据包路径' },
              fix_files: { type: 'array', items: { type: 'string' }, description: '修复涉及的文件' },
              blackbox_commands: { type: 'array', items: { type: 'string' }, description: '黑盒验证命令' },
              blackbox_artifacts: { type: 'array', items: { type: 'string' }, description: 'HTTP/CLI 外部验证输出、日志或证据包路径' },
              close_reason: { type: 'string', description: '关闭原因' },
              false_positive_reason: { type: 'string', description: '误报理由' },
              residual_risk: { type: 'string', description: '残余风险' },
              linked_tasks: { type: 'array', items: { type: 'string' }, description: '关联任务 ID 列表' },
            },
            required: ['id', 'title', 'severity', 'status'],
          },
        },
        required: ['finding'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_bughunt_ledger',
      description: 'Bughunt 模式专用：读取 Bughunt ledger。scope=brief（默认）返回 DAG/finding 态势概览；scope=open 返回未关闭 finding 聚焦列表（可按 severity 过滤）；scope=finding 按 finding_id 返回单个 finding 的完整证据包。',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['brief', 'open', 'finding'],
            description: '读取视图：brief=态势概览（默认）；open=未关闭 finding 列表；finding=单个 finding 完整证据包',
          },
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'], description: '仅 scope=open 有效：只返回指定严重度的未关闭 finding。' },
          finding_id: { type: 'string', description: '仅 scope=finding 有效且必填：Finding ID，例如 F-1' },
        },
        required: [],
      },
    },
  },
];

export {
  BUGHUNT_TOOL_NAMES,
  BUGHUNT_SCAN_TOOL_NAMES,
  BUGHUNT_MODE_TOOL_NAMES,
} from './toolNames.js';

export { WORKFLOW_TOOL_NAMES } from './toolNames.js';

const CONTRACT_SCHEMA = {
  type: 'object',
  description: '可选。强校验契约模板：必须包含 surface/title/content；version 如提供必须为正整数。criteria 可写验收项。最小合法形态：{surface,title,content,version?,criteria?}；不要只传 criteria。',
  properties: {
    surface: { type: 'string', minLength: 1, description: '稳定契约 surface，如 "POST /api/login" 或 "chat.message.api"' },
    title: { type: 'string', minLength: 1, description: '契约标题' },
    content: { type: 'string', minLength: 1, description: '契约正文：字段、行为、边界、验收口径' },
    version: { type: 'integer', minimum: 1, description: '正整数版本号，省略时默认 v1' },
    criteria: { type: 'array', items: { type: 'string', minLength: 1 }, description: '验收项列表' },
  },
  required: ['surface', 'title', 'content'],
  additionalProperties: false,
};

const EVALUATION_POLICY_SCHEMA = {
  type: 'object',
  description: '可选。结构化评估策略；不要写自然语言猜测，不要传 confidence。adaptive 使用 difficulty_signals；speculation/adversarial 使用下列固定字段。',
  properties: {
    required_evidence: { type: 'array', items: { type: 'string', minLength: 1 }, description: '必须产出的证据清单，例如外部来源、API 测试结果、定向测试命令。' },
    critical_gates: { type: 'array', items: { type: 'string', minLength: 1 }, description: '关键验收 gate 清单；任一失败则任务不应完成。' },
    max_repair: { type: 'integer', minimum: 0, description: '最多允许修复轮数，非负整数。' },
    evaluator_role: { type: 'string', minLength: 1, description: '可选。评估/验收角色。' },
    adaptive: {
      type: 'object',
      description: '自适应编排信号；禁止 confidence。新调用只使用 difficulty_signals 的 snake_case 字段。',
      properties: {
        difficulty_signals: {
          type: 'object',
          properties: {
            impact_ratio: { type: 'number', minimum: 0, description: '影响范围比例，可为小数。' },
            hotspot_overlap: { type: 'integer', minimum: 0, description: '与热点区域重叠数量，非负整数。' },
            cross_module_deps: { type: 'integer', minimum: 0, description: '跨模块依赖数量，非负整数。' },
            prior_failures: { type: 'integer', minimum: 0, description: '历史失败次数，非负整数。' },
            total_project_files: { type: 'integer', minimum: 0, description: '可选。项目文件总量，非负整数。' },
            has_ambiguous_path: { type: 'boolean', description: '是否存在不明确实现路径。' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    speculation: {
      type: 'object',
      description: '投机执行策略。',
      properties: {
        enabled: { type: 'boolean', description: '是否启用投机执行' },
        selection_policy: { type: 'string', enum: ['first_green', 'fewest_changes', 'fastest_tests'], description: '分支选择策略' },
        max_branches: { type: 'integer', minimum: 1, maximum: 6, description: '最大并行分支数' },
        timeout_ms: { type: 'integer', minimum: 1, description: '超时毫秒数' },
        alternatives: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1, description: '分支 ID' },
              label: { type: 'string', description: '分支标签' },
              strategy_prompt: { type: 'string', description: '策略提示词' },
              working_directory: { type: 'string', description: '工作目录' },
              write_scope: { type: 'array', items: { type: 'string', minLength: 1 }, description: '写入范围' },
            },
            required: ['id'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    adversarial: {
      type: 'object',
      description: '对抗验证策略。',
      properties: {
        enabled: { type: 'boolean', description: '是否启用对抗验证' },
        timeout_ms: { type: 'integer', minimum: 1, description: '超时毫秒数' },
        strategies: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1, description: '策略 ID' },
              type: { type: 'string', enum: ['command'], description: '策略类型' },
              command: { type: 'string', minLength: 1, description: '执行命令' },
              args: { type: 'array', items: { type: 'string' }, description: '命令参数' },
              expected_exit_code: { type: 'integer', description: '期望退出码' },
              fail_on_exit_code: { type: 'integer', description: '失败退出码' },
            },
            required: ['id', 'type', 'command'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

// ─── Leader 元工具：带 Leader 状态副作用，由 LeaderToolsExecutor 直接处理 ───
export const LEADER_META_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: '任务创建原语：创建单个 OrchestrationNode，派发由 dispatch_agent 执行。DAG 依赖用 blocked_by，验收语义用 contract/evaluation_policy。新建角色附带 role_definition 一步完成。多任务并行须 write_scope 两两正交。参数优先级和分组见各参数 description。',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: '任务标题(祈使句)' },
          description: { type: 'string', description: '任务的详细执行目标：具体写清用户意图、范围、关键文件、实现目标和验收标准。' },
          context: {
            type: 'string',
            description: '【强烈建议填写】Worker 启动时的背景知识包：用户原始需求摘要、已知的关键文件/路径/技术栈、前置调研结论、验收标准。越具体 Worker 越少走弯路。',
          },
          agent_type: { type: 'string', description: '角色类型：预设角色或自定义角色名，由 Leader 按任务契约选择（建议显式提供）。容错：未注册的变体名/缩写按名字归约到规范角色(fe→frontend, be→backend, ui→ux_designer...)，归约不到回落 fullstack；完全省略也回落 fullstack。要新建专用角色请改用 role_definition。' },
          role_definition: {
            type: 'object',
            description: '可选。当 agent_type 尚不存在时，可在创建任务时直接附带角色定义，一次调用完成"创建角色 + 创建任务"。',
            properties: {
              role_name: { type: 'string', description: '角色名称；通常与 agent_type 一致。若省略，创建的角色使用 agent_type。' },
              base_role: { type: 'string', description: '可选。基于预设角色增强时的基线，可填 research/coding/verify/review/frontend/backend/fullstack/qa/ux_designer/planner/evaluator/architect 或其短形(fe/be/ui...)，系统按名字归约。' },
              role_description: { type: 'string', description: '角色职责描述' },
              system_prompt: { type: 'string', description: '该角色的系统提示词，定义其行为和能力' },
              tools: {
                type: 'array',
                items: { type: 'string' },
                description: '该角色请求使用的工具列表',
              },
              skill_names: {
                type: 'array',
                items: { type: 'string' },
                description: '显式指定的技能列表。Leader 必须从当前 skills 摘要中按任务契约选择，系统只校验存在性并注入',
              },
            },
            required: ['role_description', 'system_prompt', 'tools'],
          },
          blocked_by: {
            type: 'array',
            items: { type: 'string' },
            description: '依赖的任务ID列表。修改相同文件的任务必须串行化，如 ["T-1"]',
          },
          working_directory: {
            type: 'string',
            description: '可选。该任务默认工作的目录，必须位于当前 workspace 内。',
          },
          worktree_policy: {
            type: 'string',
            enum: ['none', 'session', 'task', 'auto'],
            description: '可选。任务工作树隔离策略：none=沿用当前 workspace；session=使用当前会话目录；task=为该任务创建独立 git worktree，并将 working_directory/write_scope 映射到该 worktree；auto=对实现/修复/重构类任务自动使用 task，对调研/验收类保持 none。',
          },
          write_scope: {
            type: 'array',
            items: { type: 'string' },
            description: '可选。该任务允许写入的目录或文件根路径列表，必须位于当前 workspace 内。',
          },
          contract: {
            ...CONTRACT_SCHEMA,
            description: `${CONTRACT_SCHEMA.description} 提供后任务将作为统一编排节点参与 evaluation/verdict/repair 流程，并写入 contract:<surface> 黑板节点。`,
          },
          contract_surface: {
            type: 'string',
            description: '可选。跨栈接口/数据契约的稳定 surface，如 "POST /api/login" 或 "chat.message.api"。实现类任务指定后会等待黑板 contract:<surface> 就绪再可派发；node_kind="contract"/architect 任务默认产出该契约而不被它阻塞。',
          },
          contract_version: {
            type: 'integer',
            minimum: 1,
            description: '可选。期望契约正整数版本；用于生成 request_id <surface>@v<N> 与 worker 上下文提示。',
          },
          contract_request_id: {
            type: 'string',
            description: '可选。契约协作 request/ack 的闭环 ID；省略时按 <contract_surface>@v<contract_version|1> 生成。',
          },
          require_contract: {
            type: 'boolean',
            description: '可选。是否把 contract_surface 作为派发前硬 gate；实现类任务默认 true，architect/node_kind=contract 默认 false。',
          },
          require_ack: {
            type: 'boolean',
            description: '可选。是否要求 contract_request_id 的 team request 已闭环后才可派发；默认 false，适合实现后确认类 ack；需要开工前确认时设为 true。',
          },
          evaluation_policy: EVALUATION_POLICY_SCHEMA,
          node_kind: {
            type: 'string',
            enum: ['plan', 'contract', 'implement', 'evaluate', 'repair', 'reset', 'generic'],
            description: '可选。统一编排节点类型；默认 generic。',
          },
          orchestration_run_id: {
            type: 'string',
            description: '可选。指定所属 OrchestrationRun；省略时系统会按当前 session 自动生成。',
          },
          generation: {
            type: 'integer',
            minimum: 0,
            description: '可选。编排 generation，非负整数，用于 reset/repair 后拒绝 stale terminal event。',
          },
          preferred_agent_name: {
            type: 'string',
              description: '可选。未来 dispatch_agent 的 agent_name 约束/提示，不会自动派发。Team 模式下应来自当前 roster；Solo 模式下可作为 ephemeral worker 名字提示。Leader 仍必须显式调用 dispatch_agent，且 agent_name 需与它一致。',
          },
          subsystem: {
            type: 'string',
            description: '可选。声明该任务实现的项目蓝图子系统(需先 define_project_blueprint)。值为当前项目蓝图中的 subsystem id(由你在 define_project_blueprint 自定义)。系统据此登记到蓝图对应子系统;dispatch 前会校验所有 implement 子系统都有任务覆盖,缺口拦截派发。仅 Team 模式下会话已定义项目蓝图时有效；Solo 模式下忽略此参数。',
          },
        },
        required: ['subject', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'define_project_blueprint',
      description: '定义项目蓝图:由你自主列出本项目应包含的全部子系统清单(id/名称/范围/角色/状态/依赖),把"做一个完整项目"展开成你规划的模块矩阵。项目级任务(完整产品/系统/前后端应用)开工前先调用本工具;随后为每个 implement 子系统建 create_task(subsystem=<id>)。dispatch 前系统会校验所有 implement 子系统都有任务覆盖——缺口拦截派发,防止规划坍缩成 MVP。子系统清单 100% 由你定义,系统不预设任何模板;要砍掉某个子系统,在该条目标 status=defer/not_applicable 并附 rationale。',
      parameters: {
        type: 'object',
        properties: {
          subsystems: {
            type: 'array',
            minItems: 1,
            description: '本项目全部子系统清单。每个子系统的 id/名称/范围由你自定义;不在此列出的子系统不在本项目范围内。',
            items: {
              type: 'object',
              properties: {
                subsystem_id: { type: 'string', description: '子系统稳定标识(用作 create_task.subsystem 取值),如 auth/config/api-surface 或你自定义的 slug。全清单内唯一、非空。' },
                name: { type: 'string', description: '子系统中文名(必填),如「认证登录」。' },
                description: { type: 'string', description: '该子系统涵盖范围(必填),如「注册/登录/会话/token 刷新」。' },
                status: { type: 'string', enum: ['implement', 'defer', 'not_applicable'], description: '该子系统的处置,默认 implement。' },
                rationale: { type: 'string', description: 'defer/not_applicable 时必填:为何不做/何时补做;implement 可省略。' },
                agent_type: { type: 'string', description: '可选。该子系统的实现角色(如 backend/frontend/fullstack/verify)。' },
                depends_on: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '可选。该子系统依赖的其它 subsystem_id(必须在本 subsystems 清单内,且整体无环)。系统据此算「可推进子系统」提示按依赖顺序建/派任务;不阻断 dispatch。',
                },
              },
              required: ['subsystem_id', 'name', 'description'],
              additionalProperties: false,
            },
          },
          notes: { type: 'string', description: '可选。蓝图备注(整体取舍/约束)。' },
        },
        required: ['subsystems'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task',
      description: '编辑尚未派发的任务定义，用于修正 Leader 建错的 DAG 节点（标题、描述、角色、依赖、上下文、工作目录/写入范围、预绑定成员），也可补充或修改 contractBinding / evaluation_policy。适用于未分配 Agent 且仍为 dispatchable 的任务；running/terminal 任务通过新任务或重派流程处理。agent_type 同 create_task 支持变体名/缩写归约(fe→frontend 等)与 fullstack 回落。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '要编辑的任务 ID，如 T-3' },
          subject: { type: 'string', description: '可选，新任务标题' },
          description: { type: 'string', description: '可选，新任务描述；必须具体说明目标和验收标准' },
          context: { type: 'string', description: '可选，新任务上下文' },
          agent_type: { type: 'string', description: '可选，新角色类型；未注册的变体名/缩写按名字归约到规范角色(fe→frontend 等)，归约不到回落 fullstack。' },
          blocked_by: { type: 'array', items: { type: 'string' }, description: '可选，完整替换依赖任务 ID 列表' },
          working_directory: { type: 'string', description: '可选，新工作目录' },
          write_scope: { type: 'array', items: { type: 'string' }, description: '可选，完整替换写入范围' },
          preferred_agent_name: { type: 'string', description: '可选，改绑未来 dispatch_agent 的 agent_name 约束/提示；不会自动派发。传空字符串清除预绑定，回到 Leader 显式 dispatch 决策。' },
          contract: {
            ...CONTRACT_SCHEMA,
            description: '可选。补充或替换强校验契约模板；必须包含 surface/title/content，version 如提供必须为正整数。',
          },
          contract_surface: {
            type: 'string',
            description: '可选。补充或修改跨栈接口/数据契约 surface，如 "POST /api/login" 或 "chat.message.api"；会生成/更新 contractBinding.tag=contract:<surface>。',
          },
          contract_version: {
            type: 'integer',
            minimum: 1,
            description: '可选。补充或修改期望契约正整数版本。',
          },
          contract_request_id: {
            type: 'string',
            description: '可选。补充或修改契约 request/ack 闭环 ID；省略时按 <surface>@v<version|1> 生成。',
          },
          require_contract: {
            type: 'boolean',
            description: '可选。是否把 contract_surface 作为派发前硬 gate；实现类任务默认 true，architect/node_kind=contract 默认 false。',
          },
          require_ack: {
            type: 'boolean',
            description: '可选。是否要求 contract_request_id 的 team request 已闭环后才可派发。',
          },
          evaluation_policy: EVALUATION_POLICY_SCHEMA,
          node_kind: {
            type: 'string',
            enum: ['plan', 'contract', 'implement', 'evaluate', 'repair', 'reset', 'generic'],
            description: '可选。补充或修改统一编排节点类型。',
          },
          orchestration_run_id: {
            type: 'string',
            description: '可选。补充或修改所属 OrchestrationRun。',
          },
          generation: {
            type: 'integer',
            minimum: 0,
            description: '可选。补充或修改编排 generation，非负整数，用于 reset/repair 后拒绝 stale terminal event。',
          },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_task',
      description: '删除尚未派发的错误任务节点，并自动从下游任务的 blocked_by 中移除该依赖，保持 DAG 一致。适用于未分配 Agent 且仍为 dispatchable 的任务；running/terminal 任务通过取消、修复或新任务处理。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '要删除的任务 ID，如 T-3' },
          reason: { type: 'string', description: '可选，删除原因' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'define_agent_role',
      description: '动态定义一个新的 Agent 角色。当预设角色覆盖不了任务职责时，创建自定义角色并声明职责、工具和 skills。也可由 create_task 附带 role_definition 一步完成。base_role 支持变体名/缩写归约(fe→frontend, be→backend 等)。',
      parameters: {
        type: 'object',
        properties: {
          role_name: { type: 'string', description: '角色名称，如 "security_auditor", "data_analyst"' },
          base_role: {
            type: 'string',
            description: '可选。基于预设角色增强时的基线，可填 research/coding/verify/review/frontend/backend/fullstack/qa/ux_designer/planner/evaluator/architect 或其短形(fe/be/ui...)，系统按名字归约；省略则按纯自定义角色处理。',
          },
          role_description: { type: 'string', description: '角色职责描述' },
          system_prompt: { type: 'string', description: '该角色的系统提示词，定义其行为和能力' },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description: '该角色请求使用的工具列表。若指定了 base_role，则系统会以预设基线工具为起点并做有边界的增强',
          },
          skill_names: {
            type: 'array',
            items: { type: 'string' },
            description: '可选但强烈建议提供。由 Leader 从当前 skills 摘要中自行挑选多个最相关的 skill 名称，系统会校验并注入给该角色',
          },
        },
        required: ['role_name', 'role_description', 'system_prompt', 'tools'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_available_roles',
      description: '列出所有可用的 Agent 角色（预设+自定义）。create_task/update_task 的 agent_type 接受这些规范名，也接受其变体/缩写(如 backend-agents/fe-1/be_dev)并自动归约，无需精确记忆全名。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dispatch_agent',
      description: '派发原语：启动一个 Agent 执行已通过 create_task 创建且已经出现在任务板上的单个任务。重要前置条件：team 模式下 dispatch_agent 只能派发当前 active team roster 中尚未忙碌的 member；如果当前没有 active team，系统会自动创建一个包含 leader + 目标 agent 的最小 team（无需手动 team_manage）。不要凭空发明 roster 外名字；新增成员先 team_manage edit/add。多 Agent 编排请先 create_task 建完整 DAG，再对 ready 任务显式 dispatch_agent；同批 create_task 后不能引用模型自造 task_id。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '已通过 create_task 创建的任务ID (如 "T-1")。该任务必须已在任务板上且状态为 dispatchable/ready。' },
          agent_name: { type: 'string', description: '当前 active team roster 中一个未忙碌的 member 名字（如 Sam, Lucy）。没有 active team 时系统会自动建团并加入该成员；已有 active team 时必须使用 roster 中的名字，新增成员先 team_manage edit/add。' },
        },
        required: ['task_id', 'agent_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dispatch_batch',
      description: '批量派发原语：一次显式 Leader 工具调用中派发多个已经 ready/dispatchable 的任务。它不自动派发 preferred_agent_name；每一项仍等价于一次 dispatch_agent 校验。Team 模式下每个 agent_name 必须来自当前 active team roster（没有 active team 时系统会自动建团）；Solo 模式下按执行路由策略创建 ephemeral worker。部分成功允许，但结果会逐项返回 ok/skipped/failed。优先把 write_scope 两两正交的 ready 任务批量并行派发（每项一个独立 agent_name）；scope 重叠的任务用 blocked_by 串行，不要同批并行以免撞写。',
      parameters: {
        type: 'object',
        properties: {
          dispatches: {
            type: 'array',
            minItems: 1,
            description: '要派发的任务列表。每项都必须显式给出 task_id 和 agent_name。',
            items: {
              type: 'object',
              properties: {
                task_id: { type: 'string', description: '已存在且 ready/dispatchable 的任务 ID，例如 "T-1"。' },
                agent_name: { type: 'string', description: '显式派发目标 Agent 名字。若任务设置了 preferred_agent_name，必须与其一致。' },
              },
              required: ['task_id', 'agent_name'],
            },
          },
        },
        required: ['dispatches'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'explore',
      description: '一键派发一个只读探索 worker（独立隔离上下文）做广度搜索，结论经 task_complete 异步回流到本上下文，不会把搜索过程/源码正文读进来。适用于需要大范围摸清代码、定位功能或调用关系、理清架构但不想污染主上下文的场景。等价于 create_task(agent_type="explore") + dispatch_agent 一步到位；Solo 下派发 ephemeral worker。返回值包含 task_id 供追踪。探索完成后会收到结论区块（含文件路径:行号）。',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', minLength: 1, description: '探索目标/要回答的事实性问题，越具体越好，如"找到消息总线订阅派发的全部调用路径"。' },
          scope: { type: 'string', description: '可选。探索范围（目录/模块/路径前缀），缩小搜索面。' },
          breadth: { type: 'string', enum: ['medium', 'thorough'], description: '可选。搜索广度：medium=聚焦快速定位（默认）；thorough=多角度穷举。' },
          focus_questions: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            description: '可选。需逐一回答的具体子问题清单，探索结论应逐条覆盖。',
          },
          agent_name: { type: 'string', description: '可选。自定义探索 worker 名字；省略时自动生成唯一 ephemeral 名。' },
        },
        required: ['goal'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message_to_agent',
      description: 'Leader 向运行中的 Agent 发送消息（干预、评价或提供新信息）。方向：Leader → Agent。参数：agent_name + content。与 worker 使用的 send_message（参数：recipient）和 Team 成员间的 team_message（参数：target_type+target）不同，本工具仅 Leader 可用。',
      parameters: {
        type: 'object',
        properties: {
          agent_name: { type: 'string', description: '目标Agent名称' },
          content: { type: 'string', description: '消息内容' },
        },
        required: ['agent_name', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task_status',
      description: '更新任务状态。Worker Agent 完成任务后会自动将任务标记为 completed/failed；Leader 使用本工具处理：1) 手动取消未启动的 pending 任务（→ cancelled）；2) Agent 失败后标记（→ failed/cancelled）；3) 修正错误状态。如果任务已经是 completed，再次调用会被忽略（幂等）。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '任务ID' },
          status: {
            type: 'string',
            enum: ['cancelled', 'failed'],
            description: '目标状态：cancelled=主动取消未派发任务，failed=标记 worker 已挂的任务为失败。Worker 正常完成时由 worker 自身 emit 终态事件。',
          },
        },
        required: ['task_id', 'status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'force_complete_task',
      description: '强制完成团队成员的任务。仅在 Agent 长时间无进展、陷入循环或偏离目标时使用。这是 Leader 的监督职责，但应谨慎使用，给予 Agent 充分机会后再干预。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '要强制完成的任务ID' },
          reason: { type: 'string', description: '强制完成的原因，必须具体说明 Agent 的问题和已等待的时间' },
        },
        required: ['task_id', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'retry_agent_llm',
      description: '重试指定 Agent，无论其当前处于何种状态都尝试激活：运行中的 Agent 会中止当前 LLM 调用并重新发起请求（适用于返回了不完整或错误的响应）；已停止/失败/被终止的 Agent 会自动重开其任务并加载完整历史复活重跑（模型与角色保持不变）。当你想"救回"一个卡死、失败或被误终止的 Agent 时，优先用本工具而不是重建任务。',
      parameters: {
        type: 'object',
        properties: {
          agent_name: { type: 'string', description: '目标 Agent 名称（如 researcher-1、coding-2）' },
          reason: { type: 'string', description: '可选。要求重试的原因说明' },
        },
        required: ['agent_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'nudge_agent',
      description: '向卡住的 Agent 发送干预提示，Agent 收到后将提示注入 system prompt 并改变策略。适用于 Agent 陷入循环、方向错误或长期无进展时。',
      parameters: {
        type: 'object',
        properties: {
          agent_name: { type: 'string', description: '目标 Agent 名称（如 researcher-1、coding-2）' },
          message: { type: 'string', description: '干预提示内容，应具体指出问题和期望的调整方向' },
        },
        required: ['agent_name', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compact_agent_context',
      description: '压缩指定 Agent 的对话上下文：裁剪早期工具结果和图片历史以释放 token 空间。适用于 Agent 上下文膨胀、频繁 413 或 unknown_error 时。此工具只压缩目标 Agent 的上下文。',
      parameters: {
        type: 'object',
        properties: {
          agent_name: { type: 'string', description: '目标 Agent 名称（如 researcher-1、coding-2）' },
        },
        required: ['agent_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_download_link',
      description: '为当前会话中已生成的文件创建临时下载卡片。适用于 PPT/DOCX/PDF/ZIP/图片/任意二进制产物。必须传入已经存在的文件路径；工具只发布下载链接，不负责写文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '已存在文件的绝对路径或相对当前 workspace 的路径。文件必须位于 workspace、session artifacts 或临时上传目录内。' },
          name: { type: 'string', description: '可选，下载时显示的文件名。默认使用 path basename。' },
          mime_type: { type: 'string', description: '可选，文件 MIME 类型。默认按扩展名推断。' },
          expires_in_seconds: { type: 'number', description: '可选，链接有效期，默认 3600 秒，范围 60 秒到 24 小时。' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
name: 'ask_user',
description: '向用户提问或请求关键输入、决策指引。ask_user 必须是本批次最后/唯一工具调用；调用后不要在同一批继续 create_task/dispatch_agent。行为取决于控制模式（manual/eternal），与执行路由模式（direct/hybrid/delegate）无关。\n\n【Manual 控制模式】系统会暂停直到收到所有回复。\n\n【Eternal 控制模式】用户已授权完全自治：调用 ask_user 会把问题反向注入到你自己的对话历史，由你基于现有信息自主决策；下一轮请直接给出答案/继续推进。\n\n【一次性提问原则】每次一次性收集所有当前路径所需信息。优先用 questions 数组，单问题用非空 question + options；question 和 questions 二选一。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', minLength: 1, description: '单个问题文本（与 questions 二选一，单问题场景使用）' },
          options: {
            type: 'array',
            description: '单问题的选项列表（仅在使用 question 时有效）',
            items: {
              type: 'object',
              properties: {
                value: { type: 'string', description: '选项的值' },
                label: { type: 'string', description: '选项的显示文本（可选）' },
              },
              required: ['value'],
            },
          },
          multiSelect: { type: 'boolean', description: '单问题是否多选（默认 false）' },
          questions: {
            type: 'array',
            minItems: 1,
            description: '多问题列表，前端以分步向导展示，用户逐步回答后统一提交。每个问题可有独立选项和多选模式。',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', minLength: 1, description: '问题文本' },
                options: {
                  type: 'array',
                  description: '该问题的选项列表（可选，不提供则为自由输入）',
                  items: {
                    type: 'object',
                    properties: {
                      value: { type: 'string', description: '选项值' },
                      label: { type: 'string', description: '显示文本（可选）' },
                    },
                    required: ['value'],
                  },
                },
                multiSelect: { type: 'boolean', description: '是否允许多选（默认 false）' },
              },
              required: ['question'],
            },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'plan_create',
      description: '创建或替换当前 Leader 执行计划。仅存储 ACTIVE_PLAN 状态；不创建 TaskBoard 任务、不提交审批、不创建 Team、不派发 Agent。',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'Leader 执行计划的当前目标' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '计划项 ID' },
                title: { type: 'string', description: '计划项标题' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'], description: '计划项状态' },
                notes: { type: 'string', description: '计划项备注' },
              },
              required: ['title'],
            },
          },
          reason: { type: 'string', description: '创建或替换计划的原因（可选）' },
        },
        required: ['goal'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'plan_update',
      description: '更新当前 Leader 执行计划并递增版本号。仅存储 ACTIVE_PLAN 状态；不修改 TaskBoard 或派发就绪状态。',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: '更新后的计划目标（可选，不传则保留原目标）' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '计划项 ID' },
                title: { type: 'string', description: '计划项标题' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'], description: '计划项状态' },
                notes: { type: 'string', description: '计划项备注' },
              },
              required: ['title'],
            },
          },
          reason: { type: 'string', description: '更新原因（可选）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'plan_checkpoint',
      description: '向当前 Leader 执行计划追加叙事检查点。仅用于可见性/恢复状态，不阻塞执行。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '检查点摘要' },
          reason: { type: 'string', description: '追加检查点的原因（可选）' },
        },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'plan_finalize',
      description: '终结当前 Leader 执行计划（completed/cancelled/superseded）。不结束会话，不要求 TaskBoard 全部终态。',
      parameters: {
        type: 'object',
        properties: {
          final_status: { type: 'string', enum: ['completed', 'cancelled', 'superseded'], description: '终结状态：completed=完成，cancelled=取消，superseded=被新计划取代' },
          summary: { type: 'string', description: '终结总结（可选）' },
        },
        required: ['final_status'],
      },
    },
  },
  {
    type: 'function',
    function: {
name: 'submit_plan',
description: '提交当前的完整执行方案。行为取决于控制模式（manual/eternal），与执行路由模式（direct/hybrid/delegate）无关。\n\n【Manual 控制模式】进入 pending_review 等待用户批准。\n\n【Eternal 控制模式】用户已授权自治，方案被自动批准并落入对话历史，应立即按方案派发 ready 任务。',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: '最终目标' },
          analysis: { type: 'string', description: '现状分析及技术根因' },
          approach: { type: 'string', description: '核心步骤及实现方案' },
          risks: { type: 'string', description: '潜在风险或副作用' },
          verification: { type: 'string', description: '验证方案' },
        },
        required: ['goal', 'analysis', 'approach'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish_session',
      description: '结束整个会话并生成总结。仅当任务板全部为终态且没有 running worker 时调用；仍有开放任务/运行中 Agent 时，用普通回复、write_work_note 或继续验收，不要用 finish_session 做阶段总结。调用前回顾本轮会话是否有值得记录到长期记忆的内容（架构决策、技术选型、用户偏好、关键发现），有稳定价值时先调用 learn_soul 写入项目级/用户级记忆再结束。行为取决于控制模式（manual/eternal），与执行路由模式（direct/hybrid/delegate）无关。\n\n【Manual 控制模式】正常结束会话。\n\n【Eternal 控制模式】发布阶段性总结并进入 idle 待命；EternalLoop 继续巡逻。用户显式切回 manual 后，可用此工具结束会话。完成工作后默认进入待命，用户明确要求结束时再调用此工具。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '本次会话的成果总结' },
        },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'complete_eternal_goal',
      description: '标记当前 Eternal 目标为已完成。仅当有充分证据证明目标已达成时调用。调用后 goal 被清除，自动切回 manual 模式，Leader 进入 idle 待命。如需继续可设置新 goal。不要在目标仍有未验证部分时调用。',
      parameters: {
        type: 'object',
        properties: {
          evidence: { type: 'string', description: '目标完成的具体证据（测试通过、构建成功、代码提交等可验证事实）' },
          summary: { type: 'string', description: '目标完成总结，包含完成了什么、关键产出和后续建议' },
        },
        required: ['evidence', 'summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_agent_progress',
      description: '查看正在运行中的某个Agent的最近动作和详细日志。仅在以下情况使用：(1) 系统报告Agent异常、停滞或 watchdog 告警；(2) 长期无任何进度通知且需要判断是否干预；(3) 需要验收完成结果或用户明确询问当前进度。\n\n【等待原则】如果 Agent 最近仍有活动或正在执行工具，不要调用本工具做例行确认；等待 task_complete/failed/watchdog_alert 等自然信号。\n\n【限速原则】对同一Agent每60秒最多调用一次。调用后若Agent仍在正常运行，结束本轮等待自然完成信号。不要用前台 sleep、重复 read_work_notes、team_inbox 或文件树扫描来制造观察窗口；频繁查询对Agent执行无加速作用，只消耗 token。',
      parameters: {
        type: 'object',
        properties: {
          agent_name: { type: 'string', description: '要查看的Agent名称' },
        },
        required: ['agent_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'learn_soul',
      description: '[已废弃] 记忆便捷写入，等价于 memory(action="save", content=..., scope=...)。保留仅为向后兼容，新代码请直接用 memory 工具。底层调用同一个 MemoryManager，写入路径：project=.lingxiao/memory/ 或 user=~/.lingxiao/memory/。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要记录的内容，简洁明了，包含关键信息' },
          scope: {
            type: 'string',
            description: '记忆范围："user" 表示用户级全局记忆，"project" 表示项目专属记忆',
            enum: ['user', 'project'],
          },
        },
        required: ['content', 'scope'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_permission_update',
      description: [
        '请求提升当前 session 的权限模式或网络权限。调用后会等待用户批准或拒绝。',
        '',
        '普通 Leader 自发提权：不要传 request_id/worker_name。',
        'worker 权限请求：只有当系统明确要求你代 worker 转发时才调用，并必须原样回传 request_id 和 worker_name 两个字段；如果报告写着“系统已自动向用户发起审批，无需再调”，不要调用本工具。',
        '看到 "--- 来自 Agent @xxx 的权限请求 ---" 报告时，把里面的 request_id / worker_name 一字不差地填到工具参数里——',
        '不知道 request_id 时直接省略，不要传空字符串。',
        '一旦丢失，worker 会卡在 waitForMessageType 里直到超时（默认 30s ~ 5min），表现为"权限已批准但 agent 没动"。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['leader', 'worker'], description: '可选。leader=Leader 自发提权；worker=代 worker 转发审批。worker 场景必须提供 request_id 和 worker_name。' },
          reason: { type: 'string', description: '为什么需要提权' },
          mode: {
            type: 'string',
            enum: ['strict', 'dev', 'networked', 'yolo'],
            description: '请求切换到的权限模式',
          },
          allowed_hosts: {
            type: 'array',
            items: { type: 'string' },
            description: '如果请求 networked，可附带要访问的 allowlist hosts',
          },
          request_id: {
            type: 'string',
            minLength: 1,
            description: 'worker 触发时必传：从权限请求报告里复制 request_id 原文，用于回传 permission_response。普通 Leader 自发提权不要传；不知道时省略，不要传空字符串。',
          },
          worker_name: {
            type: 'string',
            minLength: 1,
            description: 'worker 触发时必传：从权限请求报告里复制 worker_name 原文。漏传 permission_response 无法路由到 worker 的 bus。',
          },
          tool_name: { type: 'string', description: '触发该请求的工具名' },
        },
        required: ['reason', 'mode', 'tool_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pause_agent',
      description: '暂停指定 Agent（保留进度，可随时恢复）。适用于需要临时释放资源或等待外部条件时。',
      parameters: {
        type: 'object',
        properties: {
          agent_name: { type: 'string', description: '目标 Agent 名称' },
        },
        required: ['agent_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resume_agent',
      description: '恢复暂停的 Agent 继续执行。',
      parameters: {
        type: 'object',
        properties: {
          agent_name: { type: 'string', description: '目标 Agent 名称' },
        },
        required: ['agent_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'intervene_agent',
      description: '干预指定 Agent：停下来，注入指令，等待用户确认后再继续。适用于需要 Agent 改变方向但不想终止时。',
      parameters: {
        type: 'object',
        properties: {
          agent_name: { type: 'string', description: '目标 Agent 名称' },
          instruction: { type: 'string', description: '干预指令内容，应具体说明需要调整的方向' },
        },
        required: ['agent_name', 'instruction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'terminate_agent',
      description: '完全终止指定 Agent（不可恢复，丢弃进度）。硬性要求：调用前必须先对同一 Agent 调用 check_agent_progress，并基于检查结果确认无进展、工具卡死、心跳丢失或破坏性行为；禁止只根据 task_board、DAG、运行时间、主观“卡住”判断终止。优先使用 nudge_agent / retry_agent_llm / intervene_agent。仅在 Agent 严重偏离目标、产生破坏性操作，或 check_agent_progress 明确显示不可继续时使用。',
      parameters: {
        type: 'object',
        properties: {
          agent_name: { type: 'string', description: '目标 Agent 名称' },
          reason: { type: 'string', description: '终止原因，必须至少 10 个字符' },
        },
        required: ['agent_name', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirm_intervention',
      description: '确认干预，让已收到干预指令的 Agent 带着新指令继续执行。',
      parameters: {
        type: 'object',
        properties: {
          agent_name: { type: 'string', description: '目标 Agent 名称' },
        },
        required: ['agent_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_work_note',
      description: '写入当前 Agent 的工作笔记，记录当前进展摘要。默认自动使用当前 agentId/taskId。每次任务完成或重要阶段调用。包含 phase、summary、details、artifacts、keyFindings、impactAnalysis，并写入实质进展与可追踪证据。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '任务 ID；通常省略，使用当前上下文 taskId' },
          phase: { type: 'string', enum: ['research', 'coding', 'testing', 'reviewing', 'other'], description: '当前阶段' },
          summary: { type: 'string', description: '一句话摘要（实质内容，非模板）' },
          details: { type: 'string', description: '可选，详细说明' },
          artifacts: { type: 'array', items: { type: 'string' }, description: '可选，涉及的文件列表' },
          blockers: { type: 'array', items: { type: 'string' }, description: '可选，阻塞项列表' },
          nextSteps: { type: 'array', items: { type: 'string' }, description: '可选，下一步建议' },
          keyFindings: { type: 'array', items: { type: 'string' }, description: '可选，关键发现（文件路径:行号 — 说明）' },
          impactAnalysis: { type: 'string', description: '可选，改动影响范围分析' },
        },
        required: ['phase', 'summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_work_note',
      description: '请求某个 Agent 更新工作笔记。是 send_message_to_agent 的便捷包装：底层通过消息总线发送 request_work_note 事件，目标 Agent 收到后主动更新笔记。与 send_message_to_agent 的区别：本工具只触发“更新笔记”动作，不能传自定义消息内容。',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: '目标 Agent ID' },
        },
        required: ['agentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_work_notes',
      description: '读取工作笔记。可过滤指定 Agent 或任务。用于了解前序任务结论或其他 Agent 进展。',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: '可选，按 Agent ID 过滤' },
          taskId: { type: 'string', description: '可选，按任务 ID 过滤' },
          limit: { type: 'number', description: '可选，返回条数上限（默认 10）' },
        },
        required: [],
      },
    },
  },
];
