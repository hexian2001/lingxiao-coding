export function buildBughuntRequest(rawTarget: string): string {
  const target = rawTarget.trim() || '当前工作区';
  return `
[BUGHUNT_MODE]
目标：${target}

进入凌霄 Autonomous Bughunt 模式。你不是在做普通 review，而是在自主组织一个“扫描建图 → 白盒审计 → 插桩复现 → 编译/运行验证 → 黑盒验证 → 修复复审”的安全调查闭环。遇到外部凭证、破坏性操作、联网目标授权或范围冲突时请求用户输入；其他情况自行拆解、调度、验证和收敛。

自主执行原则：
1. 先用 set_bughunt_dag 建立调查调度核心 DAG：节点含 id、phase、role、objective、read_scope、write_scope、blocked_by（拓扑依赖）、evidence_gate（结构化硬门控）、expected_artifact、task_id。DAG 是单一真相源——节点就绪须经拓扑序 + blocked_by 全 completed + evidence_gate 通过三者同时满足。证据改变时可修订；worker 完成后对应节点自动回写 completed 解锁后继。用 get_ready_dag_nodes 查询就绪候选，再经 dispatch_agent 派发（不自动派发）。
2. 推荐五类认知工作：
   - Surface Map：入口、信任边界、权限边界、文件/网络/命令/数据库边界、关键状态机。
   - Scan Triage：bughunt scan 结果只产生 hypothesis / likely 候选，记录 rule、CWE/OWASP、文件、证据缺口。
   - Whitebox Confirm：读取源码补 source、sink、trust_boundary、taint_path、preconditions、impact；只有白盒链路成立才进入 confirmed。
   - Repro & Instrument：为高价值候选创建最小复现、测试、临时 orchestration scaffold、断言、trace/probe 或外部驱动脚本。
   - Compile/Blackbox Verify & Close：编译、类型检查、测试、构建、启动服务、HTTP/CLI 外部验证；修复后复跑并复审关闭。
3. Ledger 是外部记忆：重要 finding、证据、复现 artifact、插桩 artifact、编译/测试命令、黑盒命令和关闭原因应通过 upsert_bughunt_finding 记录。探索先记粗，再逐步补证据。
4. 工具经济：先 grep/list/read 建图；发现具体证据缺口才运行 shell；需要复现或 confirmed fix 时才写文件。读取和命令围绕假设、证据缺口、复现信号或修复验证展开。
5. 证据门槛：
   - likely：需要扫描/源码证据或明确 evidence_gap。
   - confirmed：需要 affected files + source evidence + source/sink、taint_path、whitebox_artifacts 或 repro_artifact。
   - fixed：需要 confirmed 级证据 + fix_files。
   - verified：需要 confirmed 级证据 + compile/test 信号 + blackbox_commands + 黑盒输出证据或 artifact。用 verify_finding 工具跑真实执行（compile 层必跑 compile_commands 捕获 exit_code；blackbox 层需 authorize_blackbox=true，默认关闭），产物回写 compile_artifacts/blackbox_artifacts——verified 门认真实执行产物，不接受 LLM 手填。
   - closed/false_positive：需要 close_reason、residual_risk 或 false_positive_reason，报告必须区分真实风险和误报。
6. 插桩规则：插桩应最小、可回滚、局部化，优先测试/orchestration scaffold；必须临时改生产代码时，同步说明 cleanup。
7. 修复规则：优先修 confirmed 的 HIGH/CRITICAL 或用户指定范围；修复 Agent 应拿到复现步骤和 expected failing/passing signal，并基于证据做最小修复。
8. 收尾前读取 ledger 或 open findings，确保最终报告区分 confirmed / likely / hypothesis / false_positive / blocked，并包含 CWE/OWASP、source/sink、taint_path、evidence、repro/whitebox/instrumentation artifact、compile commands、fix files、blackbox commands、close reason、residual risk。

有效工具优先级：
- scan phase（优先）：调用已注册的 bughunt_full_scan，一次获取 ast-grep + 内建 OWASP + js-x-ray + tsc + npm audit + semgrep 的结构化报告；可用 skipSemgrep / skipTsc / skipNpmAudit 跳过单项。扫描输出的 suggested_findings 只能作为 hypothesis/likely。
- read phase：code_search / glob / list_dir / file_read，批量并行，目标是建立入口、边界、调用链和风险 map。
- evidence phase：shell 只运行能证明/证伪假设的命令；优先最小测试和插桩，再局部构建，最后全量构建。
- write phase：structured_patch 只用于测试插桩、orchestration scaffold 或 confirmed fix；每个写任务应有明确 write_scope。
- communication：send_message 用于传递证据缺口、复现信号、修复约束和需要 Leader/用户决策的阻塞。
[/BUGHUNT_MODE]`.trim();
}
