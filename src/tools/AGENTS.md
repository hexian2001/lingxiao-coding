# 工具系统使用指南

> 凌霄提供 23 个工具，分为 5 大类，支持文件操作、代码执行、搜索、网络和 UI 交互

## 快速导航

- [返回根目录](../AGENTS.md)
- [文件操作工具](#文件操作工具)
- [代码执行工具](#代码执行工具)
- [搜索工具](#搜索工具)
- [网络工具](#网络工具)
- [UI 交互工具](#ui-交互工具)

## 工具架构

### 工具接口

**文件**: `src/tools/Tool.ts`

```typescript
export interface Tool {
  name: string;
  description: string;
  parameters: ZodSchema;
  execute(args: unknown, context?: ToolContext): Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  data: unknown;
  error?: string;
}
```

### 工具上下文

每个工具执行时都会收到上下文信息：

```typescript
export interface ToolContext {
  db?: DatabaseManager;
  sessionId?: string;
  agentId?: string;
  workspace?: string;
  emitter?: EventEmitter;
  permissionContext?: PermissionContext;
  llm?: LLMClient;
  // ... 更多上下文
}
```

## 文件操作工具

### FileRead - 读取文件

**用途**: 读取文件内容，支持分段读取

**参数**:
- `path` (string): 文件路径
- `start_line` (number, 可选): 起始行号（1-indexed）
- `end_line` (number, 可选): 结束行号

**示例**:
```json
{
  "path": "src/agents/LeaderAgent.ts",
  "start_line": 100,
  "end_line": 200
}
```

**注意事项**:
- 默认读取前 2000 行
- 超过 2000 行的文件需要分段读取
- 二进制文件会被自动检测并拒绝

### FileEdit - 编辑文件

**用途**: 精确搜索替换（支持多行）

**参数**:
- `path` (string): 文件路径
- `search` (string): 要查找的内容（必须精确匹配）
- `replace` (string): 替换后的内容

**示例**:
```json
{
  "path": "src/config.ts",
  "search": "const MAX_TOKENS = 8192;",
  "replace": "const MAX_TOKENS = 16384;"
}
```

**注意事项**:
- `search` 必须精确匹配（包括空格、换行）
- 如果找到多处匹配会报错（需要提供更长的唯一上下文）
- 支持 5MB 以下文件，更大文件建议用 Shell + sed

### FileCreate - 创建文件

**用途**: 创建新文件

**参数**:
- `path` (string): 文件路径
- `content` (string): 文件内容

**示例**:
```json
{
  "path": "src/utils/helper.ts",
  "content": "export function helper() {\n  return 'hello';\n}"
}
```

**注意事项**:
- 如果文件已存在会报错
- 自动创建父目录
- 需要 `file_create` 权限

### StructuredPatch - 原子结构化补丁

**用途**: 一次应用多个 hunk，支持精确替换、行范围替换和按行号插入。修改前仍必须先用 FileRead 确认当前内容和行号。

**Hunk 形态**:
- 精确替换: `{"search":"原文","replace":"新内容","replace_all":false}`
- 第 N 处替换: `{"search":"重复原文","replace":"新内容","occurrence":2}`，`occurrence` 只接受 1-based 数字、`"first"` 或 `"last"`，不能和 `replace_all` 同时使用
- 行范围替换: `{"start_line":10,"end_line":12,"replace":"新内容"}`
- 按行插入: `{"insert_after_line":42,"content":"要插入的内容"}`；`0` 表示文件开头，文件总行数表示文件末尾
- 文本锚点插入: `{"insert_after":"原文锚点","content":"要插入的内容","occurrence":1}`；锚点重复时必须指定 `occurrence`（可用 `"last"`）或改用 `insert_after_line`
- 文件末尾追加: `{"content":"要追加的内容"}` / `{"insert_at":"end","content":"要追加的内容"}` / 顶层直接传 `content`
- 文件开头插入: `{"insert_at":"start","content":"要插入的内容"}`
- hunk 容器写法: `hunks` 只接受数组或单个 object；`hunk` 只接受单个 object。
- 字段和值必须使用 canonical schema 形态；旧式字段名、容器别名、JSON 字符串容器、字符串布尔值和同义词值会被拒绝。

**注意事项**:
- 长文档追加优先用 `content` 或 `insert_at:"end"`，避免为了追加内容构造超长 search。
- `insert_after_line=0` 表示文件开头，`insert_after_line=总行数` 表示文件末尾。
- 插入内容按字面值写入，不会额外合成空行。
- search 命中多处时，工具会返回 `STRUCTURED_PATCH_AMBIGUOUS_SEARCH`、匹配上下文、`occurrence_candidates`、行号候选、`if_appending_examples` 和可直接复制的 `retry_args`；只改某一处时优先用 `retry_args.first_occurrence` 或 `retry_args.last_occurrence`，确认全部命中都要改时才用 `retry_args.replace_all`。如果只是追加长文档，直接用 `retry_args.append_eof`、顶层 `content` 或 `hunk:{"content":"..."}`。
- `insert_after` 命中多处时，工具会返回 `STRUCTURED_PATCH_AMBIGUOUS_INSERT_AFTER`、`occurrence_candidates`、`insert_after_line_candidates` 和 `retry_args`；优先用 `retry_args.first_occurrence` 或 `retry_args.last_occurrence`，也可改用明确行号。
- 如果你已经明确知道重复匹配时要选哪一处，可直接传 `on_ambiguous:"first"`、`on_ambiguous:"last"` 或 `on_ambiguous:"replace_all"`；这等价于显式 `occurrence` / `replace_all`，默认不写时仍保持严格报错。
- hunk 容器结构错误会进入工具自己的 `llm_recovery`，不应退化成 `hunks.0: Invalid input`；容器必须是 object 或 object array。

## 代码执行工具

### Shell - 执行命令

**用途**: 执行 shell 命令

**参数**:
- `command` (string): 要执行的命令
- `cwd` (string, 可选): 工作目录

**示例**:
```json
{
  "command": "npm test",
  "cwd": "/path/to/project"
}
```

**注意事项**:
- 危险命令会被权限系统拦截（rm -rf, dd, etc.）
- 默认超时 120 秒
- 支持沙箱隔离（app-guard/bubblewrap）
- 输出超过 100KB 会被截断

### Python - 执行 Python 代码

**用途**: 执行 Python 脚本

**参数**:
- `code` (string): Python 代码
- `cwd` (string, 可选): 工作目录

**示例**:
```json
{
  "code": "import sys\nprint(sys.version)"
}
```

**注意事项**:
- 需要系统安装 Python
- 支持沙箱隔离
- 默认超时 120 秒

## 搜索工具

### CodeSearch - 代码搜索

**用途**: 在代码库中搜索关键词

**参数**:
- `query` (string): 搜索关键词
- `file_pattern` (string, 可选): 文件模式（如 `*.ts`）
- `case_sensitive` (boolean, 可选): 是否区分大小写

**示例**:
```json
{
  "query": "LeaderAgent",
  "file_pattern": "*.ts"
}
```

**注意事项**:
- 基于 ripgrep，速度快
- 自动排除 node_modules、dist 等目录
- 返回文件路径 + 行号 + 匹配内容

### Glob - 文件模式匹配

**用途**: 按模式查找文件

**参数**:
- `pattern` (string): glob 模式
- `path` (string, 可选): 搜索路径

**示例**:
```json
{
  "pattern": "src/**/*.test.ts"
}
```

**注意事项**:
- 支持标准 glob 语法（`*`, `**`, `?`, `[]`）
- 默认返回 100 个结果
- 按修改时间排序

### Grep - 内容搜索

**用途**: 在文件中搜索内容（支持正则）

**参数**:
- `pattern` (string): 搜索模式（正则表达式）
- `path` (string, 可选): 搜索路径
- `glob` (string, 可选): 文件过滤
- `output_mode` (string, 可选): 输出模式（content/files_with_matches/count）

**示例**:
```json
{
  "pattern": "function.*Agent",
  "glob": "*.ts",
  "output_mode": "content"
}
```

**注意事项**:
- 基于 ripgrep
- 支持完整正则表达式语法
- 支持多行匹配（`multiline: true`）

## 网络工具

### WebFetch - 获取网页

**用途**: 获取网页内容并转为 Markdown

**参数**:
- `url` (string): 网页 URL
- `prompt` (string): 提取指令

**示例**:
```json
{
  "url": "https://example.com/docs",
  "prompt": "提取所有 API 端点"
}
```

**注意事项**:
- HTML 自动转 Markdown
- 支持 15 分钟缓存
- 超大页面会被摘要

### WebSearch - 网络搜索

**用途**: 搜索网络内容

**参数**:
- `query` (string): 搜索关键词
- `topic` (string, 可选): 搜索领域（general/news/programming/documentation）

**示例**:
```json
{
  "query": "TypeScript async await best practices",
  "topic": "programming"
}
```

**注意事项**:
- 返回搜索结果摘要
- 支持领域优化
- 自动去重

## UI 交互工具

### AskUserQuestion - 询问用户

**用途**: 向用户提问并获取选择

**参数**:
- `questions` (array): 问题列表
  - `question` (string): 问题文本
  - `header` (string): 简短标签（≤12字符）
  - `options` (array): 选项列表
    - `label` (string): 选项标签
    - `description` (string): 选项说明
  - `multiSelect` (boolean, 可选): 是否多选

**示例**:
```json
{
  "questions": [
    {
      "question": "选择要使用的数据库？",
      "header": "数据库",
      "options": [
        {
          "label": "PostgreSQL",
          "description": "强大的关系型数据库"
        },
        {
          "label": "MongoDB",
          "description": "灵活的文档数据库"
        }
      ]
    }
  ]
}
```

**注意事项**:
- 最多 4 个问题
- 每个问题 2-4 个选项
- 用户可以选择"Other"输入自定义答案

### Canvas - 画布操作

**用途**: 在 Canvas 画布上创建节点和连接

**参数**:
- `action` (string): 操作类型（create_node/create_edge/update_node）
- `nodeType` (string): 节点类型（prompt/tool/output）
- `data` (object): 节点数据

**示例**:
```json
{
  "action": "create_node",
  "nodeType": "prompt",
  "data": {
    "label": "分析代码",
    "prompt": "分析 src/ 目录下的代码质量"
  }
}
```

### Terminal - 终端操作

**用途**: 在 Web UI 终端中执行命令

**参数**:
- `command` (string): 要执行的命令
- `terminalId` (string, 可选): 终端 ID

**示例**:
```json
{
  "command": "ls -la",
  "terminalId": "term-1"
}
```

## 工具注册与扩展

### 注册新工具

**文件**: `src/tools/Registry.ts`

1. 创建工具类（继承 `Tool`）
2. 在 Registry 中注册

```typescript
// src/tools/implementations/MyTool.ts
export class MyTool extends Tool {
  readonly name = 'my_tool';
  readonly description = '我的工具';
  readonly parameters = z.object({
    input: z.string()
  });

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof this.parameters>;
    // 实现逻辑
    return { success: true, data: 'result' };
  }
}

// src/tools/Registry.ts
import { MyTool } from './implementations/MyTool.js';

export class ToolRegistry {
  constructor() {
    this.register(new MyTool());
    // ...
  }
}
```

### 工具权限配置

**文件**: `src/core/PermissionSystem.ts`

```typescript
const TOOL_PERMISSIONS = {
  'file_read': 'allow',      // 自动通过
  'structured_patch': 'ask', // 请求确认
  'shell': 'ask',            // 请求确认
  'dangerous_tool': 'deny'   // 直接拒绝
};
```

### 工具过滤

**按角色过滤**:

```typescript
// src/agents/roles/researcher.ts
export const researcherRole: AgentRole = {
  name: 'researcher',
  tools: ['FileRead', 'CodeSearch', 'WebFetch', 'WebSearch'],
  // 只能使用这 4 个工具
};
```

**按 Skill 过滤**:

```typescript
// skills/bundled/my-skill/SKILL.md
allowed_tools:
  - FileRead
  - CodeSearch
```

## 工具最佳实践

### 文件操作

1. **先读后写**: 修改文件前先用 FileRead 读取
2. **精确匹配**: FileEdit 的 search 要精确复制原文
3. **分段读取**: 大文件用 start_line/end_line 分段
4. **批量操作**: 多次修改同一文件用 FileMultiEdit
5. **长文档追加**: 用 StructuredPatch 的 `insert_after_line`，不要硬凑重复 heading 的 search

### 代码执行

1. **检查输出**: Shell 命令输出可能很长，注意截断
2. **设置 cwd**: 明确指定工作目录
3. **错误处理**: 检查 exit code 和 stderr
4. **超时控制**: 长时间运行的命令考虑后台执行

### 搜索

1. **选择合适工具**: 
   - 文件名 → Glob
   - 文件内容 → Grep/CodeSearch
   - 代码符号 → CodeSearch
2. **缩小范围**: 使用 file_pattern/glob 过滤
3. **正则优化**: Grep 支持正则，但要注意性能

### 网络

1. **缓存利用**: WebFetch 有 15 分钟缓存
2. **提示词优化**: WebFetch 的 prompt 要明确
3. **领域指定**: WebSearch 指定 topic 提高相关性

## 工具调试

### 查看工具调用

**Web UI → Logs 页面**:
- 筛选 `tool_call` 事件
- 查看输入参数
- 查看输出结果

### 工具执行日志

**文件**: `~/.lingxiao/logs/tools.log`

```
[2026-05-11 10:30:00] FileRead: src/agents/LeaderAgent.ts
[2026-05-11 10:30:01] FileEdit: src/config.ts (success)
[2026-05-11 10:30:02] Shell: npm test (exit code: 0)
```

### 权限问题排查

1. 检查 `~/.lingxiao/settings.json` 权限配置
2. 查看 Logs 页面的 `permission_denied` 事件
3. 确认工具在角色的 tools 列表中

## 相关文档

- [Agent 系统](../agents/AGENTS.md) — Leader-Worker 架构
- [开发约定](../../CONVENTIONS.md) — 编码规范
- [返回根目录](../../AGENTS.md) — 项目概览
