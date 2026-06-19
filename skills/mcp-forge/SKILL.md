---
name: mcp-forge
description: "MCP Forge — 自动生成、验证并注册 MCP Server 的技能。当用户需要创建新的 MCP Server、将外部 API 封装为 MCP 工具、或用模板生成 MCP 服务时触发。覆盖需求分析→模板选择→代码生成→沙箱验证→Inspector 校验→自动注册全流程。"
---

# MCP Forge Skill

> 本技能指导 Agent 使用凌霄 MCP Forge 子系统，从自然语言需求描述自动生成可运行的 MCP Server。

## 1. 概述

MCP Forge 是凌霄内置的 MCP Server 代码生成引擎。它接收自然语言需求描述，通过 LLM 驱动的需求分析选择合适的代码模板，生成完整的服务端代码，在沙箱中编译运行验证，用 MCP Inspector 校验工具协议合规性，最终将验证通过的服务自动注册到凌霄 MCP 配置中。

**核心价值**：将"从想法到可运行 MCP Server"的周期从数小时缩短到分钟级。

**适用场景**：
- 用户说"帮我创建一个 MCP Server 来……"
- 用户需要将外部 REST API 封装为 MCP 工具
- 用户需要快速搭建 stdio 或 HTTP 传输的 MCP 服务
- 用户想用 Python FastMCP 或 Node.js MCP SDK 生成服务端代码

## 2. 触发决策规则

在以下任一条件满足时触发 MCP Forge 流程：

| 触发条件 | 示例用户意图 |
| --- | --- |
| 用户明确要求创建/生成 MCP Server | "帮我生成一个 MCP Server"、"创建一个 MCP 服务" |
| 用户要求将 API 封装为 MCP 工具 | "把这个 REST API 包装成 MCP 工具"、"让 MCP 能调用这个 API" |
| 用户描述了工具功能并提到 MCP | "我需要一个 MCP 工具来查天气" |
| 用户要求用模板生成服务端代码 | "用 FastMCP 模板生成一个服务" |
| 用户要求自动化 MCP Server 生命周期 | "自动生成并注册一个 MCP Server" |

**不触发的场景**：
- 用户只是查询现有 MCP Server 列表或状态 → 使用 `mcp` 工具的 `list_servers`
- 用户要求修改已有 MCP Server 配置 → 引导使用 settings.mcp.servers 或 Web UI
- 用户要求安装第三方 MCP Server → 引导使用 marketplace 安装流程

## 3. 生成流程编排

MCP Forge 采用 15 状态状态机驱动流水线，完整流程如下：

```
用户需求描述
     │
     ▼
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────┐
│  createJob   │────▶│   分析需求    │────▶│  生成代码    │────▶│  沙箱验证    │────▶│ Inspector    │────▶│  注册    │
│  (pending)   │     │ (analyzing)  │     │ (generating) │     │ (validating) │     │ 校验+注册    │     │(completed)│
└─────────────┘     └──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘     └──────────┘
                           │                     │                     │                     │
                     analysis_failed       generation_failed     validation_failed     registration_failed
```

### 执行模式

Agent 可选择两种执行模式：

1. **一键模式（推荐）**：调用 `runPipeline(jobId)` 自动从 `pending` 执行到 `completed`，遇错自动停在对应的 `*_failed` 状态
2. **逐步模式**：调用 `advance(jobId)` 逐阶段推进，适合需要人工审查中间结果的场景

### 状态流转详解

| 当前状态 | advance() 动作 | 成功后状态 | 失败状态 |
| --- | --- | --- | --- |
| `pending` | LLM 需求分析 | `analyzed` | `analysis_failed` |
| `analyzed` | 代码生成 | `generated` | `generation_failed` |
| `generated` | 沙箱编译+运行+Inspector | `validated` 或 `validation_skipped` | `validation_failed` |
| `validated` / `validation_skipped` | 注册到 settings.mcp.servers | `registered` | `registration_failed` |
| `registered` | 标记完成 | `completed` | — |

### 失败恢复

任一阶段失败后，可通过 `retry(jobId)` 从失败点恢复：
- `analysis_failed` → 重新分析 (`analyzing`)
- `generation_failed` → 重新生成 (`generating`)
- `validation_failed` → 重新验证 (`validating`)
- `registration_failed` → 重新注册 (`registering`)

也可随时 `cancel(jobId)` 取消作业。

## 4. 模板选择决策树

MCP Forge 内置 3 种代码模板，LLM 需求分析阶段会根据需求特征自动选择：

```
                    用户需求
                       │
              ┌────────┴────────┐
              ▼                 ▼
        需要封装外部 API?    需要新建本地服务?
              │                 │
     ┌────────┴────────┐   ┌────┴────┐
     ▼                 ▼   ▼         ▼
  HTTP API        其他   Python    Node.js
  Wrapper                偏好?     偏好?
     │                 │     │         │
     ▼                 │     ▼         ▼
 http-api-wrapper      │  python-     nodejs-
                        │  fastmcp-    stdio
                        │  stdio       │
                        ▼              │
                   默认 python-fastmcp-stdio
```

### 模板对比

| 模板 ID | 语言 | 传输方式 | 框架 | 适用场景 |
| --- | --- | --- | --- | --- |
| `python-fastmcp-stdio` | Python | stdio | FastMCP | 本地工具、脚本集成、快速原型 |
| `nodejs-stdio` | TypeScript | stdio | @modelcontextprotocol/sdk | Node.js 生态工具、前端团队偏好 |
| `http-api-wrapper` | TypeScript | streamable-http | @modelcontextprotocol/sdk | 封装外部 REST API 为 MCP 工具 |

### 选择规则

1. **如果需求涉及封装现有 REST/HTTP API** → 选择 `http-api-wrapper`
   - 用户提到"封装 API"、"代理 HTTP 接口"、"包装 REST 服务"
   - 需要设置 `API_BASE_URL` 和 `API_KEY` 占位符

2. **如果用户偏好 Python 或未指定语言** → 选择 `python-fastmcp-stdio`
   - 默认模板，FastMCP 框架代码最简洁
   - 适合数据处理、文件操作、系统管理类工具

3. **如果用户偏好 Node.js/TypeScript** → 选择 `nodejs-stdio`
   - 用户提到 "Node.js"、"TypeScript"、"npm"
   - 适合前端生态集成、与 JS 工具链协作

### 占位符

每个模板包含占位符，在代码生成阶段由 LLM 填充：

| 占位符 | 适用模板 | 必填 | 说明 |
| --- | --- | --- | --- |
| `SERVER_NAME` | 全部 | 是 | 服务名称（PascalCase） |
| `SERVER_ID` | 全部 | 是 | 服务 ID（kebab-case，注册用） |
| `TOOL_NAME` | python/nodejs | 是 | 工具函数名 |
| `TOOL_DESCRIPTION` | python/nodejs | 是 | 工具描述 |
| `API_BASE_URL` | http-api-wrapper | 是 | 上游 API 地址 |
| `API_KEY` | http-api-wrapper | 否 | 上游 API key（写入 .env） |
| `PORT` | http-api-wrapper | 否 | HTTP 监听端口（默认 3000） |
| `AUTHOR` | 全部 | 否 | 作者名（默认 Anonymous） |

## 5. forge-core 接口映射

McpForge 核心引擎提供 9 个编程接口，Agent 通过 REST API 或直接编程调用：

| 方法 | 编程接口签名 | REST 端点 | 说明 |
| --- | --- | --- | --- |
| `createJob` | `createJob(request: ForgeRequest): ForgeJob` | `POST /api/v1/mcp-forge/jobs` | 创建生成作业 |
| `runPipeline` | `runPipeline(jobId: string): Promise<ForgeJob>` | `POST /api/v1/mcp-forge/jobs/:id/run` | 一键执行完整流水线 |
| `advance` | `advance(jobId: string): Promise<ForgeJob>` | `POST /api/v1/mcp-forge/jobs/:id/advance` | 执行下一步 |
| `getJob` | `getJob(jobId: string): ForgeJob \| undefined` | `GET /api/v1/mcp-forge/jobs/:id` | 查询作业详情 |
| `listJobs` | `listJobs(): ForgeJob[]` | `GET /api/v1/mcp-forge/jobs` | 列出所有作业 |
| `cancel` | `cancel(jobId: string): ForgeJob` | `POST /api/v1/mcp-forge/jobs/:id/cancel` | 取消作业 |
| `retry` | `retry(jobId: string): ForgeJob` | `POST /api/v1/mcp-forge/jobs/:id/retry` | 重试失败作业 |
| `listTemplates` | `listTemplates(): TemplateMetadata[]` | `GET /api/v1/mcp-forge/templates` | 列出可用模板 |
| `getTemplate` | `getTemplate(id: TemplateId): TemplateMetadata` | `GET /api/v1/mcp-forge/templates/:id` | 获取模板详情 |

### ForgeRequest 结构

```typescript
interface ForgeRequest {
  description: string;      // 自然语言需求描述（必填）
  serverName: string;       // 服务器名称（必填）
  templateId?: string;      // 指定模板（可选，不指定则 LLM 自动选择）
  options?: {
    transport?: 'stdio' | 'streamable-http';  // 传输方式
    skipValidation?: boolean;                  // 跳过沙箱验证
    skipInspector?: boolean;                   // 跳过 Inspector 校验
    sandboxTimeoutMs?: number;                 // 沙箱超时（默认 30000ms）
    llmModel?: string;                         // 指定 LLM 模型
    customEnv?: Record<string, string>;        // 沙箱环境变量
    autoRegister?: boolean;                    // 自动注册（默认 true）
  };
}
```

### ForgeJob 结构

```typescript
interface ForgeJob {
  id: string;
  state: ForgeJobState;        // 15 种状态之一
  request: ForgeRequest;
  analysis?: ForgeAnalysis;     // 需求分析结果
  generatedCode?: GeneratedCode;// 生成的代码
  validationResult?: ValidationResult; // 验证结果
  registeredServer?: RegisteredServer; // 注册信息
  error?: ForgeErrorData;       // 错误详情
  progress: number;             // 0-100
  stepHistory: ForgeStepRecord[]; // 步骤历史
  createdAt: number;
  updatedAt: number;
}
```

### SSE 事件流

通过 `GET /api/v1/mcp-forge/jobs/:id/events` 订阅作业事件流：

```
event: state_change
data: {"jobId":"...","state":"analyzing","progress":10,"message":"Starting requirement analysis"}

event: log
data: {"jobId":"...","message":"Analysis complete: 2 tools, template: python-fastmcp-stdio"}

event: progress
data: {"jobId":"...","progress":50,"message":"Code generation complete"}

event: error
data: {"jobId":"...","message":"Sandbox timeout","state":"validation_failed"}
```

## 6. 错误码处理指引

MCP Forge 定义 15 个错误码，Agent 应根据错误码决定恢复策略：

| 错误码 | HTTP 状态 | 可重试 | 含义与处理建议 |
| --- | --- | --- | --- |
| `FORGE_INVALID_REQUEST` | 400 | 否 | 请求参数无效（description/serverName 为空）。**处理**：修正参数后重新 createJob |
| `FORGE_TEMPLATE_NOT_FOUND` | 404 | 否 | 指定的 templateId 不存在。**处理**：调用 listTemplates 获取可用模板列表 |
| `FORGE_ANALYSIS_FAILED` | 500 | 是 | LLM 需求分析失败。**处理**：retry 重试；连续失败检查 LLM 可用性 |
| `FORGE_GENERATION_FAILED` | 500 | 是 | 代码生成失败。**处理**：retry 重试；检查 LLM 配置和模板占位符 |
| `FORGE_SANDBOX_TIMEOUT` | 504 | 是 | 沙箱执行超时。**处理**：增大 sandboxTimeoutMs 后 retry |
| `FORGE_SANDBOX_CRASH` | 500 | 是 | 沙箱进程崩溃。**处理**：retry；检查生成代码是否有致命错误 |
| `FORGE_SANDBOX_STARTUP_FAILED` | 500 | 是 | 沙箱启动失败（如缺少运行时）。**处理**：检查 Python/Node.js 环境 |
| `FORGE_INSPECTOR_CONNECT_FAILED` | 502 | 是 | Inspector 无法连接生成的服务。**处理**：retry；检查端口占用 |
| `FORGE_VALIDATION_MISMATCH` | 422 | 是 | 工具协议校验不通过（tools/list 或 tools/call 失败）。**处理**：检查生成代码的 tool schema |
| `FORGE_REGISTRATION_FAILED` | 500 | 是 | 注册到 settings.mcp.servers 失败。**处理**：retry；检查配置文件写入权限 |
| `FORGE_SERVER_ID_CONFLICT` | 409 | 否 | serverId 已存在。**处理**：更换 serverId 或先删除已有配置 |
| `FORGE_STATE_VIOLATION` | 409 | 否 | 非法状态转换（如对终态作业调用 advance）。**处理**：检查 job.state，仅对非终态操作 |
| `FORGE_LLM_UNAVAILABLE` | 503 | 是 | LLM 服务不可用。**处理**：检查 OPENAI_BASE_URL/OPENAI_API_KEY 配置；稍后重试 |
| `FORGE_INTERNAL_ERROR` | 500 | 是 | 内部未预期错误。**处理**：retry；查看日志定位问题 |
| `FORGE_JOB_NOT_FOUND` | 404 | 否 | 作业 ID 不存在。**处理**：调用 listJobs 确认作业 ID |

### 错误处理决策树

```
收到错误响应
    │
    ├── retryable = true ?
    │   ├── 是 → 调用 retry(jobId) 重试（最多 3 次）
    │   │         ├── 重试成功 → 继续流水线
    │   │         └── 重试 3 次仍失败 → 向用户报告错误详情
    │   └── 否 → 根据错误码采取特定操作：
    │       ├── FORGE_INVALID_REQUEST → 修正请求参数
    │       ├── FORGE_TEMPLATE_NOT_FOUND → 用 listTemplates 确认可用模板
    │       ├── FORGE_SERVER_ID_CONFLICT → 更换 serverId
    │       ├── FORGE_STATE_VIOLATION → 检查 job 状态后再操作
    │       └── FORGE_JOB_NOT_FOUND → 用 listJobs 确认作业
    │
    └── 错误持续无法恢复 → 向用户报告 error.code + error.message + error.detail
```

## 7. 编排步骤指南

Agent 收到 MCP Server 生成需求后的标准操作序列：

### 步骤 1：确认需求

从用户描述中提取：
- **serverName**：服务名称（必填）
- **description**：功能需求描述（必填，尽量详细）
- **templateId**：用户是否指定模板（可选）
- **options**：传输方式、是否跳过验证等（可选）

### 步骤 2：创建作业

调用 `createJob` 创建作业，获取 `jobId`：

```
POST /api/v1/mcp-forge/jobs
{
  "description": "创建一个查询天气的 MCP 工具，输入城市名返回天气信息",
  "serverName": "weather-server"
}
```

### 步骤 3：执行流水线

**推荐一键模式**：
```
POST /api/v1/mcp-forge/jobs/{jobId}/run
```

或逐步执行：
```
POST /api/v1/mcp-forge/jobs/{jobId}/advance  # 分析
POST /api/v1/mcp-forge/jobs/{jobId}/advance  # 生成
POST /api/v1/mcp-forge/jobs/{jobId}/advance  # 验证
POST /api/v1/mcp-forge/jobs/{jobId}/advance  # 注册
POST /api/v1/mcp-forge/jobs/{jobId}/advance  # 完成
```

### 步骤 4：监控进度

通过 SSE 事件流或轮询 `getJob` 监控进度：
```
GET /api/v1/mcp-forge/jobs/{jobId}/events   # SSE 实时事件
GET /api/v1/mcp-forge/jobs/{jobId}          # 轮询状态
```

### 步骤 5：处理结果

- **成功**（state = `completed`）：向用户报告注册的 serverId 和工具列表
- **失败**（state = `*_failed`）：按错误码处理指引操作
- **用户取消**：调用 `cancel(jobId)`

## 8. 输入校验规则

Agent 在调用 createJob 前应进行前端校验，减少无效请求：

| 字段 | 规则 | 错误码 |
| --- | --- | --- |
| `description` | 非空，trim 后长度 > 0 | `FORGE_INVALID_REQUEST` |
| `serverName` | 非空，trim 后长度 > 0 | `FORGE_INVALID_REQUEST` |
| `templateId` | 若指定，必须是 3 个合法 ID 之一 | `FORGE_TEMPLATE_NOT_FOUND` |
| `options.sandboxTimeoutMs` | 若指定，须为正整数 | `FORGE_INVALID_REQUEST` |
| `options.transport` | 若指定，须为 `stdio` 或 `streamable-http` | `FORGE_INVALID_REQUEST` |

### 安全边界

- **API Key 处理**：`API_KEY` 占位符的值通过环境变量注入，不硬编码到生成代码中
- **沙箱隔离**：生成的代码在独立子进程中编译运行，有超时保护
- **注册冲突检测**：注册前检查 serverId 是否已存在，冲突时返回 `FORGE_SERVER_ID_CONFLICT`
- **敏感数据脱敏**：错误响应中不包含环境变量值或 API key

## 9. 典型示例

### 示例 1：生成 Python 天气查询 MCP Server

**用户意图**："帮我创建一个 MCP Server，用 Python 写，能查询城市天气"

**Agent 操作**：

```bash
# 1. 创建作业
curl -X POST http://localhost:3000/api/v1/mcp-forge/jobs \
  -H "x-lingxiao-token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "查询城市天气信息，输入城市名返回当前天气（温度、湿度、天气描述）",
    "serverName": "weather-server",
    "templateId": "python-fastmcp-stdio"
  }'
# 返回: { "success": true, "data": { "id": "fj_abc123", "state": "pending", ... } }

# 2. 一键执行流水线
curl -X POST http://localhost:3000/api/v1/mcp-forge/jobs/fj_abc123/run \
  -H "x-lingxiao-token: $TOKEN"
# 返回: { "success": true, "data": { "id": "fj_abc123", "state": "completed", ... } }

# 3. 查看结果
curl http://localhost:3000/api/v1/mcp-forge/jobs/fj_abc123 \
  -H "x-lingxiao-token: $TOKEN"
# data.analysis.tools = [{ name: "get_weather", ... }]
# data.registeredServer.serverId = "weather-server"
```

**预期结果**：
- 生成 `weather-server.py` + `requirements.txt` + `README.md`
- 注册到 `settings.mcp.servers` 的 `weather-server` 条目
- 工具 `get_weather` 可通过 `mcp` 工具调用

### 示例 2：封装 REST API 为 HTTP MCP Server

**用户意图**："把 GitHub API 封装成一个 MCP Server，能查仓库信息和提交记录"

**Agent 操作**：

```bash
# 1. 创建作业（指定 http-api-wrapper 模板）
curl -X POST http://localhost:3000/api/v1/mcp-forge/jobs \
  -H "x-lingxiao-token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "封装 GitHub REST API，提供两个工具：(1) get_repo 查询仓库信息，输入 owner/repo 返回仓库详情；(2) list_commits 列出最近提交，输入 owner/repo 和可选 limit",
    "serverName": "github-api-server",
    "templateId": "http-api-wrapper",
    "options": {
      "transport": "streamable-http",
      "customEnv": { "API_BASE_URL": "https://api.github.com" }
    }
  }'

# 2. 执行流水线
curl -X POST http://localhost:3000/api/v1/mcp-forge/jobs/{jobId}/run \
  -H "x-lingxiao-token: $TOKEN"
```

**预期结果**：
- 生成 TypeScript HTTP MCP Server，监听 3000 端口
- 两个工具：`get_repo` 和 `list_commits`
- 注册为 `streamable-http` 传输类型

### 示例 3：逐步执行 + 失败重试

**用户意图**："创建一个文件系统操作 MCP Server，用 Node.js"

**Agent 操作**：

```bash
# 1. 创建作业
curl -X POST http://localhost:3000/api/v1/mcp-forge/jobs \
  -H "x-lingxiao-token: $TOKEN" \
  -d '{
    "description": "文件系统操作工具：列出目录、读取文件、写入文件",
    "serverName": "fs-server",
    "templateId": "nodejs-stdio"
  }'

# 2. 逐步执行 — 分析
curl -X POST http://localhost:3000/api/v1/mcp-forge/jobs/{jobId}/advance \
  -H "x-lingxiao-token: $TOKEN"
# state: pending → analyzed

# 3. 逐步执行 — 生成
curl -X POST http://localhost:3000/api/v1/mcp-forge/jobs/{jobId}/advance \
  -H "x-lingxiao-token: $TOKEN"
# state: analyzed → generated

# 4. 逐步执行 — 验证（假设沙箱超时失败）
curl -X POST http://localhost:3000/api/v1/mcp-forge/jobs/{jobId}/advance \
  -H "x-lingxiao-token: $TOKEN"
# state: generated → validation_failed (FORGE_SANDBOX_TIMEOUT)

# 5. 重试（增大超时时间后重新验证）
# 注意：retry 将状态从 validation_failed 恢复到 validating
curl -X POST http://localhost:3000/api/v1/mcp-forge/jobs/{jobId}/retry \
  -H "x-lingxiao-token: $TOKEN"
# state: validation_failed → validating

# 6. 继续推进
curl -X POST http://localhost:3000/api/v1/mcp-forge/jobs/{jobId}/advance \
  -H "x-lingxiao-token: $TOKEN"
# state: validating → validated

curl -X POST http://localhost:3000/api/v1/mcp-forge/jobs/{jobId}/advance \
  -H "x-lingxiao-token: $TOKEN"
# state: validated → registered → completed
```

## 10. 集成与依赖

### 上游依赖

| 组件 | 契约 surface | 说明 |
| --- | --- | --- |
| McpForge 核心引擎 | `mcp-forge-core` v1 | 15 状态状态机 + 编程接口 |
| 模板库 | `mcp-forge-templates` v1 | 3 种代码模板 |
| REST API | `mcp-forge-api` v1 | 14 个 HTTP 端点 + SSE |
| 鉴权 | `api` v1 | `requireServerToken` 中间件 |

### 下游消费者

| 消费者 | surface | 说明 |
| --- | --- | --- |
| Web UI Forge 页面 | `mcp-forge-ui` | 可视化生成流程界面 |
| CLI `/mcp forge` | — | 命令行交互 |
| Agent 自动调用 | — | 通过 REST API 或编程接口 |

### 注册链路

生成的 MCP Server 注册到 `settings.mcp.servers`，复用现有配置 schema：

```json
// settings.mcp.servers 新增条目示例
{
  "weather-server": {
    "command": "python",
    "args": ["/path/to/weather-server.py"],
    "env": {},
    "transport": "stdio"
  }
}
```

注册后可通过 `mcp(action="list_servers")` 发现，通过 `mcp(action="call_tool", ...)` 调用工具。

### 环境变量

| 变量名 | 用途 | 必填 |
| --- | --- | --- |
| `OPENAI_BASE_URL` | LLM 网关地址（需求分析+代码生成） | 是 |
| `OPENAI_API_KEY` | LLM 网关密钥 | 是 |
| `OPENAI_MODEL` | LLM 模型名 | 否（有默认值） |
| `x-lingxiao-token` | REST API 鉴权 header | 是（调用 API 时） |
