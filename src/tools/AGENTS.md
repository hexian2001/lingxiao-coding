# 工具系统指南

> 真源以代码为准，本文件只给导航，避免再次与实现对齐漂移。

## 单一事实源

| 关注点 | 路径 |
|--------|------|
| 内置注册 | `src/tools/index.ts`（`buildBuiltinToolSpecs` / `NON_CORE_TOOLS`） |
| Worker 白名单 | `src/contracts/constants/rolePresets.ts` → `WORKER_TOOLS` |
| 模式门控工具名 | `src/contracts/constants/toolNames.ts` + `src/contracts/modes.ts` |
| Leader 元工具 schema | `src/contracts/constants/leaderToolDefinitions.ts` |
| 元数据（tier/visibility） | `src/contracts/types/ToolMetadata.ts`（`tools/ToolMetadata.ts` re-export） |
| 执行与 fail-closed | `src/tools/Registry.ts` + `src/core/ModeToolPolicy.ts` |

不变量测试：`scripts/canonical-source-invariants.test.mjs`。

## 分层

1. **Worker 工具**：`WORKER_TOOLS` 白名单 ∩ ToolRegistry；再经 mode / ToolPruner 裁剪。
2. **Leader 元工具**：`LEADER_META_TOOLS` + `BUGHUNT_TOOLS`，`scope: leader`。
3. **模式注入**：office / workflow / bughunt 关闭时 fail-closed。
4. **门面工具**：`blackboard` / `workflow` / `office_ops` / `team_*` / `mcp` 用 `action` 分派内部实现。
5. **HTTP Office 生成**：`Generate{Docx,Pptx,Pdf,Xlsx}Tool` 仅服务 `/api/v1/office/generate`，**不**进 agent 工具面；agent 用 shell + 库生成。

## 常用工具（摘要）

- 文件：`file_read` / `file_create` / `structured_patch` / `list_dir` / `glob` / `code_search` / `ast_query`
- 执行：`shell` / `get_terminal_output` / `terminal_control` / `python_exec` / `git` / `node_repl`
- 网络：`web_fetch` / `web_search` / `http_request` / `mcp`
- 浏览器：`browser_action` / `browser_visual_verify` / `screenshot` / `ocr`
- 协作：`send_message` / `write_work_note` / `team_*` / `attempt_completion`
- Office 模式：`office_ops` / `parse_file`
- Canvas 闭环（Leader）：`canvas_save_sourcemap` / `canvas_push_version` / `canvas_get_state`
- 蓝图：`define_project_blueprint` / `add_subsystem` / `update_subsystem` / `delete_subsystem`

## 扩展

- 用户工具：`settings.tools.user_defined` + `UserToolFactory`
- 实验 LSP：`LINGXIAO_EXPERIMENTAL_LSP=1`
- 循环防护默认开：`LINGXIAO_TOOL_LOOP_DETECTOR` / `LINGXIAO_TOOL_FAILURE_LOOP_GUARD`（设 `0` 关闭）
