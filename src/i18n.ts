/**
 * i18n 国际化模块
 *
 * 所有用户可见的字符串都从此模块获取，按区域切换。
 * 新增字符串时，必须同时提供 zh 和 en 两种语言。
 */

export type Language = 'zh' | 'en';

/**
 * 所有可翻译的 key 的完整枚举
 */
export type I18nKey =
  // === LLM 错误标签 ===
  | 'error.connect_timeout'
  | 'error.request_timeout'
  | 'error.stream_timeout'
  | 'error.network_error'
  | 'error.provider_error'
  | 'error.rate_limited'
  | 'error.context_overflow'
  | 'error.auth_error'
  | 'error.quota_exhausted'
  | 'error.parse_error'
  | 'error.unknown_error'
  // === 心跳进度状态 ===
  | 'progress.connecting'
  | 'progress.waiting_response'
  | 'progress.processing'
  // === Leader 等待状态 ===
  | 'leader.waiting_model'
  | 'leader.organizing_context'
  | 'leader.planning_next'
  | 'leader.still_working'
  // === TurnCoordinator 状态摘要 ===
  | 'turn.waiting_permission'
  | 'turn.waiting_permission_tool'
  | 'turn.waiting_review'
  | 'turn.waiting_user_answer'
  | 'turn.waiting_user_answer_preview'
  | 'turn.session_idle_waiting_instruction'
  | 'turn.waiting_user_input'
  | 'turn.user_intervention'
  | 'turn.user_intervention_preview'
  | 'turn.processing_user_input'
  | 'turn.processing_user_input_preview'
  | 'turn.waiting_workers'
  | 'turn.worker_recovery'
  | 'turn.leader_processing_dispatchable'
  | 'turn.leader_processing_session'
  | 'turn.session_idle'
  | 'permission.status.waiting_approval'
  | 'leader.status.processing_user_input'
  // === LLM 日志前缀 ===
  | 'llm.request_failed'
  | 'llm.stream_failed'
  | 'llm.stream_timeout'
  | 'llm.empty_messages'
  | 'llm.anthropic.request_failed'
  | 'llm.anthropic.stream_failed'
  // === Agent 状态 ===
  | 'agent.llm_retrying'
  | 'leader.llm_retrying'
  // === 通用 ===
  | 'context.empty_response_retry'
  // === CLI 欢迎与初始化 ===
  | 'cli.welcome'
  | 'cli.init_detect_no_config'
  // === CLI Provider 选择 ===
  | 'cli.provider_prompt'
  | 'cli.provider_option_openai'
  | 'cli.provider_option_anthropic'
  | 'cli.provider_option_auto'
  | 'cli.provider_choice_prompt'
  // === CLI 自动检测配置 ===
  | 'cli.auto_detect_config'
  | 'cli.auto_detect_hint'
  | 'cli.api_key_prompt'
  | 'cli.api_key_step'
  | 'cli.base_url_prompt'
  | 'cli.detected_provider'
  // === CLI 模型选择 ===
  | 'cli.model_select_step'
  | 'cli.model_select_hint'
  | 'cli.model_leader_prompt'
  | 'cli.model_agent_prompt'
  | 'cli.model_custom_input'
  | 'cli.model_same_as_leader'
  | 'cli.model_diff_agent_prompt'
  | 'cli.model_selected'
  // === CLI 配置保存 ===
  | 'cli.current_config'
  | 'cli.config_save_failed'
  | 'cli.config_saved'
  | 'cli.check_permissions_hint'
  // === CLI 命令描述 ===
  | 'cli.command_start'
  | 'cli.command_init'
  | 'cli.command_list'
  | 'cli.command_demo'
  | 'cli.command_doctor'
  | 'cli.command_about'
  // === CLI 会话管理 ===
  | 'cli.session_not_found'
  | 'cli.session_resume_hint'
  | 'cli.session_resumed'
  | 'cli.session_count'
  | 'cli.session_status_active'
  | 'cli.session_status_completed'
  // === CLI 关于页面 ===
  | 'cli.about_title'
  | 'cli.about_version'
  | 'cli.about_footer'
  | 'cli.about_author_title'
  | 'cli.about_author_body'
  | 'cli.about_license_title'
  | 'cli.about_license_body'
  | 'cli.about_tech_title'
  | 'cli.about_tech_dynamic'
  | 'cli.about_tech_session'
  | 'cli.about_tech_skills'
  | 'cli.about_tech_typesafe'
  | 'cli.about_tech_permission'
  | 'cli.about_vision_title'
  | 'cli.about_vision_body'
  // === CMD 语言命令 ===
  | 'cmd.language.current'
  | 'cmd.language.changed'
  | 'cmd.language.invalid'
  // === TUI Leader 状态 ===
  | 'tui.leader.awaiting_input'
  | 'tui.leader.label'
  | 'tui.main.log_label'
  | 'tui.exit.goodbye'
  | 'tui.exit.ctrl_c_again'
  | 'tui.exit.input_cleared'
  | 'tui.command.clear_failed'
  | 'tui.command.compact_requested'
  | 'tui.command.compact_failed'
  | 'tui.command.language_changed'
  | 'tui.command.language_usage'
  | 'tui.command.intervene_usage'
  | 'tui.command.intervene_sent'
  | 'tui.command.intervene_failed'
  | 'tui.command.git_load_failed'
  | 'tui.command.config_usage'
  | 'tui.command.reset_view'
  | 'tui.command.error'
  | 'tui.input.target.plan'
  | 'tui.input.target.leader'
  | 'tui.input.route.plan'
  | 'tui.input.route.leader'
  | 'tui.input.route.agent'
  | 'tui.input.placeholder.plan'
  | 'tui.input.placeholder.leader'
  | 'tui.input.placeholder.agent'
  | 'tui.input.route.intervene'
  | 'tui.input.route.command'
  | 'tui.input.route.queued'
  | 'tui.input.route.leader_busy'
  | 'tui.input.route.leader_busy_queue'
  | 'tui.input.badge.intervene'
  | 'tui.input.badge.command'
  | 'tui.input.badge.queued'
  | 'tui.input.badge.processing'
  | 'tui.input.badge.direct'
  | 'tui.input.continue'
  | 'tui.input.processing'
  | 'tui.input.cancel_hint'
  | 'tui.shortcut.compact'
  | 'tui.shortcut.medium'
  | 'tui.shortcut.full'
  | 'tui.mode.header'
  | 'tui.mode.feedback'
  | 'tui.mode.feedback.success'
  | 'tui.mode.feedback.error'
  | 'tui.mode.collaboration'
  | 'tui.mode.route'
  | 'tui.mode.permission'
  | 'tui.mode.compact.collaboration'
  | 'tui.mode.compact.route'
  | 'tui.mode.compact.permission'
  | 'tui.mode.collaboration.solo'
  | 'tui.mode.collaboration.team'
  | 'tui.mode.route.auto'
  | 'tui.mode.route.direct'
  | 'tui.mode.route.hybrid'
  | 'tui.mode.route.delegate'
  | 'tui.mode.route.unknown'
  | 'tui.mode.route.autoHint'
  | 'tui.mode.route.directHint'
  | 'tui.mode.route.delegateHint'
  | 'tui.mode.permission.yolo'
  | 'tui.mode.permission.networked'
  | 'tui.mode.permission.dev'
  | 'tui.mode.permission.strict'
  | 'tui.mode.switched.collaboration'
  | 'tui.mode.switched.route'
  | 'tui.mode.switched.permission'
  | 'tui.mode.error.collaboration'
  | 'tui.mode.error.route'
  | 'tui.mode.error.permission'
  | 'tui.selection.copied'
  | 'tui.paste.unresolved'
  | 'tui.paste.expanded'
  | 'tui.interrupt.done'
  | 'tui.terminal.too_narrow'
  | 'tui.terminal.too_narrow_hint'
  | 'tui.terminal.current_size'
  | 'tui.permission.request_title'
  | 'tui.permission.approve_hint'
  | 'tui.permission.hint.file'
  | 'tui.permission.hint.shell'
  | 'tui.permission.hint.generic'
  | 'tui.permission.check.file'
  | 'tui.permission.check.shell'
  | 'tui.permission.check.network'
  | 'tui.permission.check.generic'
  | 'tui.permission.risk.file'
  | 'tui.permission.risk.shell'
  | 'tui.permission.risk.read'
  | 'tui.permission.risk.search'
  | 'tui.permission.risk.network'
  | 'tui.permission.risk.generic'
  | 'tui.permission.summary.empty'
  | 'tui.permission.summary.call'
  | 'tui.permission.summary.result'
  | 'tui.permission.section.overview'
  | 'tui.permission.section.risk'
  | 'tui.permission.section.preview'
  | 'tui.permission.section.approval'
  | 'tui.permission.label.source'
  | 'tui.permission.label.tool'
  | 'tui.permission.label.reason'
  | 'tui.permission.label.checklist'
  | 'tui.permission.label.risk'
  | 'tui.permission.label.recent_call'
  | 'tui.permission.label.recent_result'
  | 'tui.permission.label.latest_result'
  | 'tui.permission.label.action'
  | 'tui.permission.label.tip'
  | 'tui.permission.action.approve_deny'
  | 'tui.permission.panel_title'
  | 'tui.permission.panel_footer'
  | 'tui.permission.state_updated'
  | 'tui.permission.request_log'
  | 'tui.leader.heartbeat.waiting_model'
  | 'tui.leader.heartbeat.organizing_context'
  | 'tui.leader.heartbeat.planning_next'
  | 'tui.leader.heartbeat.autonomous_recovery'
  | 'tui.leader.heartbeat.autonomous_orchestration'
  | 'tui.leader.heartbeat.working'
  | 'tui.leader.heartbeat.cancel_hint'
  | 'tui.leader.heartbeat.long_stall'
  | 'tui.leader.heartbeat.tool_executing'
  | 'tui.meta.age.seconds'
  | 'tui.meta.age.minutes_seconds'
  | 'tui.meta.age.minutes'
  | 'tui.meta.tool'
  | 'tui.meta.output'
  | 'tui.meta.heartbeat'
  | 'tui.meta.progress'
  | 'tui.meta.backend'
  | 'tui.meta.external_session'
  | 'tui.meta.recovery'
  | 'tui.meta.approvals'
  | 'tui.meta.stream_outputs'
  | 'tui.meta.tasks'
  | 'tui.meta.cwd'
  | 'tui.meta.tabs'
  | 'tui.meta.permission'
  | 'tui.meta.route'
  | 'tui.meta.collaboration'
  | 'tui.meta.unconfigured'
  | 'tui.meta.control'
  | 'tui.meta.control_eternal'
  | 'tui.meta.control_manual'
  | 'tui.meta.eternal'
  | 'tui.meta.queue'
  | 'tui.meta.model'
  | 'tui.meta.tokens'
  | 'tui.meta.running'
  | 'tui.meta.done'
  | 'tui.meta.duration'
  | 'tui.runtime.empty_output'
  | 'tui.runtime.queue'
  | 'tui.runtime.approval'
  | 'tui.runtime.output'
  | 'tui.runtime.terminal'
  | 'tui.runtime.progress'
  | 'tui.runtime.pending'
  | 'tui.runtime.approval_line'
  | 'tui.runtime.output_line'
  | 'tui.runtime.terminal_line'
  | 'tui.runtime.terminal.suspended'
  | 'tui.runtime.terminal.running'
  | 'tui.panel.loading'
  | 'tui.panel.help.close'
  // === 侧边栏 ===
  | 'tui.sidebar.chat'
  | 'tui.sidebar.tasks'
  | 'tui.sidebar.blueprint'
  | 'tui.sidebar.agents'
  | 'tui.sidebar.graph'
  | 'tui.sidebar.git'
  | 'tui.sidebar.memory'
  | 'tui.sidebar.memory_running'
  | 'tui.sidebar.memory_due'
  | 'tui.sidebar.settings'
  | 'tui.sidebar.status'
  | 'tui.sidebar.report'
  | 'tui.sidebar.cost'
  | 'tui.sidebar.mode'
  | 'tui.sidebar.workers'
  | 'tui.sidebar.context'
  | 'tui.sidebar.tokens'
  | 'tui.sidebar.model'
  // === 设置面板 ===
  | 'tui.settings.title'
  | 'tui.settings.help'
  | 'tui.settings.help_nav'
  | 'tui.settings.help_edit'
  | 'tui.settings.group.llm'
  | 'tui.settings.group.agents'
  | 'tui.settings.group.security'
  | 'tui.settings.group.ui'
  | 'tui.graph.title'
  | 'tui.graph.empty_disabled'
  | 'tui.graph.empty'
  | 'tui.graph.more_edges'
  | 'tui.graph.meta'
  | 'tui.git.not_repo'
  | 'tui.git.no_upstream'
  | 'tui.git.summary'
  | 'tui.git.staged'
  | 'tui.git.unstaged'
  | 'tui.git.untracked'
  | 'tui.git.recent_commits'
  | 'tui.git.diff_header'
  | 'tui.git.help'
  | 'tui.report.title'
  | 'tui.report.help'
  | 'tui.modal.resume_title'
  | 'tui.modal.history_title'
  | 'tui.modal.picker_help'
  | 'tui.agent.running_task'
  | 'tui.agent.started_task'
  | 'tui.agent.completed'
  | 'tui.agent.completed_self'
  | 'tui.agent.tool_call'
  | 'tui.agent.tool_result'
  | 'tui.agent.failed'
  | 'tui.agent.heartbeat_wait'
  | 'tui.agent.task_created'
  | 'tui.leader.interrupted'
  | 'tui.leader.session_completed'
  | 'tui.plan.approved'
  | 'tui.plan.rejected'
  | 'tui.plan.rewrite_wait'
  | 'tui.plan.resubmit_wait'
  | 'tui.plan.review_wait'
  | 'tui.plan.submitted'
  | 'tui.event.session_created'
  | 'tui.event.session_failed'
  | 'tui.event.session_deleted'
  | 'tui.event.skills_project'
  | 'tui.event.skills_plugin'
  | 'tui.event.skill_source.project'
  | 'tui.event.skill_source.plugin'
  | 'tui.event.skill_source.global'
  | 'tui.event.skill_source.builtin'
  | 'tui.event.question_required'
  | 'tui.event.control_eternal'
  | 'tui.event.control_manual'
  | 'tui.event.collaboration_mode_changed'
  | 'tui.event.route_changed'
  | 'tui.event.permission_mode_changed'
  | 'tui.event.blackboard_disabled'
  | 'tui.event.llm_retry'
  | 'tui.event.llm_retry_attempt'
  | 'tui.event.network_fluctuation'
  | 'tui.event.agent_crashed'
  | 'tui.event.intervention'
  | 'tui.event.context_overflow'
  | 'tui.event.building_args'
  | 'tui.event.partial_json'
  | 'tui.event.session_synced'
  | 'tui.event.session_switched'
  | 'tui.event.wiki_started'
  | 'tui.event.wiki_completed'
  | 'tui.event.wiki_failed'
  | 'tui.event.unknown_error'
  | 'tui.event.context_compressed'
  | 'tui.event.queue_cleared'
  | 'tui.event.agent_stopped'
  | 'tui.diff.hidden'
  | 'tui.tool.call'
  | 'tui.tool.result'
  | 'tui.message.collapse_long'
  | 'tui.message.hidden_top'
  | 'tui.message.hidden_bottom'
  | 'tui.copy.success'
  | 'tui.copy.code_copied'
  | 'tui.copy.no_code'
  | 'tui.mouse.tracking_on'
  | 'tui.mouse.tracking_off'
  | 'slash.help.title'
  | 'slash.help.image_upload'
  | 'slash.help.image_example'
  | 'slash.help.shortcuts'
  | 'slash.help.ctrl_c'
  | 'slash.help.ctrl_s'
  | 'slash.help.ctrl_q'
  | 'slash.help.ctrl_x'
  | 'slash.help.ctrl_e'
  | 'slash.help.ctrl_n'
  | 'slash.help.ctrl_w'
  | 'slash.help.ctrl_g'
  | 'slash.help.ctrl_digits'
  | 'slash.help.history'
  | 'slash.help.mouse_wheel'
  | 'slash.help.skill'
  | 'slash.category.session'
  | 'slash.category.view'
  | 'slash.category.permission'
  | 'slash.category.project'
  | 'slash.category.model'
  | 'slash.category.tools'
  | 'slash.category.misc'
  // === TUI 任务板 ===
  | 'tui.task.no_tasks'
  | 'tui.task.depends_on'
  | 'tui.task.switch_hint'
  | 'tui.task.total'
  | 'tui.task.pending'
  | 'tui.task.in_progress'
  | 'tui.task.completed'
  // === TUI 团队视图 ===
  | 'tui.team.title'
  | 'tui.team.no_agents'
  | 'tui.team.auto_refresh'
  | 'tui.team.never'
  | 'tui.team.seconds_ago'
  | 'tui.team.minutes_ago'
  | 'tui.team.hours_ago'
  | 'tui.team.pid'
  | 'tui.team.session'
  | 'tui.team.recovery'
  | 'tui.team.stderr'
  | 'tui.team.depends'
  | 'tui.team.stop_hint'
  // === TUI 通知中心 ===
  | 'tui.notification.title'
  | 'tui.notification.empty'
  | 'tui.notification.unread'
  // === TUI 会话状态 ===
  | 'tui.main.no_session'
  | 'tui.session.status_label'
  | 'tui.session.status_field'
  | 'tui.session.workspace'
  | 'tui.permissions.label'
  // === TUI 消息日志 ===
  | 'tui.message.above_hint'
  | 'tui.message.no_messages'
  // === TUI DAG 面板 ===
  | 'tui.dag.status.completed'
  | 'tui.dag.status.in_progress'
  | 'tui.dag.status.pending'
  | 'tui.dag.status.blocked'
  | 'tui.dag.status.failed'
  | 'tui.dag.status.cancelled'
  | 'tui.dag.role.research'
  | 'tui.dag.role.coding'
  | 'tui.dag.role.review'
  | 'tui.dag.role.verify'
  | 'tui.dag.role.frontend'
  | 'tui.dag.role.backend'
  | 'tui.dag.role.qa'
  | 'tui.dag.role.ux_designer'
  | 'tui.dag.empty'
  | 'tui.dag.meta'
  | 'tui.dag.dependency'
  | 'tui.dag.progress'
  | 'tui.suggestions.help'
  | 'tui.error.component_crashed_log'
  | 'tui.error.component_stack_log'
  | 'tui.error.component_error'
  | 'tui.error.component_retry_hint'
  | 'tui.agent.runtime_title'
  | 'tui.agent.heartbeat_ok'
  | 'tui.agent.wait_progress'
  | 'tui.leader.agents_working_one'
  | 'tui.leader.agents_working_many'
  | 'tui.agent.spawn_task_desc'
  | 'tui.modal.task.field.status'
  | 'tui.modal.task.field.type'
  | 'tui.modal.task.field.dependency'
  | 'tui.modal.task.field.directory'
  | 'tui.modal.task.detail_title'
  | 'tui.modal.task.subject'
  | 'tui.modal.task.working_directory'
  | 'tui.modal.task.write_scope'
  | 'tui.plan.dependency'
  | 'tui.plan.status'
  | 'tui.plan.batch'
  | 'tui.plan.title'
  | 'tui.plan.goal'
  | 'tui.plan.analysis'
  | 'tui.plan.approach'
  | 'tui.plan.risks'
  | 'tui.plan.tasks'
  | 'tui.plan.strategy'
  | 'tui.plan.verification'
  | 'tui.plan.approve_hint'
  // === TUI 欢迎界面 ===
  | 'tui.welcome.tagline'
  | 'tui.welcome.motto'
  | 'cli.farewell.motto'
  | 'cli.farewell.session'
  | 'cli.farewell.resume'
  | 'tui.welcome.shortcuts'
  | 'tui.welcome.shortcut.cmd'
  | 'tui.welcome.shortcut.interrupt'
  | 'tui.welcome.shortcut.dag'
  | 'tui.welcome.shortcut.tab'
  // === TUI 工作笔记 ===
  | 'tui.worknotes.title'
  | 'tui.worknotes.empty'
  | 'tui.worknotes.count'
  // === TUI 选择器面板 ===
  | 'tui.picker.empty'
  | 'tui.picker.showing'
  | 'tui.picker.above'
  | 'tui.picker.below'
  // === TUI Agent 状态栏 ===
  | 'tui.agents.running'
  | 'tui.agents.done'
  | 'tui.agents.paused'
  | 'tui.agents.failed'
  // === TUI 命令参数选择器 ===
  | 'tui.cmdpicker.filter'
  | 'tui.cmdpicker.filter_hint'
  | 'tui.cmdpicker.help'
  // === TUI 回退对话框 /rewind ===
  | 'tui.rewind.title'
  | 'tui.rewind.help_pick'
  | 'tui.rewind.help_scope'
  | 'tui.rewind.help_confirm'
  | 'tui.rewind.empty'
  | 'tui.rewind.working_label'
  | 'tui.rewind.files_unit'
  | 'tui.rewind.just_now'
  | 'tui.rewind.minutes_ago'
  | 'tui.rewind.hours_ago'
  | 'tui.rewind.days_ago'
  | 'tui.rewind.target'
  | 'tui.rewind.impact_title'
  | 'tui.rewind.code_label'
  | 'tui.rewind.conv_label'
  | 'tui.rewind.messages_to_delete'
  | 'tui.rewind.no_messages'
  | 'tui.rewind.cross_session_warn'
  | 'tui.rewind.db_only_hint'
  | 'tui.rewind.scope_all'
  | 'tui.rewind.scope_all_desc'
  | 'tui.rewind.scope_code'
  | 'tui.rewind.scope_code_desc'
  | 'tui.rewind.scope_conversation'
  | 'tui.rewind.scope_conversation_desc'
  | 'tui.rewind.confirm_plan'
  | 'tui.rewind.plan_code'
  | 'tui.rewind.plan_conv'
  | 'tui.rewind.plan_conv_none'
  | 'tui.rewind.will_interrupt'
  | 'tui.rewind.confirm_label'
  | 'tui.rewind.cancel'
  // === /rewind 命令文案 ===
  | 'cmd.rewind.no_session'
  | 'cmd.rewind.no_workspace'
  | 'cmd.rewind.load_failed'
  | 'cmd.rewind.empty'
  | 'cmd.rewind.pick_loaded'
  | 'cmd.rewind.working_entry'
  | 'cmd.rewind.cp_not_found'
  | 'cmd.rewind.scope_loaded'
  | 'cmd.rewind.bad_scope'
  | 'cmd.rewind.db_only_conversation'
  | 'cmd.rewind.confirm_ready'
  | 'cmd.rewind.need_confirm'
  | 'cmd.rewind.exec_failed'
  | 'cmd.rewind.done_working'
  | 'cmd.rewind.done'
  | 'cmd.rewind.usage'
  // === TUI 问题对话框 ===
  | 'tui.question.title'
  | 'tui.question.tab_hint'
  | 'tui.question.submit'
  | 'tui.question.cancel'
  | 'tui.question.other'
  | 'tui.question.other_placeholder'
  | 'tui.question.answered'
  | 'tui.question.answered_count'
  | 'tui.question.help_single'
  | 'tui.question.help_multi'
  | 'tui.question.type_answer'
  | 'tui.question.help_multi_step'
  | 'tui.question.help_single_step'
  | 'tui.question.help_text_step'
  | 'tui.question.selected_count'
  | 'tui.question.multi_title'
  // === 运行时错误（throw）===
  | 'error.session_not_found'
  | 'error.role_not_found'
  | 'error.filellock_timeout'
  | 'error.filerdlock_timeout'
  | 'error.filewrlock_timeout'
  | 'error.filellock_timeout_waiting'
  | 'error.filelock_need_readlock'
  | 'error.filelock_need_writelock'
  | 'error.task_out_of_scope'
  | 'error.worktree_not_git'
  | 'error.worktree_path_exists'
  | 'error.worktree_create_failed'
  | 'error.config_validation'
  | 'error.worker_write_failed'
  | 'error.redirect_unsafe'
  | 'error.redirect_limit'
  | 'error.redirect_no_location'
  | 'error.redirect_invalid'
  | 'error.redirect_invalid_url'
  | 'error.summary_empty_response'
  | 'error.skill_not_registered'
  | 'error.path_access_denied'
  | 'error.path_out_of_bounds'
  | 'error.write_out_of_scope'
  | 'error.ocr_file_not_found'
  | 'error.ocr_svg_unsupported'
  | 'error.ocr_invalid_data_uri'
  | 'error.ocr_unknown_source'
  | 'external_agent.role.claude_coding.description'
  | 'external_agent.role.codex_coding.description'
  | 'external_agent.disabled'
  | 'external_agent.command_not_found'
  | 'external_agent.model_missing'
  | 'external_agent.api_key_missing'
  | 'external_agent.base_url_missing'
  | 'external_agent.claude_incompatible'
  | 'external_agent.codex_incompatible'
  | 'external_agent.timeout'
  | 'external_agent.idle_timeout'
  | 'external_agent.terminated'
  | 'external_agent.exit_nonzero'
  // === CLI 运行时提示 ===
  | 'cli.instance_running'
  | 'cli.port_in_use'
  | 'cli.available_skills'
  | 'cli.no_skills'
  ;

export interface I18nStrings {
  // LLM 错误标签
  'error.connect_timeout': string;
  'error.request_timeout': string;
  'error.stream_timeout': string;
  'error.network_error': string;
  'error.provider_error': string;
  'error.rate_limited': string;
  'error.context_overflow': string;
  'error.auth_error': string;
  'error.quota_exhausted': string;
  'error.parse_error': string;
  'error.unknown_error': string;
  // 心跳进度状态
  'progress.connecting': string;
  'progress.waiting_response': string;
  'progress.processing': (seconds: number) => string;
  // Leader 等待状态
  'leader.waiting_model': (seconds: number, cancelHint: string) => string;
  'leader.organizing_context': (seconds: number, cancelHint: string) => string;
  'leader.planning_next': (seconds: number, cancelHint: string) => string;
  'leader.still_working': (seconds: number, cancelHint: string) => string;
  // TurnCoordinator 状态摘要
  'turn.waiting_permission': string;
  'turn.waiting_permission_tool': (toolName: string) => string;
  'turn.waiting_review': string;
  'turn.waiting_user_answer': string;
  'turn.waiting_user_answer_preview': (preview: string) => string;
  'turn.session_idle_waiting_instruction': string;
  'turn.waiting_user_input': string;
  'turn.user_intervention': string;
  'turn.user_intervention_preview': (preview: string) => string;
  'turn.processing_user_input': string;
  'turn.processing_user_input_preview': (preview: string) => string;
  'turn.waiting_workers': (count: number) => string;
  'turn.worker_recovery': (count: number) => string;
  'turn.leader_processing_dispatchable': (count: number) => string;
  'turn.leader_processing_session': string;
  'turn.session_idle': string;
  'permission.status.waiting_approval': string;
  'leader.status.processing_user_input': string;
  // LLM 日志前缀
  'llm.request_failed': string;
  'llm.stream_failed': string;
  'llm.stream_timeout': string;
  'llm.empty_messages': string;
  'llm.anthropic.request_failed': string;
  'llm.anthropic.stream_failed': string;
  // Agent 状态
  'agent.llm_retrying': (attempt: number, maxRetries: number) => string;
  'leader.llm_retrying': (attempt: number, maxRetries: number) => string;
  // 通用
  'context.empty_response_retry': string;
  // CLI 欢迎与初始化
  'cli.welcome': string;
  'cli.init_detect_no_config': string;
  // CLI Provider 选择
  'cli.provider_prompt': string;
  'cli.provider_option_openai': string;
  'cli.provider_option_anthropic': string;
  'cli.provider_option_auto': string;
  'cli.provider_choice_prompt': string;
  // CLI 自动检测配置
  'cli.auto_detect_config': string;
  'cli.auto_detect_hint': string;
  'cli.api_key_prompt': string;
  'cli.api_key_step': string;
  'cli.base_url_prompt': string;
  'cli.detected_provider': string;
  // CLI 模型选择
  'cli.model_select_step': string;
  'cli.model_select_hint': string;
  'cli.model_leader_prompt': string;
  'cli.model_agent_prompt': string;
  'cli.model_custom_input': string;
  'cli.model_same_as_leader': string;
  'cli.model_diff_agent_prompt': string;
  'cli.model_selected': (model: string) => string;
  // CLI 配置保存
  'cli.current_config': string;
  'cli.config_save_failed': string;
  'cli.config_saved': string;
  'cli.check_permissions_hint': string;
  // CLI 命令描述
  'cli.command_start': string;
  'cli.command_init': string;
  'cli.command_list': string;
  'cli.command_demo': string;
  'cli.command_doctor': string;
  'cli.command_about': string;
  // CLI 会话管理
  'cli.session_not_found': string;
  'cli.session_resume_hint': string;
  'cli.session_resumed': string;
  'cli.session_count': (count: number) => string;
  'cli.session_status_active': string;
  'cli.session_status_completed': string;
  // CLI 关于页面
  'cli.about_title': string;
  'cli.about_version': string;
  'cli.about_footer': string;
  'cli.about_author_title': string;
  'cli.about_author_body': string;
  'cli.about_license_title': string;
  'cli.about_license_body': string;
  'cli.about_tech_title': string;
  'cli.about_tech_dynamic': string;
  'cli.about_tech_session': string;
  'cli.about_tech_skills': string;
  'cli.about_tech_typesafe': string;
  'cli.about_tech_permission': string;
  'cli.about_vision_title': string;
  'cli.about_vision_body': string;
  // CMD 语言命令
  'cmd.language.current': (lang: string) => string;
  'cmd.language.changed': (lang: string) => string;
  'cmd.language.invalid': (lang: string) => string;
  // TUI Leader 状态
  'tui.leader.awaiting_input': string;
  'tui.leader.label': string;
  'tui.main.log_label': string;
  'tui.exit.goodbye': string;
  'tui.exit.ctrl_c_again': string;
  'tui.exit.input_cleared': string;
  'tui.command.clear_failed': (message: string) => string;
  'tui.command.compact_requested': string;
  'tui.command.compact_failed': (message: string) => string;
  'tui.command.language_changed': (lang: string) => string;
  'tui.command.language_usage': string;
  'tui.command.intervene_usage': string;
  'tui.command.intervene_sent': (agent: string) => string;
  'tui.command.intervene_failed': (message: string) => string;
  'tui.command.git_load_failed': (message: string) => string;
  'tui.command.config_usage': string;
  'tui.command.reset_view': string;
  'tui.command.error': (message: string) => string;
  'tui.input.target.plan': string;
  'tui.input.target.leader': string;
  'tui.input.route.plan': string;
  'tui.input.route.leader': string;
  'tui.input.route.agent': (agent: string) => string;
  'tui.input.placeholder.plan': string;
  'tui.input.placeholder.leader': string;
  'tui.input.placeholder.agent': (agent: string) => string;
  'tui.input.route.intervene': (agent: string) => string;
  'tui.input.route.command': (target: string) => string;
  'tui.input.route.queued': (target: string) => string;
  'tui.input.route.leader_busy': string;
  'tui.input.route.leader_busy_queue': string;
  'tui.input.badge.intervene': string;
  'tui.input.badge.command': string;
  'tui.input.badge.queued': (count: number) => string;
  'tui.input.badge.processing': string;
  'tui.input.badge.direct': string;
  'tui.input.continue': string;
  'tui.input.processing': string;
  'tui.input.cancel_hint': string;
  'tui.shortcut.compact': string;
  'tui.shortcut.medium': string;
  'tui.shortcut.full': string;
  'tui.mode.header': string;
  'tui.mode.feedback': (message: string) => string;
  'tui.mode.feedback.success': (message: string) => string;
  'tui.mode.feedback.error': (message: string) => string;
  'tui.mode.collaboration': (current: string, next: string) => string;
  'tui.mode.route': (current: string, next: string) => string;
  'tui.mode.permission': (current: string, next: string) => string;
  'tui.mode.compact.collaboration': (current: string) => string;
  'tui.mode.compact.route': (current: string) => string;
  'tui.mode.compact.permission': (current: string) => string;
  'tui.mode.collaboration.solo': string;
  'tui.mode.collaboration.team': string;
  'tui.mode.route.auto': string;
  'tui.mode.route.direct': string;
  'tui.mode.route.hybrid': string;
  'tui.mode.route.delegate': string;
  'tui.mode.route.unknown': string;
  'tui.mode.route.autoHint': string;
  'tui.mode.route.directHint': string;
  'tui.mode.route.delegateHint': string;
  'tui.mode.permission.yolo': string;
  'tui.mode.permission.networked': string;
  'tui.mode.permission.dev': string;
  'tui.mode.permission.strict': string;
  'tui.mode.switched.collaboration': (mode: string) => string;
  'tui.mode.switched.route': (mode: string) => string;
  'tui.mode.switched.permission': (mode: string) => string;
  'tui.mode.error.collaboration': (mode: string, message: string) => string;
  'tui.mode.error.route': (mode: string, message: string) => string;
  'tui.mode.error.permission': (mode: string, message: string) => string;
  'tui.selection.copied': string;
  'tui.paste.unresolved': string;
  'tui.paste.expanded': (count: number, chars: number) => string;
  'tui.interrupt.done': string;
  'tui.terminal.too_narrow': string;
  'tui.terminal.too_narrow_hint': string;
  'tui.terminal.current_size': (cols: number, rows: number) => string;
  'tui.permission.request_title': (source: string, workerName: string, toolName: string) => string;
  'tui.permission.approve_hint': (hint: string) => string;
  'tui.permission.hint.file': string;
  'tui.permission.hint.shell': string;
  'tui.permission.hint.generic': string;
  'tui.permission.check.file': string;
  'tui.permission.check.shell': string;
  'tui.permission.check.network': string;
  'tui.permission.check.generic': string;
  'tui.permission.risk.file': string;
  'tui.permission.risk.shell': string;
  'tui.permission.risk.read': string;
  'tui.permission.risk.search': string;
  'tui.permission.risk.network': string;
  'tui.permission.risk.generic': string;
  'tui.permission.summary.empty': string;
  'tui.permission.summary.call': (summary: string) => string;
  'tui.permission.summary.result': (summary: string) => string;
  'tui.permission.section.overview': string;
  'tui.permission.section.risk': string;
  'tui.permission.section.preview': string;
  'tui.permission.section.approval': string;
  'tui.permission.label.source': string;
  'tui.permission.label.tool': string;
  'tui.permission.label.reason': string;
  'tui.permission.label.checklist': string;
  'tui.permission.label.risk': string;
  'tui.permission.label.recent_call': string;
  'tui.permission.label.recent_result': string;
  'tui.permission.label.latest_result': string;
  'tui.permission.label.action': string;
  'tui.permission.label.tip': string;
  'tui.permission.action.approve_deny': string;
  'tui.permission.panel_title': string;
  'tui.permission.panel_footer': string;
  'tui.permission.state_updated': (summary: string) => string;
  'tui.permission.request_log': (
    requestId: string,
    source: string,
    workerName: string,
    toolName: string,
    reason: string,
    previewHint: string,
  ) => string;
  'tui.leader.heartbeat.waiting_model': string;
  'tui.leader.heartbeat.organizing_context': string;
  'tui.leader.heartbeat.planning_next': string;
  'tui.leader.heartbeat.autonomous_recovery': string;
  'tui.leader.heartbeat.autonomous_orchestration': string;
  'tui.leader.heartbeat.working': string;
  'tui.leader.heartbeat.cancel_hint': string;
  'tui.leader.heartbeat.long_stall': (status: string, seconds: number) => string;
  'tui.leader.heartbeat.tool_executing': (tool: string, seconds: number) => string;
  'tui.meta.age.seconds': (seconds: number) => string;
  'tui.meta.age.minutes_seconds': (minutes: number, seconds: number) => string;
  'tui.meta.age.minutes': (minutes: number) => string;
  'tui.meta.tool': (tool: string, age: string) => string;
  'tui.meta.output': (age: string) => string;
  'tui.meta.heartbeat': (age: string) => string;
  'tui.meta.progress': (message: string) => string;
  'tui.meta.backend': (backend: string) => string;
  'tui.meta.external_session': (id: string) => string;
  'tui.meta.recovery': (action: string) => string;
  'tui.meta.approvals': (count: number) => string;
  'tui.meta.stream_outputs': (count: number) => string;
  'tui.meta.tasks': (total: number, inProgress: number, pending: number, blocked: number, completed: number, failed: number) => string;
  'tui.meta.cwd': (workspace: string) => string;
  'tui.meta.tabs': (tabs: string, hiddenCount: number) => string;
  'tui.meta.permission': (summary: string) => string;
  'tui.meta.route': (mode: string, preference: string) => string;
  'tui.meta.collaboration': (mode: string, activeTeamName: string) => string;
  'tui.meta.unconfigured': string;
  'tui.meta.control': (mode: string) => string;
  'tui.meta.control_eternal': string;
  'tui.meta.control_manual': string;
  'tui.meta.eternal': (status: string, idleCount: number, patrolCount: number) => string;
  'tui.meta.queue': (count: number) => string;
  'tui.meta.model': (model: string) => string;
  'tui.meta.tokens': (tokens: string) => string;
  'tui.meta.running': (count: number) => string;
  'tui.meta.done': (done: number, total: number) => string;
  'tui.meta.duration': (duration: string) => string;
  'tui.runtime.empty_output': string;
  'tui.runtime.queue': (count: number) => string;
  'tui.runtime.approval': (count: number) => string;
  'tui.runtime.output': (count: number) => string;
  'tui.runtime.terminal': (count: number) => string;
  'tui.runtime.progress': (message: string) => string;
  'tui.runtime.pending': (message: string) => string;
  'tui.runtime.approval_line': (toolName: string, reason: string, hint: string) => string;
  'tui.runtime.output_line': (toolName: string, stream: string, pidText: string, summary: string) => string;
  'tui.runtime.terminal_line': (terminalId: string, pidText: string, status: string) => string;
  'tui.runtime.terminal.suspended': string;
  'tui.runtime.terminal.running': string;
  'tui.panel.loading': string;
  'tui.panel.help.close': string;
  // === 侧边栏 ===
  'tui.sidebar.chat': string;
  'tui.sidebar.tasks': string;
  'tui.sidebar.blueprint': string;
  'tui.sidebar.agents': string;
  'tui.sidebar.graph': string;
  'tui.sidebar.git': string;
  'tui.sidebar.memory': string;
  'tui.sidebar.memory_running': string;
  'tui.sidebar.memory_due': string;
  'tui.sidebar.settings': string;
  'tui.sidebar.status': string;
  'tui.sidebar.report': string;
  'tui.sidebar.cost': string;
  'tui.sidebar.mode': string;
  'tui.sidebar.workers': string;
  'tui.sidebar.context': string;
  'tui.sidebar.tokens': string;
  'tui.sidebar.model': string;
  // === 设置面板 ===
  'tui.settings.title': string;
  'tui.settings.help': string;
  'tui.settings.help_nav': string;
  'tui.settings.help_edit': string;
  'tui.settings.group.llm': string;
  'tui.settings.group.agents': string;
  'tui.settings.group.security': string;
  'tui.settings.group.ui': string;
  'tui.graph.title': string;
  'tui.graph.empty_disabled': string;
  'tui.graph.empty': string;
  'tui.graph.more_edges': (count: number) => string;
  'tui.graph.meta': (nodes: number, factsConfirmed: number, factsTotal: number, openIntents: number, edges: number) => string;
  'tui.git.not_repo': string;
  'tui.git.no_upstream': string;
  'tui.git.summary': (staged: number, unstaged: number, untracked: number, conflicted: number) => string;
  'tui.git.staged': string;
  'tui.git.unstaged': string;
  'tui.git.untracked': string;
  'tui.git.recent_commits': string;
  'tui.git.diff_header': (start: number, end: number, total: number) => string;
  'tui.git.help': string;
  'tui.report.title': string;
  'tui.report.help': string;
  'tui.modal.resume_title': (count: number) => string;
  'tui.modal.history_title': (count: number) => string;
  'tui.modal.picker_help': string;
  'tui.agent.running_task': (taskId: string) => string;
  'tui.agent.started_task': (taskId: string, backend: string) => string;
  'tui.agent.completed': (agentName: string, iterations: string, toolCalls: string) => string;
  'tui.agent.completed_self': (iterations: string, toolCalls: string) => string;
  'tui.agent.tool_call': (tool: string) => string;
  'tui.agent.tool_result': (tool: string) => string;
  'tui.agent.failed': (error: string, recovery: string) => string;
  'tui.agent.heartbeat_wait': string;
  'tui.agent.task_created': (taskId: string, subject: string) => string;
  'tui.leader.interrupted': (stoppedAgents: number) => string;
  'tui.leader.session_completed': (sessionId: string) => string;
  'tui.plan.approved': string;
  'tui.plan.rejected': (feedback: string) => string;
  'tui.plan.rewrite_wait': string;
  'tui.plan.resubmit_wait': string;
  'tui.plan.review_wait': string;
  'tui.plan.submitted': string;
  'tui.event.session_created': (sessionId: string) => string;
  'tui.event.session_failed': (sessionId: string, error: string) => string;
  'tui.event.session_deleted': (sessionId: string) => string;
  'tui.event.skills_project': (count: number) => string;
  'tui.event.skills_plugin': (count: number) => string;
  'tui.event.skill_source.project': string;
  'tui.event.skill_source.plugin': string;
  'tui.event.skill_source.global': string;
  'tui.event.skill_source.builtin': string;
  'tui.event.question_required': string;
  'tui.event.control_eternal': string;
  'tui.event.control_manual': string;
  'tui.event.collaboration_mode_changed': (mode: string) => string;
  'tui.event.route_changed': (mode: string) => string;
  'tui.event.permission_mode_changed': (mode: string) => string;
  'tui.event.blackboard_disabled': (reason: string) => string;
  'tui.event.llm_retry': (attempt: string, kind: string, message: string) => string;
  'tui.event.llm_retry_attempt': (attempt: number) => string;
  'tui.event.network_fluctuation': string;
  'tui.event.agent_crashed': (agentName: string, detail: string) => string;
  'tui.event.intervention': (agentName: string, messageType: string, content: string) => string;
  'tui.event.context_overflow': (tokens: string, threshold: string) => string;
  'tui.event.building_args': (tool: string) => string;
  'tui.event.partial_json': (partial: string) => string;
  'tui.event.session_synced': (sessionId: string) => string;
  'tui.event.session_switched': string;
  'tui.event.wiki_started': string;
  'tui.event.wiki_completed': (docs: number | null) => string;
  'tui.event.wiki_failed': (error: string) => string;
  'tui.event.unknown_error': string;
  'tui.event.context_compressed': (oldTokens: string, newTokens: string) => string;
  'tui.event.queue_cleared': (count: number) => string;
  'tui.event.agent_stopped': (name: string) => string;
  'tui.diff.hidden': (count: number) => string;
  'tui.tool.call': (toolName: string, preview: string) => string;
  'tui.tool.result': (toolName: string, preview: string) => string;
  'tui.message.collapse_long': string;
  'tui.message.hidden_top': (count: number) => string;
  'tui.message.hidden_bottom': (count: number) => string;
  'tui.copy.success': string;
  'tui.copy.code_copied': (lines: number) => string;
  'tui.copy.no_code': string;
  'tui.mouse.tracking_on': string;
  'tui.mouse.tracking_off': string;
  'slash.help.title': string;
  'slash.help.image_upload': string;
  'slash.help.image_example': string;
  'slash.help.shortcuts': string;
  'slash.help.ctrl_c': string;
  'slash.help.ctrl_s': string;
  'slash.help.ctrl_q': string;
  'slash.help.ctrl_x': string;
  'slash.help.ctrl_e': string;
  'slash.help.ctrl_n': string;
  'slash.help.ctrl_w': string;
  'slash.help.ctrl_g': string;
  'slash.help.ctrl_digits': string;
  'slash.help.history': string;
  'slash.help.mouse_wheel': string;
  'slash.help.skill': string;
  'slash.category.session': string;
  'slash.category.view': string;
  'slash.category.permission': string;
  'slash.category.project': string;
  'slash.category.model': string;
  'slash.category.tools': string;
  'slash.category.misc': string;
  // TUI 任务板
  'tui.task.no_tasks': string;
  'tui.task.depends_on': string;
  'tui.task.switch_hint': string;
  'tui.task.total': string;
  'tui.task.pending': string;
  'tui.task.in_progress': string;
  'tui.task.completed': string;
  // TUI 团队视图
  'tui.team.title': string;
  'tui.team.no_agents': string;
  'tui.team.auto_refresh': string;
  'tui.team.never': string;
  'tui.team.seconds_ago': (seconds: number) => string;
  'tui.team.minutes_ago': (minutes: number) => string;
  'tui.team.hours_ago': (hours: number) => string;
  'tui.team.pid': string;
  'tui.team.session': string;
  'tui.team.recovery': string;
  'tui.team.stderr': string;
  'tui.team.depends': string;
  'tui.team.stop_hint': string;
  // TUI 通知中心
  'tui.notification.title': string;
  'tui.notification.empty': string;
  'tui.notification.unread': string;
  // TUI 会话状态
  'tui.main.no_session': string;
  'tui.session.status_label': string;
  'tui.session.status_field': string;
  'tui.session.workspace': string;
  'tui.permissions.label': string;
  // TUI 消息日志
  'tui.message.above_hint': (count: number) => string;
  'tui.message.no_messages': string;
  // TUI DAG 面板
  'tui.dag.status.completed': string;
  'tui.dag.status.in_progress': string;
  'tui.dag.status.pending': string;
  'tui.dag.status.blocked': string;
  'tui.dag.status.failed': string;
  'tui.dag.status.cancelled': string;
  'tui.dag.role.research': string;
  'tui.dag.role.coding': string;
  'tui.dag.role.review': string;
  'tui.dag.role.verify': string;
  'tui.dag.role.frontend': string;
  'tui.dag.role.backend': string;
  'tui.dag.role.qa': string;
  'tui.dag.role.ux_designer': string;
  'tui.dag.empty': string;
  'tui.dag.meta': (tasks: number, levels: number, agents: number, page: string) => string;
  'tui.dag.dependency': string;
  'tui.dag.progress': string;
  'tui.suggestions.help': string;
  'tui.error.component_crashed_log': (name: string) => string;
  'tui.error.component_stack_log': string;
  'tui.error.component_error': (name: string) => string;
  'tui.error.component_retry_hint': string;
  'tui.agent.runtime_title': string;
  'tui.agent.heartbeat_ok': (phase: string) => string;
  'tui.agent.wait_progress': string;
  'tui.leader.agents_working_one': (agent: string) => string;
  'tui.leader.agents_working_many': (count: number) => string;
  'tui.agent.spawn_task_desc': (taskId: string) => string;
  'tui.modal.task.field.status': string;
  'tui.modal.task.field.type': string;
  'tui.modal.task.field.dependency': string;
  'tui.modal.task.field.directory': string;
  'tui.modal.task.detail_title': (taskId: string) => string;
  'tui.modal.task.subject': string;
  'tui.modal.task.working_directory': string;
  'tui.modal.task.write_scope': string;
  'tui.plan.dependency': (deps: string) => string;
  'tui.plan.status': (status: string) => string;
  'tui.plan.batch': (index: number, group: string) => string;
  'tui.plan.title': string;
  'tui.plan.goal': string;
  'tui.plan.analysis': string;
  'tui.plan.approach': string;
  'tui.plan.risks': string;
  'tui.plan.tasks': string;
  'tui.plan.strategy': string;
  'tui.plan.verification': string;
  'tui.plan.approve_hint': string;
  // TUI 欢迎界面
  'tui.welcome.tagline': string;
  'tui.welcome.motto': string;
  'cli.farewell.motto': string;
  'cli.farewell.session': string;
  'cli.farewell.resume': string;
  'tui.welcome.shortcuts': string;
  'tui.welcome.shortcut.cmd': string;
  'tui.welcome.shortcut.interrupt': string;
  'tui.welcome.shortcut.dag': string;
  'tui.welcome.shortcut.tab': string;
  // TUI 工作笔记
  'tui.worknotes.title': string;
  'tui.worknotes.empty': string;
  'tui.worknotes.count': (count: number) => string;
  // TUI 选择器面板
  'tui.picker.empty': string;
  'tui.picker.showing': (start: number, end: number, total: number) => string;
  'tui.picker.above': (count: number) => string;
  'tui.picker.below': (count: number) => string;
  // TUI Agent 状态栏
  'tui.agents.running': (count: number) => string;
  'tui.agents.done': (count: number) => string;
  'tui.agents.paused': (count: number) => string;
  'tui.agents.failed': (count: number) => string;
  // TUI 命令参数选择器
  'tui.cmdpicker.filter': string;
  'tui.cmdpicker.filter_hint': string;
  'tui.cmdpicker.help': string;
  // TUI 回退对话框 /rewind
  'tui.rewind.title': string;
  'tui.rewind.help_pick': string;
  'tui.rewind.help_scope': string;
  'tui.rewind.help_confirm': string;
  'tui.rewind.empty': string;
  'tui.rewind.working_label': string;
  'tui.rewind.files_unit': string;
  'tui.rewind.just_now': string;
  'tui.rewind.minutes_ago': (n: number) => string;
  'tui.rewind.hours_ago': (n: number) => string;
  'tui.rewind.days_ago': (n: number) => string;
  'tui.rewind.target': string;
  'tui.rewind.impact_title': string;
  'tui.rewind.code_label': string;
  'tui.rewind.conv_label': string;
  'tui.rewind.messages_to_delete': (n: number) => string;
  'tui.rewind.no_messages': string;
  'tui.rewind.cross_session_warn': (ids: string) => string;
  'tui.rewind.db_only_hint': string;
  'tui.rewind.scope_all': string;
  'tui.rewind.scope_all_desc': string;
  'tui.rewind.scope_code': string;
  'tui.rewind.scope_code_desc': string;
  'tui.rewind.scope_conversation': string;
  'tui.rewind.scope_conversation_desc': string;
  'tui.rewind.confirm_plan': string;
  'tui.rewind.plan_code': (n: number) => string;
  'tui.rewind.plan_conv': (n: number) => string;
  'tui.rewind.plan_conv_none': string;
  'tui.rewind.will_interrupt': string;
  'tui.rewind.confirm_label': string;
  'tui.rewind.cancel': string;
  // /rewind 命令文案
  'cmd.rewind.no_session': string;
  'cmd.rewind.no_workspace': string;
  'cmd.rewind.load_failed': (err: string) => string;
  'cmd.rewind.empty': string;
  'cmd.rewind.pick_loaded': (count: number) => string;
  'cmd.rewind.working_entry': (count: number) => string;
  'cmd.rewind.cp_not_found': (id: string) => string;
  'cmd.rewind.scope_loaded': (label: string) => string;
  'cmd.rewind.bad_scope': (raw: string) => string;
  'cmd.rewind.db_only_conversation': string;
  'cmd.rewind.confirm_ready': string;
  'cmd.rewind.need_confirm': string;
  'cmd.rewind.exec_failed': (err: string) => string;
  'cmd.rewind.done_working': string;
  'cmd.rewind.done': (scope: string, label: string, truncated: number) => string;
  'cmd.rewind.usage': string;
  // TUI 问题对话框
  'tui.question.title': string;
  'tui.question.tab_hint': string;
  'tui.question.submit': string;
  'tui.question.cancel': string;
  'tui.question.other': string;
  'tui.question.other_placeholder': string;
  'tui.question.answered': string;
  'tui.question.answered_count': (answered: number, total: number) => string;
  'tui.question.help_single': string;
  'tui.question.help_multi': string;
  'tui.question.type_answer': string;
  'tui.question.help_multi_step': (isFinal: boolean) => string;
  'tui.question.help_single_step': (isFinal: boolean) => string;
  'tui.question.help_text_step': (isFinal: boolean) => string;
  'tui.question.selected_count': (count: number) => string;
  'tui.question.multi_title': (count: number) => string;
  // Settings 面板反馈
  'tui.settings.feedback.invalid_number': string;
  'tui.settings.feedback.validation_failed': string;
  'tui.settings.feedback.write_failed': string;
  'tui.settings.feedback.saved': (label: string) => string;
  'tui.settings.feedback.schema_failed': string;
  'tui.settings.feedback.save_failed': string;
  'tui.settings.feedback.value_set': (label: string, value: string) => string;
  // StreamingStatusLine 流式状态条
  'tui.stream.phrases': string[];
  'tui.stream.tool.write': string;
  'tui.stream.tool.edit': string;
  'tui.stream.tool.notebookedit': string;
  'tui.stream.tool.read': string;
  'tui.stream.tool.bash': string;
  'tui.stream.tool.powershell': string;
  'tui.stream.tool.grep': string;
  'tui.stream.tool.glob': string;
  'tui.stream.tool.webfetch': string;
  'tui.stream.tool.websearch': string;
  'tui.stream.tool.agent': string;
  'tui.stream.tool.skill': string;
  'tui.stream.tool.default': (tool: string) => string;
  'tui.stream.phase.running_tool': (tool: string) => string;
  'tui.stream.phase.waiting_model': string;
  'tui.stream.phase.retrying': string;
  'tui.stream.phase.compacting': (tool?: string) => string;
  'tui.stream.phase.streaming': string;
  'tui.stream.phase.tool_executing': (tool: string) => string;
  'tui.stream.building_params': (partial: string) => string;
  'tui.stream.chunk': (index: string | number, total: string | number) => string;
  'tui.stream.tokens_up': (n: string) => string;
  'tui.stream.tokens_down': (n: string) => string;
  'tui.stream.llm_summary': (tool?: string) => string;
  'tui.stream.compacting_conversation': string;
  'tui.stream.esc_interrupt': string;
  // MemoryPanel 记忆维护面板
  'tui.memory.title': string;
  'tui.memory.loading_hint': string;
  'tui.memory.never': string;
  'tui.memory.kind.dream': string;
  'tui.memory.kind.distill': string;
  'tui.memory.pipeline_due': string;
  'tui.memory.pipeline_scheduled': string;
  'tui.memory.pipeline_interval': (interval: number, lookback: number) => string;
  'tui.memory.pipeline_last': (date: string) => string;
  'tui.memory.memory_lines': (lines: number, bytes: string) => string;
  'tui.memory.memory_not_created': string;
  'tui.memory.checkpoints_assets': (checkpoints: number, assets: number) => string;
  'tui.memory.recent_assets': string;
  'tui.memory.no_assets': string;
  'tui.memory.run_hint': string;
  // TipsRotator 提示轮播
  'tui.tips': string[];
  // toolLogItem 工具调用/结果摘要
  'tui.tool.unserializable': string;
  'tui.tool.summary.calling': (tool: string) => string;
  'tui.tool.summary.reading': (path: string, lineInfo: string) => string;
  'tui.tool.summary.listing': (path: string) => string;
  'tui.tool.summary.fetching': (url: string) => string;
  'tui.tool.summary.searching': (query: string) => string;
  'tui.tool.summary.writing': (path: string) => string;
  'tui.tool.summary.running': (cmd: string) => string;
  'tui.tool.summary.args': (keys: string) => string;
  'tui.tool.summary.creating': (path: string) => string;
  'tui.tool.summary.patching': (path: string, hunks: number) => string;
  'tui.tool.summary.globbing': (pattern: string) => string;
  'tui.tool.summary.searching_code': (detail: string) => string;
  'tui.tool.summary.python': (code: string) => string;
  'tui.tool.summary.http': (method: string, url: string) => string;
  'tui.tool.summary.browser': (action: string, target: string) => string;
  'tui.tool.summary.browser_verify': (url: string) => string;
  'tui.tool.summary.screenshot': (url: string) => string;
  'tui.tool.summary.git': (action: string) => string;
  'tui.tool.summary.creating_task': (subject: string) => string;
  'tui.tool.summary.updating_task': (taskId: string) => string;
  'tui.tool.summary.updating_status': (taskId: string, status: string) => string;
  'tui.tool.summary.dispatching': (taskId: string, agent: string) => string;
  'tui.tool.summary.exploring': (goal: string) => string;
  'tui.tool.summary.agent_op': (op: string, agent: string) => string;
  'tui.tool.summary.messaging': (recipient: string) => string;
  'tui.tool.summary.writing_note': (summary: string) => string;
  'tui.tool.summary.plan': (action: string, detail: string) => string;
  'tui.tool.summary.memory_op': (action: string) => string;
  'tui.tool.summary.asking': (question: string) => string;
  'tui.tool.summary.finish': (summary: string) => string;
  'tui.tool.summary.download_link': (path: string) => string;
  'tui.tool.summary.defining_role': (role: string) => string;
  'tui.tool.result.line_single': (line: number) => string;
  'tui.tool.result.line_range': (a: number, b: number) => string;
  'tui.tool.result.read_lines': (range: string, total: number) => string;
  'tui.tool.result.read_chars': (chars: number) => string;
  'tui.tool.result.no_output': string;
  'tui.tool.result.listed': (entries: number, files: number, dirs: number) => string;
  'tui.tool.result.fetched': (chars: number) => string;
  'tui.tool.result.searched': (count: number) => string;
  'tui.tool.result.generic': (chars: number) => string;
  'tui.tool.result.created': string;
  'tui.tool.result.patched': (added: number, removed: number) => string;
  'tui.tool.result.searched_code': (count: number) => string;
  'tui.tool.result.git': string;
  'tui.tool.result.dispatched': string;
  'tui.tool.result.browser': string;
  'tui.tool.result.executed': (lines: number) => string;
  'tui.tool.result.http': (status: string | number) => string;
  'tui.tool.result.task_done': string;
  // Leader / Agent 运行状态显示文本（仅显示，不参与 === 比较；语义状态值如 running/completed 保持原样）
  'tui.leader.status.completed': string;
  'tui.leader.status.leading': string;
  'tui.leader.status.thinking': string;
  'tui.leader.status.observing': string;
  'tui.leader.status.executing': string;
  'tui.leader.status.replanning': string;
  'tui.leader.status.wrapping_up': string;
  'tui.leader.status_log': (status: string) => string;
  'tui.leader.mode_changed': (mode: string, reason: string) => string;
  'tui.agent.status.calling': (tool: string) => string;
  'tui.agent.status.observing': string;
  'tui.agent.status.working': string;
  'tui.agent.status.thinking': string;
  'tui.agent.launched_count': (count: number) => string;
  'tui.event.orchestration_rejected': (eventType: string, reason: string) => string;
  'tui.event.skills_ready': (count: number) => string;
  'tui.event.skill_invoked': (name: string, sourceTag: string, summary: string) => string;
  'tui.event.soul_updated': (path: string, count: number) => string;
  // tuiViewModel 元行段（pid/stderr/shell 为技术标识，中英保留）
  'tui.meta.eternal_goal': (goal: string) => string;
  'tui.meta.pid': (pid: number) => string;
  'tui.meta.stderr': (text: string) => string;
  'tui.meta.shell': (text: string) => string;
  // 杂项状态文案
  'tui.diff.hunk': (n: number) => string;
  'tui.runtime.shell': (text: string) => string;
  'tui.channel.trimmed': (n: number) => string;
  'tui.error.not_a_tty': string;
  'tui.error.not_a_tty_hint': string;
  // utils 模态表头/工具卡片摘要
  'tui.modal.tool_result': string;
  'tui.modal.tool_calling': (tool: string) => string;
  'tui.code.empty': string;
  'tui.modal.task.header.id': string;
  'tui.modal.task.header.status': string;
  'tui.modal.task.header.type': string;
  'tui.modal.task.header.agent': string;
  'tui.modal.task.header.subject': string;
  'tui.modal.task.field.agent': string;
  'tui.modal.session.header.session': string;
  'tui.modal.session.header.status': string;
  'tui.modal.session.header.time': string;
  'tui.modal.session.header.preview': string;
  'tui.modal.skill.header.skill': string;
  'tui.modal.skill.header.source': string;
  'tui.modal.skill.header.preview': string;
  // 批D: 布局/小UI 零散文案
  'tui.home.brand': string;
  'tui.home.version_prefix': string;
  'tui.home.input_hint': string;
  'tui.header.tokens': string;
  'tui.message.tool_default': string;
  'tui.message.tool_done': string;
  'tui.message.tool_running': string;
  'tui.message.code_default': string;
  'tui.message.thinking_summary': (count: number) => string;
  'tui.dag.title': string;
  'tui.dag.help': string;
  'tui.dag.stat_total': string;
  'tui.leader.mode_label': string;
  'tui.leader.control_label': string;
  'tui.leader.control_manual': string;
  'tui.sidebar.brand': string;
  'tui.sidebar.mode_chat': string;
  'tui.sidebar.mode_plan': string;
  'tui.sidebar.mode_agent': string;
  'tui.git.title': string;
  'tui.graph.edges_header': (count: number) => string;
  'tui.worknotes.blockers': string;
  'tui.question.other_label': string;
  'tui.task.empty_dash': string;
  'tui.settings.options': string;
  'tui.agents.default_name': string;
  'tui.session.status_active_default': string;
  'tui.session.orchestration': string;
  'tui.team.no_task': string;
  'tui.team.tools_count': (count: number) => string;
  'tui.code.being_written': string;
  'tui.code.generating_more': string;
  'tui.code.first_lines_hidden': (count: number) => string;
  'tui.table.column_fallback': (index: number) => string;
  // 运行时错误（throw）
  'error.session_not_found': (id: string) => string;
  'error.role_not_found': (role: string) => string;
  'error.filellock_timeout': (path: string, secs: number) => string;
  'error.filerdlock_timeout': (path: string) => string;
  'error.filewrlock_timeout': (path: string) => string;
  'error.filellock_timeout_waiting': (path: string) => string;
  'error.filelock_need_readlock': string;
  'error.filelock_need_writelock': string;
  'error.task_out_of_scope': (abs: string, root: string) => string;
  'error.worktree_not_git': string;
  'error.worktree_path_exists': (path: string) => string;
  'error.worktree_create_failed': (stderr: string) => string;
  'error.config_validation': string;
  'error.worker_write_failed': (path: string, err: string) => string;
  'error.redirect_unsafe': (reason: string) => string;
  'error.redirect_limit': (max: number) => string;
  'error.redirect_no_location': string;
  'error.redirect_invalid': (reason: string) => string;
  'error.redirect_invalid_url': (reason: string) => string;
  'error.summary_empty_response': string;
  'error.skill_not_registered': (name: string, available: string) => string;
  'error.path_access_denied': string;
  'error.path_out_of_bounds': string;
  'error.write_out_of_scope': (path: string, roots: string) => string;
  'error.ocr_file_not_found': (path: string) => string;
  'error.ocr_svg_unsupported': string;
  'error.ocr_invalid_data_uri': string;
  'error.ocr_unknown_source': string;
  'external_agent.role.claude_coding.description': string;
  'external_agent.role.codex_coding.description': string;
  'external_agent.disabled': (backend: string) => string;
  'external_agent.command_not_found': (backend: string, command: string) => string;
  'external_agent.model_missing': (backend: string) => string;
  'external_agent.api_key_missing': (backend: string, model: string, envKey: string) => string;
  'external_agent.base_url_missing': (backend: string, model: string) => string;
  'external_agent.claude_incompatible': (model: string, provider: string, baseUrl: string) => string;
  'external_agent.codex_incompatible': (model: string, provider: string, baseUrl: string) => string;
  'external_agent.timeout': (backend: string, ms: number) => string;
  'external_agent.idle_timeout': (backend: string, ms: number) => string;
  'external_agent.terminated': (backend: string) => string;
  'external_agent.exit_nonzero': (backend: string, code: number | null, signal: string, stderr: string) => string;
  // CLI 运行时提示
  'cli.instance_running': (pid: number, port: number) => string;
  'cli.port_in_use': (old: number, actual: number) => string;
  'cli.available_skills': string;
  'cli.no_skills': string;
}

const zhStrings: I18nStrings = {
  // LLM 错误标签
  'error.connect_timeout': '连接超时',
  'error.request_timeout': '请求超时',
  'error.stream_timeout': '流式超时',
  'error.network_error': '网络错误',
  'error.provider_error': '上游错误',
  'error.rate_limited': '限流冷却',
  'error.context_overflow': '上下文超限',
  'error.auth_error': '鉴权失败',
  'error.quota_exhausted': '额度耗尽',
  'error.parse_error': '解析错误',
  'error.unknown_error': '未知错误',
  // 心跳进度状态
  'progress.connecting': '连接中...',
  'progress.waiting_response': '等待模型响应...',
  'progress.processing': (seconds: number) => `处理中... (${seconds}s)`,
  // Leader 等待状态
  'leader.waiting_model': (seconds: number, cancelHint: string) =>
    `… Leader 仍在等待模型响应 (${seconds}s)${cancelHint}`,
  'leader.organizing_context': (seconds: number, cancelHint: string) =>
    `… Leader 仍在整理上下文 (${seconds}s)${cancelHint}`,
  'leader.planning_next': (seconds: number, cancelHint: string) =>
    `… Leader 仍在规划下一步 (${seconds}s)${cancelHint}`,
  'leader.still_working': (seconds: number, cancelHint: string) =>
    `… Leader 仍在工作 (${seconds}s)${cancelHint}`,
  // TurnCoordinator 状态摘要
  'turn.waiting_permission': '等待权限批准',
  'turn.waiting_permission_tool': (toolName: string) => `等待权限批准: ${toolName}`,
  'turn.waiting_review': '等待用户评审当前方案',
  'turn.waiting_user_answer': '等待用户回答',
  'turn.waiting_user_answer_preview': (preview: string) => `等待用户回答: ${preview}`,
  'turn.session_idle_waiting_instruction': '会话空闲，等待新指令',
  'turn.waiting_user_input': '等待用户输入',
  'turn.user_intervention': '用户即时介入',
  'turn.user_intervention_preview': (preview: string) => `用户即时介入: ${preview}`,
  'turn.processing_user_input': '处理用户输入',
  'turn.processing_user_input_preview': (preview: string) => `处理用户输入: ${preview}`,
  'turn.waiting_workers': (count: number) => `等待/处理 ${count} 个 worker 的进展`,
  'turn.worker_recovery': (count: number) => `自治恢复中，${count} 个任务等待接管或续跑`,
  'turn.leader_processing_dispatchable': (count: number) => `Leader 正在处理，${count} 个任务待调度`,
  'turn.leader_processing_session': 'Leader 正在处理当前会话',
  'turn.session_idle': '会话空闲',
  'permission.status.waiting_approval': '等待权限批准...',
  'leader.status.processing_user_input': '处理用户输入...',
  // LLM 日志前缀
  'llm.request_failed': '[LLM] 请求失败',
  'llm.stream_failed': '[LLM] 流式请求失败',
  'llm.stream_timeout': '[LLM] 流式响应超时，终止当前流式请求',
  'llm.empty_messages': '[LLM] 警告: messages 为空列表',
  'llm.anthropic.request_failed': '[LLM] Anthropic 请求失败',
  'llm.anthropic.stream_failed': '[LLM] Anthropic 流式请求失败',
  // Agent 状态
  'agent.llm_retrying': (attempt: number, _maxRetries: number) =>
    `⏳ LLM 重试中 (第 ${attempt} 次)`,
  'leader.llm_retrying': (attempt: number, _maxRetries: number) =>
    `⏳ LLM 重试中 (第 ${attempt} 次)`,
  // 通用
  'context.empty_response_retry': '空响应重试中',

  // === CLI 欢迎与初始化 ===
  'cli.welcome': '凌霄剑域 - 动态智能编排系统',
  'cli.init_detect_no_config': '未检测到配置文件，开始初始化引导...',

  // === CLI Provider 选择 ===
  'cli.provider_prompt': '选择 LLM 提供商:',
  'cli.provider_option_openai': '  1. OpenAI API 协议 (OpenAI, DeepSeek, 本地 LLM 等)',
  'cli.provider_option_anthropic': '  2. Anthropic (Claude 系列)',
  'cli.provider_option_auto': '  3. 自动检测 (根据 Base URL 自动识别)',
  'cli.provider_choice_prompt': '请选择 (1-3):',

  // === CLI 自动检测配置 ===
  'cli.auto_detect_config': '自动检测配置',
  'cli.auto_detect_hint': '提示: 系统将根据您填写的 Base URL 自动识别 Provider',
  'cli.api_key_prompt': 'API Key:',
  'cli.api_key_step': '配置 API 秘钥与接入地址',
  'cli.base_url_prompt': 'Base URL:',
  'cli.detected_provider': '检测到 Provider:',

  // === CLI 模型选择 ===
  'cli.model_select_step': '选择模型',
  'cli.model_select_hint': '请选择或输入 Leader/Agent 模型名称（直接回车使用默认值）',
  'cli.model_leader_prompt': 'Leader 模型',
  'cli.model_agent_prompt': 'Agent 模型（留空则与 Leader 模型相同）',
  'cli.model_custom_input': '手动输入模型名称',
  'cli.model_same_as_leader': '与 Leader 模型相同',
  'cli.model_diff_agent_prompt': '是否为 Agent 使用不同模型？[N]',
  'cli.model_selected': (model: string) => `✓ 模型已选: ${model}`,

  // === CLI 配置保存 ===
  'cli.current_config': '当前配置:',
  'cli.config_save_failed': '保存配置失败:',
  'cli.config_saved': '配置已保存到:',
  'cli.check_permissions_hint': '请检查文件写入权限:',

  // === CLI 命令描述 ===
  'cli.command_start': '启动凌霄 TUI 界面',
  'cli.command_init': '初始化配置 (交互式引导)',
  'cli.command_list': '列出所有会话',
  'cli.command_demo': '演示指定会话 (通过 session_id)',
  'cli.command_doctor': '运行系统诊断检查',
  'cli.command_about': '显示关于凌霄的信息',

  // === CLI 会话管理 ===
  'cli.session_not_found': '会话未找到:',
  'cli.session_resume_hint': '将创建新会话',
  'cli.session_resumed': '已恢复会话',
  'cli.session_count': (count: number) => `共 ${count} 个会话`,
  'cli.session_status_active': '活跃',
  'cli.session_status_completed': '已完成',

  // === CLI 关于页面 ===
  'cli.about_title': '凌霄剑域 - LingXiao CLI',
  'cli.about_version': '版本',
  'cli.about_footer': '输入 lingxiao --help 查看更多命令',
  'cli.about_author_title': '作者',
  'cli.about_author_body': 'LingXiao Community',
  'cli.about_license_title': '许可证',
  'cli.about_license_body': 'ISC License',
  'cli.about_tech_title': '技术特性',
  'cli.about_tech_dynamic': '动态任务编排 - Leader/Worker 多 Agent 协作架构',
  'cli.about_tech_typesafe': '类型安全 - 完整的 TypeScript 类型系统支持',
  'cli.about_tech_session': '会话管理 - 持久化会话，支持断点恢复',
  'cli.about_tech_permission': '权限管理 - 细粒度工具权限控制，支持项目级和用户级配置',
  'cli.about_tech_skills': '技能系统 - 可扩展的技能目录，支持工作区级别技能',
  'cli.about_vision_title': '愿景',
  'cli.about_vision_body': '打造一个动态、智能、可演进的开发者协作平台，让 AI 真正成为你的编程伙伴。',

  // === CMD 语言命令 ===
  'cmd.language.current': (lang: string) => `当前语言: ${lang}`,
  'cmd.language.changed': (lang: string) => `语言已切换为: ${lang}`,
  'cmd.language.invalid': (lang: string) => `无效的语言代码: ${lang}。请使用 'zh' 或 'en'`,

  // === TUI Leader 状态 ===
  'tui.leader.awaiting_input': '就绪',
  'tui.leader.label': '主控',
  'tui.main.log_label': '日志',
  'tui.exit.goodbye': '再见！',
  'tui.exit.ctrl_c_again': '再按一次 Ctrl+C 退出程序',
  'tui.exit.input_cleared': '已清空输入。再按一次 Ctrl+C 退出程序',
  'tui.command.clear_failed': (message: string) => `清空失败: ${message}`,
  'tui.command.compact_requested': '上下文压缩请求已发送',
  'tui.command.compact_failed': (message: string) => `压缩失败: ${message}`,
  'tui.command.language_changed': (lang: string) => `语言已切换为 ${lang === 'zh' ? '中文' : 'English'}`,
  'tui.command.language_usage': '用法: /language zh 或 /language en',
  'tui.command.intervene_usage': '用法: /intervene @agent <message>',
  'tui.command.intervene_sent': (agent: string) => `干预消息已发送到 @${agent}`,
  'tui.command.intervene_failed': (message: string) => `干预失败: ${message}`,
  'tui.command.git_load_failed': (message: string) => `Git 加载失败: ${message}`,
  'tui.command.config_usage': '用法: /config [set <key> <value> | reset <key> | reset-all | init [--force] | export]',
  'tui.command.reset_view': '已重置当前会话视图。下一次输入将创建新会话。',
  'tui.command.error': (message: string) => `错误: ${message}`,
  'tui.input.target.plan': '方案评审',
  'tui.input.target.leader': '主控',
  'tui.input.route.plan': '发送方案反馈',
  'tui.input.route.leader': '发送给主控',
  'tui.input.route.agent': (agent: string) => `发送给 @${agent}`,
  'tui.input.placeholder.plan': '输入方案反馈，Enter 发送...',
  'tui.input.placeholder.leader': '输入需求或问题，Enter 发送...',
  'tui.input.placeholder.agent': (agent: string) => `输入给 @${agent}，Enter 发送...`,
  'tui.input.route.intervene': (agent: string) => `当前输入将高优先级介入 @${agent}`,
  'tui.input.route.command': (target: string) => `当前输入为命令，将发送到 ${target}`,
  'tui.input.route.queued': (target: string) => `当前输入将排队发送到 ${target}`,
  'tui.input.route.leader_busy': 'Leader 正在处理中',
  'tui.input.route.leader_busy_queue': 'Leader 正在处理中，当前输入将排队',
  'tui.input.badge.intervene': '高优先级介入',
  'tui.input.badge.command': '命令',
  'tui.input.badge.queued': (count: number) => `排队 ${count}`,
  'tui.input.badge.processing': '处理中',
  'tui.input.badge.direct': '直达',
  'tui.input.continue': '输入继续...',
  'tui.input.processing': '处理中...',
  'tui.input.cancel_hint': 'esc 取消',
  'tui.shortcut.compact': 'Esc 清空/中断 · Enter 发送 · Ctrl+X 任务图 · Alt+C/R/P 切模式',
  'tui.shortcut.medium': 'Esc 清空/中断 · Enter 发送 · Ctrl+X 任务图 · Tab 切频道 · Alt+C 协作 · Alt+R 路由 · Alt+P 权限',
  'tui.shortcut.full': 'Esc 清空/中断 · Enter 发送 · Shift+Enter 换行 · Tab 切频道 · Ctrl+X 任务图 · Ctrl+E 折叠卡片 · Ctrl+Y 复制代码 · Ctrl+T 原生选中 · Alt+C/R/P 切模式 · PgUp/PgDn 滚动',
  'tui.mode.header': '当前模式',
  'tui.mode.feedback': (message: string) => `[OK] ${message}`,
  'tui.mode.feedback.success': (message: string) => `[OK] ${message}`,
  'tui.mode.feedback.error': (message: string) => `[ERR] ${message}`,
  'tui.mode.collaboration': (current: string, _next: string) => `协作：${current}（Alt+C 切换）`,
  'tui.mode.route': (current: string, _next: string) => `路由：${current}（Alt+R 切换）`,
  'tui.mode.permission': (current: string, _next: string) => `权限：${current}（Alt+P 切换）`,
  'tui.mode.compact.collaboration': (current: string) => `协作:${current}`,
  'tui.mode.compact.route': (current: string) => `路由:${current}`,
  'tui.mode.compact.permission': (current: string) => `权限:${current}`,
  'tui.mode.collaboration.solo': '单人',
  'tui.mode.collaboration.team': '团队',
  'tui.mode.route.auto': '自动判断',
  'tui.mode.route.direct': 'Leader 直达',
  'tui.mode.route.hybrid': '混合',
  'tui.mode.route.delegate': '委派助手',
  'tui.mode.route.unknown': '未知',
  'tui.mode.route.autoHint': '按任务复杂度自动决定：简单活自己干，重活派助手',
  'tui.mode.route.directHint': 'Leader 直接动手，不派助手，最快最省',
  'tui.mode.route.delegateHint': '尽量外包给 worker agent，适合大范围或重实现',
  'tui.mode.permission.yolo': 'YOLO',
  'tui.mode.permission.networked': '联网',
  'tui.mode.permission.dev': '开发',
  'tui.mode.permission.strict': '严格',
  'tui.mode.switched.collaboration': (mode: string) => `协作已切到 ${mode}`,
  'tui.mode.switched.route': (mode: string) => `路由已切到 ${mode}`,
  'tui.mode.switched.permission': (mode: string) => `权限已切到 ${mode}`,
  'tui.mode.error.collaboration': (mode: string, message: string) => `协作切换到 ${mode} 失败：${message}`,
  'tui.mode.error.route': (mode: string, message: string) => `路由切换到 ${mode} 失败：${message}`,
  'tui.mode.error.permission': (mode: string, message: string) => `权限切换到 ${mode} 失败：${message}`,
  'tui.selection.copied': '选中文本已复制',
  'tui.paste.unresolved': '检测到未展开的粘贴折叠标记，已阻止发送。请重新粘贴后再试。',
  'tui.paste.expanded': (count: number, chars: number) => `已展开 ${count} 段粘贴内容并发送（${chars} chars）`,
  'tui.interrupt.done': '会话已中断',
  'tui.terminal.too_narrow': '终端过窄',
  'tui.terminal.too_narrow_hint': '请拉宽终端到至少 24 列',
  'tui.terminal.current_size': (cols: number, rows: number) => `当前: ${cols}×${rows}`,
  'tui.permission.request_title': (source: string, workerName: string, toolName: string) =>
    `权限请求 · ${source}${workerName ? ` @${workerName}` : ''} · tool=${toolName}`,
  'tui.permission.approve_hint': (hint: string) => `${hint} · /approve 或 /deny`,
  'tui.permission.hint.file': '可能修改文件 · 预览: 查看工具调用/结果',
  'tui.permission.hint.shell': '可能执行命令 · 预览: 查看工具调用/输出',
  'tui.permission.hint.generic': '预览: 查看工具调用详情',
  'tui.permission.check.file': '检查目标路径与改动范围',
  'tui.permission.check.shell': '检查命令与影响范围',
  'tui.permission.check.network': '检查目标与必要性',
  'tui.permission.check.generic': '检查工具参数与预期输出',
  'tui.permission.risk.file': '可能修改文件或覆盖内容',
  'tui.permission.risk.shell': '可能执行命令并改变运行环境',
  'tui.permission.risk.read': '可能读取敏感文件内容',
  'tui.permission.risk.search': '可能检索到敏感信息',
  'tui.permission.risk.network': '可能访问外部网络或下载内容',
  'tui.permission.risk.generic': '可能产生不可预期的副作用',
  'tui.permission.summary.empty': '暂无工具调用记录',
  'tui.permission.summary.call': (summary: string) => `调用: ${summary}`,
  'tui.permission.summary.result': (summary: string) => `结果: ${summary}`,
  'tui.permission.section.overview': '概览',
  'tui.permission.section.risk': '风险与检查',
  'tui.permission.section.preview': '预览',
  'tui.permission.section.approval': '审批',
  'tui.permission.label.source': '来源',
  'tui.permission.label.tool': '工具',
  'tui.permission.label.reason': '原因',
  'tui.permission.label.checklist': '检查清单',
  'tui.permission.label.risk': '风险',
  'tui.permission.label.recent_call': '最近调用',
  'tui.permission.label.recent_result': '最近结果',
  'tui.permission.label.latest_result': '最新结果',
  'tui.permission.label.action': '操作',
  'tui.permission.label.tip': '提示',
  'tui.permission.action.approve_deny': '批准 /approve · 拒绝 /deny',
  'tui.permission.panel_title': '权限确认 · 审批/预览',
  'tui.permission.panel_footer': '操作: /approve 或 /deny',
  'tui.permission.state_updated': (summary: string) => `权限状态已更新: ${summary}`,
  'tui.permission.request_log': (
    requestId: string,
    source: string,
    workerName: string,
    toolName: string,
    reason: string,
    previewHint: string,
  ) => `权限请求 [${requestId}]\n来源: ${source}${workerName ? ` @${workerName}` : ''}\n工具: ${toolName}\n原因: ${reason}\n${previewHint}\n使用 /approve 或 /deny`,
  'tui.leader.heartbeat.waiting_model': '等待模型响应',
  'tui.leader.heartbeat.organizing_context': '整理上下文',
  'tui.leader.heartbeat.planning_next': '规划下一步',
  'tui.leader.heartbeat.autonomous_recovery': '自治恢复中',
  'tui.leader.heartbeat.autonomous_orchestration': '自治编排中',
  'tui.leader.heartbeat.working': '处理中',
  'tui.leader.heartbeat.cancel_hint': ' · Esc 可中断',
  'tui.leader.heartbeat.tool_executing': (tool: string, seconds: number) => `仍在执行 ${tool}（${seconds}s）`,
  'tui.leader.heartbeat.long_stall': (status: string, seconds: number) => `${status} (${seconds}s) · 如果长时间无响应可尝试 Ctrl+C 中断`,
  'tui.meta.age.seconds': (seconds: number) => `${seconds}s前`,
  'tui.meta.age.minutes_seconds': (minutes: number, seconds: number) => `${minutes}m${seconds}s前`,
  'tui.meta.age.minutes': (minutes: number) => `${minutes}m前`,
  'tui.meta.tool': (tool: string, age: string) => `工具 ${tool} ${age}`,
  'tui.meta.output': (age: string) => `输出 ${age}`,
  'tui.meta.heartbeat': (age: string) => `心跳 ${age}`,
  'tui.meta.progress': (message: string) => `进度 ${message}`,
  'tui.meta.backend': (backend: string) => `后端 ${backend}`,
  'tui.meta.external_session': (id: string) => `外部会话 ${id}`,
  'tui.meta.recovery': (action: string) => `恢复 ${action}`,
  'tui.meta.approvals': (count: number) => `审批 ${count}`,
  'tui.meta.stream_outputs': (count: number) => `流输出 ${count}`,
  'tui.meta.tasks': (total: number, inProgress: number, pending: number, blocked: number, completed: number, failed: number) =>
    `任务 ${total} · 进 ${inProgress} · 待 ${pending} · 阻 ${blocked} · 完 ${completed} · 败 ${failed}`,
  'tui.meta.cwd': (workspace: string) => `cwd ${workspace}`,
  'tui.meta.tabs': (tabs: string, hiddenCount: number) => `tabs ${tabs}${hiddenCount > 0 ? ` +${hiddenCount}` : ''}`,
  'tui.meta.permission': (summary: string) => `权限:${summary}`,
  'tui.meta.route': (mode: string, preference: string) => `执行:${mode}${preference ? ` · 偏好:${preference}` : ''}`,
  'tui.meta.collaboration': (mode: string, activeTeamName: string) => `协作:${mode}${activeTeamName ? ` · 团队:${activeTeamName}` : ''}`,
  'tui.meta.unconfigured': '(未配置)',
  'tui.meta.control': (mode: string) => `控制 ${mode}`,
  'tui.meta.control_eternal': 'Eternal(自治)',
  'tui.meta.control_manual': 'Manual(主导)',
  'tui.meta.eternal': (status: string, idleCount: number, patrolCount: number) => `Eternal ${status} · idle ${idleCount} · patrol ${patrolCount}`,
  'tui.meta.queue': (count: number) => `队列 ${count}`,
  'tui.meta.model': (model: string) => `模型 ${model}`,
  'tui.meta.tokens': (tokens: string) => `tokens ${tokens}`,
  'tui.meta.running': (count: number) => `运行 ${count}`,
  'tui.meta.done': (done: number, total: number) => `完成 ${done}/${total}`,
  'tui.meta.duration': (duration: string) => `时长 ${duration}`,
  'tui.runtime.empty_output': '(空输出)',
  'tui.runtime.queue': (count: number) => `队列 ${count}`,
  'tui.runtime.approval': (count: number) => `审批 ${count}`,
  'tui.runtime.output': (count: number) => `输出 ${count}`,
  'tui.runtime.terminal': (count: number) => `终端 ${count}`,
  'tui.runtime.progress': (message: string) => `进度: ${message}`,
  'tui.runtime.pending': (message: string) => `待处理: ${message}`,
  'tui.runtime.approval_line': (toolName: string, reason: string, hint: string) => `审批: ${toolName} · ${reason} · ${hint}`,
  'tui.runtime.output_line': (toolName: string, stream: string, pidText: string, summary: string) => `输出: ${toolName} [${stream}${pidText}] · ${summary}`,
  'tui.runtime.terminal_line': (terminalId: string, pidText: string, status: string) => `终端: tid=${terminalId}${pidText} · ${status}`,
  'tui.runtime.terminal.suspended': '已挂起',
  'tui.runtime.terminal.running': '运行中',
  'tui.panel.loading': '加载中...',
  'tui.panel.help.close': '↑/↓ 滚动 · PgUp/PgDn 翻页 · Esc/Ctrl+X 关闭',
  'tui.sidebar.chat': '会话',
  'tui.sidebar.tasks': '任务',
  'tui.sidebar.blueprint': '蓝图',
  'tui.sidebar.agents': '智能体',
  'tui.sidebar.graph': '图谱',
  'tui.sidebar.git': 'Git',
  'tui.sidebar.memory': '记忆',
  'tui.sidebar.memory_running': '运行中',
  'tui.sidebar.memory_due': '到期',
  'tui.sidebar.settings': '设置',
  'tui.sidebar.status': '状态',
  'tui.sidebar.report': '报告',
  'tui.sidebar.cost': '费用',
  'tui.sidebar.mode': '模式',
  'tui.sidebar.workers': '智能体',
  'tui.sidebar.context': '上下文',
  'tui.sidebar.tokens': '用量',
  'tui.sidebar.model': '模型',
  'tui.settings.title': '设置概览',
  'tui.settings.help': '↑/↓ 选择 · Enter/点击 编辑 · Space 切换 · Esc 关闭',
  'tui.settings.help_nav': '↑/↓ 选择 · Enter/点击 编辑 · Space 切换 · Esc 关闭',
  'tui.settings.help_edit': '输入新值 · Enter 保存 · Esc 取消 · Home/End 跳首尾',
  'tui.settings.group.llm': 'LLM',
  'tui.settings.group.agents': '智能体',
  'tui.settings.group.security': '安全',
  'tui.settings.group.ui': '界面',
  'tui.graph.title': '黑板图状态',
  'tui.graph.empty_disabled': '黑板为空 · 发送消息后自动填充',
  'tui.graph.empty': '暂无图数据',
  'tui.graph.more_edges': (count: number) => `  ... 还有 ${count} 条边`,
  'tui.graph.meta': (nodes: number, factsConfirmed: number, factsTotal: number, openIntents: number, edges: number) =>
    `节点 ${nodes} · 事实 ${factsConfirmed}/${factsTotal} · 待探索 ${openIntents} · 边 ${edges}`,
  'tui.git.not_repo': '当前工作区不是 git 仓库',
  'tui.git.no_upstream': '(无上游)',
  'tui.git.summary': (staged: number, unstaged: number, untracked: number, conflicted: number) =>
    `暂存 ${staged} · 改动 ${unstaged} · 未跟踪 ${untracked}${conflicted ? ` · 冲突 ${conflicted}` : ''}`,
  'tui.git.staged': '暂存 (staged)',
  'tui.git.unstaged': '改动 (unstaged)',
  'tui.git.untracked': '未跟踪 (untracked)',
  'tui.git.recent_commits': '最近提交',
  'tui.git.diff_header': (start: number, end: number, total: number) =>
    `Diff (${start}-${end}/${total} 行 · ↑/↓ 滚动)`,
  'tui.git.help': '↑/↓ 滚动 diff · Esc/Ctrl+X 关闭 · /git refresh 刷新',
  'tui.report.title': '报告',
  'tui.report.help': '↑/↓ 滚动 · PgUp/PgDn 翻页 · Esc/Ctrl+X 关闭',
  'tui.modal.resume_title': (count: number) => `恢复会话 · ${count} 项`,
  'tui.modal.history_title': (count: number) => `历史会话 · ${count} 项`,
  'tui.modal.picker_help': '  ↑/↓ 选择 · Enter 恢复 · Esc 取消',
  'tui.agent.running_task': (taskId: string) => `执行任务 ${taskId}`,
  'tui.agent.started_task': (taskId: string, backend: string) => `开始执行任务 ${taskId}${backend ? ` · 后端 ${backend}` : ''}`,
  'tui.agent.completed': (agentName: string, iterations: string, toolCalls: string) =>
    `● @${agentName} 已完成 ✓ (${iterations} 迭代, ${toolCalls} 工具调用)`,
  'tui.agent.completed_self': (iterations: string, toolCalls: string) => `● 已完成 ✓ (${iterations} 迭代, ${toolCalls} 工具调用)`,
  'tui.agent.tool_call': (tool: string) => `调用 ${tool}`,
  'tui.agent.tool_result': (tool: string) => `收到 ${tool} 结果`,
  'tui.agent.failed': (error: string, recovery: string) => `失败: ${error}${recovery ? ` · ${recovery}` : ''}`,
  'tui.agent.heartbeat_wait': '等待下一个输出（worker 心跳正常）',
  'tui.agent.task_created': (taskId: string, subject: string) => `任务 ${taskId} 已创建: ${subject}`,
  'tui.leader.interrupted': (stoppedAgents: number) =>
    `⏸ 已中断${stoppedAgents > 0 ? `，已停止 ${stoppedAgents} 个 agent` : ''}。输入消息继续`,
  'tui.leader.session_completed': (sessionId: string) => `会话 ${sessionId} 已完成`,
  'tui.plan.approved': '✅ 方案已批准，开始执行…',
  'tui.plan.rejected': (feedback: string) => `方案已退回，等待重新规划${feedback}`,
  'tui.plan.rewrite_wait': '等待 Leader 根据评审意见重写方案',
  'tui.plan.resubmit_wait': '等待 Leader 重新提交方案',
  'tui.plan.review_wait': '等待用户评审方案',
  'tui.plan.submitted': '执行方案已提交，等待审批。',
  'tui.event.session_created': (sessionId: string) => `会话 ${sessionId} 已创建`,
  'tui.event.session_failed': (sessionId: string, error: string) => `✗ 会话 ${sessionId} 初始化失败: ${error}`,
  'tui.event.session_deleted': (sessionId: string) => `会话 ${sessionId} 已删除`,
  'tui.event.skills_project': (count: number) => `${count} 项目级`,
  'tui.event.skills_plugin': (count: number) => `${count} 插件`,
  'tui.event.skill_source.project': '项目',
  'tui.event.skill_source.plugin': '插件',
  'tui.event.skill_source.global': '全局',
  'tui.event.skill_source.builtin': '内置',
  'tui.event.question_required': '需要您的输入',
  'tui.event.control_eternal': '切换至 Eternal Mode（Leader 自治）',
  'tui.event.control_manual': '切换至 Manual Mode（用户主导）',
  'tui.event.collaboration_mode_changed': (mode: string) => `协作模式已切换为 ${mode}`,
  'tui.event.route_changed': (mode: string) => `执行路由偏好已切换为 ${mode}`,
  'tui.event.permission_mode_changed': (mode: string) => `权限模式已切换为 ${mode}`,
  'tui.event.blackboard_disabled': (reason: string) => `· 黑板未启用: ${reason}`,
  'tui.event.llm_retry': (attempt: string, kind: string, message: string) => `⏳ LLM ${attempt}${kind}: ${message}`,
  'tui.event.llm_retry_attempt': (attempt: number) => `第 ${attempt} 次重试`,
  'tui.event.network_fluctuation': '网络/服务波动',
  'tui.event.agent_crashed': (agentName: string, detail: string) => `✗ @${agentName} 进程崩溃${detail ? ` (${detail})` : ''}`,
  'tui.event.intervention': (agentName: string, messageType: string, content: string) =>
    `↳ 干预 @${agentName}${messageType ? ` [${messageType}]` : ''}: ${content}`,
  'tui.event.context_overflow': (tokens: string, threshold: string) => `⚠ 上下文接近上限 (${tokens}/${threshold} tokens)，即将压缩`,
  'tui.event.building_args': (tool: string) => `⚙ 构建参数 ${tool}…`,
  'tui.event.partial_json': (partial: string) => `参数构建中：${partial}…`,
  'tui.event.session_synced': (sessionId: string) => `已同步到 Web UI 会话 ${sessionId}...`,
  'tui.event.session_switched': '已切换会话',
  'tui.event.wiki_started': '📖 Wiki 生成开始…',
  'tui.event.wiki_completed': (docs: number | null) => `✓ Wiki 生成完成${docs != null ? `（${docs} 个文档）` : ''}`,
  'tui.event.wiki_failed': (error: string) => `✗ Wiki 生成失败: ${error}`,
  'tui.event.unknown_error': '未知错误',
  'tui.event.context_compressed': (oldTokens: string, newTokens: string) => `上下文已压缩: ${oldTokens} → ${newTokens} tokens`,
  'tui.event.queue_cleared': (count: number) => `已清除 ${count} 条排队消息`,
  'tui.event.agent_stopped': (name: string) => `已停止 Agent ${name}（Leader 与其它 Agent 不受影响）`,
  'tui.diff.hidden': (count: number) => `… ${count} 行已省略 …`,
  'tui.tool.call': (toolName: string, preview: string) => `调用 ${toolName}${preview ? `\n  ⎿ ${preview}` : ''}`,
  'tui.tool.result': (toolName: string, preview: string) => `工具结果 ${toolName}${preview ? `\n  ⎿ ${preview}` : ''}`,
  'tui.message.collapse_long': 'Ctrl+S 收起长消息',
  'tui.message.hidden_top': (count: number) => `... 前 ${count} 行已隐藏 ...`,
  'tui.message.hidden_bottom': (count: number) => `... 后 ${count} 行已隐藏 ...`,
  'tui.copy.success': '已复制到剪贴板',
  'tui.copy.code_copied': (lines: number) => `代码已复制 (${lines} 行)`,
  'tui.copy.no_code': '没有可复制的代码块',
  'tui.mouse.tracking_on': '鼠标追踪已开启 · TUI 内选择/点击生效',
  'tui.mouse.tracking_off': '鼠标追踪已关闭 · 可用终端原生拖拽选中复制',
  'slash.help.title': '可用命令（/help 或 / 触发搜索）:',
  'slash.help.image_upload': '图片上传: 消息中包含图片路径即可自动识别 (png/jpg/gif/webp)',
  'slash.help.image_example': '  例: 分析这张图 ./screenshot.png',
  'slash.help.shortcuts': '快捷键:',
  'slash.help.ctrl_c': '  Ctrl+C  中断当前会话；连续按两次退出程序',
  'slash.help.ctrl_s': '  Ctrl+S  长消息折叠/展开',
  'slash.help.ctrl_q': '  Ctrl+Q  退出程序',
  'slash.help.ctrl_x': '  Ctrl+X  任务图面板',
  'slash.help.ctrl_e': '  Ctrl+E  团队/Agent 面板',
  'slash.help.ctrl_n': '  Ctrl+N  通知中心',
  'slash.help.ctrl_w': '  Ctrl+W  工作笔记面板',
  'slash.help.ctrl_g': '  Ctrl+G  Git 工作区面板',
  'slash.help.ctrl_digits': '  Ctrl+0-9  快速切换频道',
  'slash.help.history': '  ↑/↓  切换历史输入',
  'slash.help.mouse_wheel': '  鼠标滚轮  滚动日志',
  'slash.help.skill': '  $skill_name  触发 skill 注入',
  'slash.category.session': '会话',
  'slash.category.view': '视图 / 面板',
  'slash.category.permission': '权限 / 审批',
  'slash.category.project': '项目编排',
  'slash.category.model': '模型 / 配置',
  'slash.category.tools': '工具 / 技能',
  'slash.category.misc': '其它',

  // === TUI 任务板 ===
  'tui.task.no_tasks': '暂无任务',
  'tui.task.depends_on': '依赖',
  'tui.task.switch_hint': '按 Tab 切换面板',
  'tui.task.total': '总计',
  'tui.task.pending': '待开始',
  'tui.task.in_progress': '进行中',
  'tui.task.completed': '已完成',

  // === TUI 团队视图 ===
  'tui.team.title': '团队',
  'tui.team.no_agents': '暂无活跃 Agent',
  'tui.team.auto_refresh': '自动刷新',
  'tui.team.never': '从未',
  'tui.team.seconds_ago': (seconds: number) => `${seconds} 秒前`,
  'tui.team.minutes_ago': (minutes: number) => `${minutes} 分钟前`,
  'tui.team.hours_ago': (hours: number) => `${hours} 小时前`,
  'tui.team.pid': '进程',
  'tui.team.session': '会话',
  'tui.team.recovery': '恢复',
  'tui.team.stderr': '错误输出',
  'tui.team.depends': '依赖',
  'tui.team.stop_hint': '↑/↓ 选择 Agent · Enter 聚焦其视图 · 切到该 Agent 后按 Esc 仅停止这一个',

  // === TUI 通知中心 ===
  'tui.notification.title': '通知',
  'tui.notification.empty': '暂无通知',
  'tui.notification.unread': '未读',

  // === TUI 会话状态 ===
  'tui.main.no_session': '尚未创建会话',
  'tui.session.status_label': '会话:',
  'tui.session.status_field': '状态',
  'tui.session.workspace': '工作目录',
  'tui.permissions.label': '权限',

  // === TUI 消息日志 ===
  'tui.message.above_hint': (count: number) => `↑ 上方还有 ${count} 条消息`,
  'tui.message.no_messages': '暂无消息',

  // === TUI DAG 面板 ===
  'tui.dag.status.completed': '完成',
  'tui.dag.status.in_progress': '进行中',
  'tui.dag.status.pending': '待办',
  'tui.dag.status.blocked': '阻塞',
  'tui.dag.status.failed': '失败',
  'tui.dag.status.cancelled': '取消',
  'tui.dag.role.research': '研究',
  'tui.dag.role.coding': '编码',
  'tui.dag.role.review': '审查',
  'tui.dag.role.verify': '验证',
  'tui.dag.role.frontend': '前端',
  'tui.dag.role.backend': '后端',
  'tui.dag.role.qa': '测试',
  'tui.dag.role.ux_designer': '设计',
  'tui.dag.empty': '暂无任务',
  'tui.dag.meta': (tasks: number, levels: number, agents: number, page: string) =>
    `${tasks} 任务 · ${levels} 层 · ${agents} Agent${page}`,
  'tui.dag.dependency': '依赖: ',
  'tui.dag.progress': '进度: ',
  'tui.suggestions.help': '  ↑/↓ 选择 · Tab 应用 · Esc 取消',
  'tui.error.component_crashed_log': (name: string) => `[ErrorBoundary] ${name} 组件崩溃:`,
  'tui.error.component_stack_log': '[ErrorBoundary] 组件栈:',
  'tui.error.component_error': (name: string) => `组件错误: ${name}`,
  'tui.error.component_retry_hint': '按任意键重试或继续其他操作',
  'tui.agent.runtime_title': '运行态',
  'tui.agent.heartbeat_ok': (phase: string) => `worker 心跳正常${phase ? ` · ${phase}` : ''}`,
  'tui.agent.wait_progress': '等待新进展',
  'tui.leader.agents_working_one': (agent: string) => `${agent} 正在工作`,
  'tui.leader.agents_working_many': (count: number) => `${count} 个 Agent 并行工作`,
  'tui.agent.spawn_task_desc': (taskId: string) => `任务 ${taskId}`,
  'tui.modal.task.field.status': '状态',
  'tui.modal.task.field.type': '类型',
  'tui.modal.task.field.dependency': '依赖',
  'tui.modal.task.field.directory': '目录',
  'tui.modal.task.detail_title': (taskId: string) => `任务详情 [${taskId}]`,
  'tui.modal.task.subject': '主题',
  'tui.modal.task.working_directory': '工作目录',
  'tui.modal.task.write_scope': '写入范围',
  'tui.plan.dependency': (deps: string) => ` ← 依赖 ${deps}`,
  'tui.plan.status': (status: string) => ` · 状态=${status}`,
  'tui.plan.batch': (index: number, group: string) => `**第 ${index} 批** (并行): ${group}`,
  'tui.plan.title': '# 📋 执行方案',
  'tui.plan.goal': '目标',
  'tui.plan.analysis': '问题分析',
  'tui.plan.approach': '技术路线',
  'tui.plan.risks': '风险与决策点',
  'tui.plan.tasks': '任务列表',
  'tui.plan.strategy': '执行策略',
  'tui.plan.verification': '验证计划',
  'tui.plan.approve_hint': '✅ 输入 `/approve` 批准 · 💬 输入修改建议 · ⬅️ 按 Tab 回 @main',

  // === TUI 欢迎界面 ===
  'tui.welcome.tagline': 'LingXiao',
  'tui.welcome.motto': 'Multi-agent coding',
  'cli.farewell.motto': 'Blade rests, the night keeps watch',
  'cli.farewell.session': 'Session',
  'cli.farewell.resume': 'Resume',
  'tui.welcome.shortcuts': '快捷键',
  'tui.welcome.shortcut.cmd': '  /         命令',
  'tui.welcome.shortcut.interrupt': '  Esc       中断',
  'tui.welcome.shortcut.dag': '  Ctrl+X    任务图',
  'tui.welcome.shortcut.tab': '  Tab       切换面板',

  // === TUI 工作笔记 ===
  'tui.worknotes.title': '📋 工作笔记',
  'tui.worknotes.empty': '暂无工作笔记。Agent 工作时将在此记录笔记。',
  'tui.worknotes.count': (count: number) => `(${count} 条笔记)`,

  // === TUI 选择器面板 ===
  'tui.picker.empty': '暂无内容',
  'tui.picker.showing': (start: number, end: number, total: number) => `  显示 ${start}-${end} / ${total}`,
  'tui.picker.above': (count: number) => `  ↑ 上方还有 ${count} 项`,
  'tui.picker.below': (count: number) => `  ↓ 下方还有 ${count} 项`,

  // === TUI Agent 状态栏 ===
  'tui.agents.running': (count: number) => `Agents: ${count} 运行中`,
  'tui.agents.done': (count: number) => `${count} 完成`,
  'tui.agents.paused': (count: number) => `${count} 暂停`,
  'tui.agents.failed': (count: number) => `${count} 失败`,

  // === TUI 命令参数选择器 ===
  'tui.cmdpicker.filter': '过滤:',
  'tui.cmdpicker.filter_hint': 'Backspace 清除',
  'tui.cmdpicker.help': '  ↑/↓ 移动  ·  Enter 选择  ·  1-9 快速选  ·  Esc 取消',

  // === TUI 回退对话框 /rewind ===
  'tui.rewind.title': '回退到检查点',
  'tui.rewind.help_pick': '  ↑/↓ 选择  ·  输入过滤  ·  1-9 快速选  ·  Enter 下一步  ·  Esc 取消',
  'tui.rewind.help_scope': '  ↑/↓ 选择范围  ·  Enter 下一步  ·  Esc 取消',
  'tui.rewind.help_confirm': '  ↑/↓ 选择  ·  Enter 确认执行  ·  Esc 取消',
  'tui.rewind.empty': '没有可回退的内容',
  'tui.rewind.working_label': '工作区未提交',
  'tui.rewind.files_unit': '文件',
  'tui.rewind.just_now': '刚刚',
  'tui.rewind.minutes_ago': (n: number) => `${n}分钟前`,
  'tui.rewind.hours_ago': (n: number) => `${n}小时前`,
  'tui.rewind.days_ago': (n: number) => `${n}天前`,
  'tui.rewind.target': '回退到:',
  'tui.rewind.impact_title': '影响预览',
  'tui.rewind.code_label': '代码:',
  'tui.rewind.conv_label': '对话:',
  'tui.rewind.messages_to_delete': (n: number) => `${n} 条消息将被删除`,
  'tui.rewind.no_messages': '对话无变化',
  'tui.rewind.cross_session_warn': (ids: string) => `其他会话在此检查点之后有提交（${ids}），还原代码可能影响它们`,
  'tui.rewind.db_only_hint': '该检查点无 git 快照，仅可回退对话',
  'tui.rewind.scope_all': '全部 (代码 + 对话)',
  'tui.rewind.scope_all_desc': '完整回到该检查点',
  'tui.rewind.scope_code': '仅代码',
  'tui.rewind.scope_code_desc': '还原文件，保留对话',
  'tui.rewind.scope_conversation': '仅对话',
  'tui.rewind.scope_conversation_desc': '删除消息，保留文件改动',
  'tui.rewind.confirm_plan': '即将执行：',
  'tui.rewind.plan_code': (n: number) => `还原 ${n} 个文件到此检查点状态`,
  'tui.rewind.plan_conv': (n: number) => `删除回退点之后的 ${n} 条对话消息`,
  'tui.rewind.plan_conv_none': '对话无变化',
  'tui.rewind.will_interrupt': '将中断当前进行中的工作（Leader 重启后从截断点继续）',
  'tui.rewind.confirm_label': '确认回退',
  'tui.rewind.cancel': '取消',
  // === /rewind 命令文案 ===
  'cmd.rewind.no_session': '当前没有活动会话',
  'cmd.rewind.no_workspace': '当前会话没有工作区，无法回退',
  'cmd.rewind.load_failed': (err: string) => `加载检查点失败: ${err}`,
  'cmd.rewind.empty': '暂无可回退的检查点或工作区改动',
  'cmd.rewind.pick_loaded': (count: number) => `已加载 ${count} 个检查点`,
  'cmd.rewind.working_entry': (count: number) => `工作区有 ${count} 个未提交文件`,
  'cmd.rewind.cp_not_found': (id: string) => `未找到检查点: ${id}`,
  'cmd.rewind.scope_loaded': (label: string) => `已选中: ${label}`,
  'cmd.rewind.bad_scope': (raw: string) => `无效的范围「${raw}」，应为 code / conversation / all`,
  'cmd.rewind.db_only_conversation': '该检查点无 git 快照，仅支持回退对话（范围请用 conversation）',
  'cmd.rewind.confirm_ready': '请确认回退计划',
  'cmd.rewind.need_confirm': '需要确认：请用 /rewind <id> <scope> confirm 执行',
  'cmd.rewind.exec_failed': (err: string) => `回退失败: ${err}（shadow git 保留了完整历史，可手动 git 恢复）`,
  'cmd.rewind.done_working': '已丢弃所有未提交的工作区改动',
  'cmd.rewind.done': (scope: string, label: string, truncated: number) =>
    scope === 'all' ? `已回退到「${label}」（代码 + ${truncated} 条对话）`
      : scope === 'conversation' ? `已删除 ${truncated} 条对话消息（代码未动）`
        : `已将代码还原到「${label}」`,
  'cmd.rewind.usage': '用法: /rewind [checkpointId] [code|conversation|all] [confirm]',

  // === TUI 问题对话框 ===
  'tui.question.title': '请回答以下问题',
  'tui.question.tab_hint': '  ←/→ 切换问题  ·  ↑/↓ 选择  ·  Space 多选  ·  Enter 提交  ·  Esc 取消',
  'tui.question.submit': '提交',
  'tui.question.cancel': '取消',
  'tui.question.other': '其他...',
  'tui.question.other_placeholder': '请输入...',
  'tui.question.answered': '✓',
  'tui.question.answered_count': (answered: number, total: number) => `已答 ${answered}/${total}`,
  'tui.question.help_single': '  ↑/↓ 移动  ·  Enter 选择  ·  1-9 快速选  ·  Esc 取消',
  'tui.question.help_multi': '  ↑/↓ 移动  ·  Space 勾选  ·  Enter 提交  ·  Esc 取消',
  'tui.question.type_answer': '请输入回答:',
  'tui.question.help_multi_step': (isFinal: boolean) =>
    `↑↓ 移动  Space/数字 切换  Tab ${isFinal ? '→ 提交' : '→ 下一题'}  b 返回上题`,
  'tui.question.help_single_step': (isFinal: boolean) =>
    `↑↓ 移动  数字 跳转  Tab ${isFinal ? '→ 提交' : '→ 下一题'}  b 返回上题`,
  'tui.question.help_text_step': (isFinal: boolean) =>
    isFinal ? 'Enter → 提交  b 返回' : 'Enter/Tab → 下一题  b 返回',
  'tui.question.selected_count': (count: number) => `  ✓ 已选 ${count} 项`,
  'tui.question.multi_title': (count: number) => `需要回答 ${count} 个问题`,
  // Settings 面板反馈
  'tui.settings.feedback.invalid_number': '无效数字',
  'tui.settings.feedback.validation_failed': '校验失败',
  'tui.settings.feedback.write_failed': '写入失败',
  'tui.settings.feedback.saved': (label: string) => `${label} 已保存`,
  'tui.settings.feedback.schema_failed': '配置校验失败',
  'tui.settings.feedback.save_failed': '保存失败',
  'tui.settings.feedback.value_set': (label: string, value: string) => `${label} = ${value}`,
  // StreamingStatusLine 流式状态条
  'tui.stream.phrases': ['处理中', '流式输出中', '计算中', '分析中', '生成中', '扫描中', '获取中', '同步中', '映射中', '探索中', '链接中', '适配中', '学习中', '观察中', '连接中'],
  'tui.stream.tool.write': '写入文件',
  'tui.stream.tool.edit': '编辑中',
  'tui.stream.tool.notebookedit': '编辑笔记本',
  'tui.stream.tool.read': '读取文件',
  'tui.stream.tool.bash': '执行命令',
  'tui.stream.tool.powershell': '执行命令',
  'tui.stream.tool.grep': '搜索内容',
  'tui.stream.tool.glob': '搜索文件',
  'tui.stream.tool.webfetch': '抓取网页',
  'tui.stream.tool.websearch': '搜索网络',
  'tui.stream.tool.agent': '派生 Agent',
  'tui.stream.tool.skill': '运行技能',
  'tui.stream.tool.default': (tool: string) => `写入 ${tool}`,
  'tui.stream.phase.running_tool': (tool: string) => `运行 ${tool}`,
  'tui.stream.phase.waiting_model': '等待模型',
  'tui.stream.phase.retrying': '重试中',
  'tui.stream.phase.compacting': (tool?: string) => tool ? `压缩上下文 (${tool})` : '压缩上下文',
  'tui.stream.phase.streaming': '流式中',
  'tui.stream.phase.tool_executing': (tool: string) => `正在执行 ${tool}`,
  'tui.stream.building_params': (partial: string) => `参数构建中：${partial}…`,
  'tui.stream.chunk': (index: string | number, total: string | number) => `chunk ${index}/${total}`,
  'tui.stream.tokens_up': (n: string) => `↑ ${n} tokens`,
  'tui.stream.tokens_down': (n: string) => `↓ ${n} tokens`,
  'tui.stream.llm_summary': (tool?: string) => tool ? `LLM 摘要 (${tool})` : 'LLM 摘要',
  'tui.stream.compacting_conversation': '· 正在压缩对话…',
  'tui.stream.esc_interrupt': 'esc 中断',
  // MemoryPanel 记忆维护面板
  'tui.memory.title': '记忆维护',
  'tui.memory.loading_hint': '记忆状态加载中。使用 /dream 或 /distill 执行维护。',
  'tui.memory.never': '从未',
  'tui.memory.kind.dream': '记忆整理',
  'tui.memory.kind.distill': '资产提炼',
  'tui.memory.pipeline_due': '已到期',
  'tui.memory.pipeline_scheduled': '已排期',
  'tui.memory.pipeline_interval': (interval: number, lookback: number) => `每 ${interval} 天 · 回溯 ${lookback} 天`,
  'tui.memory.pipeline_last': (date: string) => `上次 ${date}`,
  'tui.memory.memory_lines': (lines: number, bytes: string) => `${lines} 行 · ${bytes}`,
  'tui.memory.memory_not_created': '尚未创建',
  'tui.memory.checkpoints_assets': (checkpoints: number, assets: number) => `检查点 ${checkpoints} · 资产 ${assets}`,
  'tui.memory.recent_assets': '近期资产',
  'tui.memory.no_assets': '暂无提炼资产。',
  'tui.memory.run_hint': '运行 /dream 整合记忆，/distill [天数] 提炼可复用资产。',
  // TipsRotator 提示轮播
  'tui.tips': ['输入 / 查看所有可用命令', 'Ctrl+C 中断当前任务', 'Tab 切换频道查看 Agent 状态', '支持多 Agent 并行协作', '输入自然语言描述需求即可开始', '/dag 查看任务依赖关系图', 'Ctrl+S 切换消息折叠模式', '长文本粘贴自动折叠，提交时展开'],
  // toolLogItem 工具调用/结果摘要
  'tui.tool.unserializable': '[不可序列化负载]',
  'tui.tool.summary.calling': (tool: string) => `调用 ${tool}...`,
  'tui.tool.summary.reading': (path: string, lineInfo: string) => `读取 ${path || '文件'}${lineInfo}`,
  'tui.tool.summary.listing': (path: string) => `列出 ${path}`,
  'tui.tool.summary.fetching': (url: string) => `抓取 ${url || 'URL'}`,
  'tui.tool.summary.searching': (query: string) => `搜索"${query || '...'}"`,
  'tui.tool.summary.writing': (path: string) => `写入 ${path || '文件'}`,
  'tui.tool.summary.running': (cmd: string) => `运行: ${cmd || '命令'}`,
  'tui.tool.summary.args': (keys: string) => `参数: ${keys}`,
  'tui.tool.summary.creating': (path: string) => `创建 ${path || '文件'}`,
  'tui.tool.summary.patching': (path: string, hunks: number) => `补丁 ${path || '文件'} (${hunks} hunk)`,
  'tui.tool.summary.globbing': (pattern: string) => `匹配 ${pattern}`,
  'tui.tool.summary.searching_code': (detail: string) => `搜索代码: ${detail}`,
  'tui.tool.summary.python': (code: string) => `Python: ${code}`,
  'tui.tool.summary.http': (method: string, url: string) => `${method} ${url}`,
  'tui.tool.summary.browser': (action: string, target: string) => `浏览器 ${action}${target ? ` → ${target}` : ''}`,
  'tui.tool.summary.browser_verify': (url: string) => `验证页面 ${url || '...'}`,
  'tui.tool.summary.screenshot': (url: string) => `截图 ${url || '...'}`,
  'tui.tool.summary.git': (action: string) => `Git: ${action}`,
  'tui.tool.summary.creating_task': (subject: string) => `创建任务: ${subject}`,
  'tui.tool.summary.updating_task': (taskId: string) => `更新任务 ${taskId}`,
  'tui.tool.summary.updating_status': (taskId: string, status: string) => `状态变更 ${taskId} → ${status}`,
  'tui.tool.summary.dispatching': (taskId: string, agent: string) => `派发 ${taskId} → ${agent}`,
  'tui.tool.summary.exploring': (goal: string) => `探索: ${goal}`,
  'tui.tool.summary.agent_op': (op: string, agent: string) => `${op} ${agent}`,
  'tui.tool.summary.messaging': (recipient: string) => `发消息给 ${recipient}`,
  'tui.tool.summary.writing_note': (summary: string) => `写笔记: ${summary}`,
  'tui.tool.summary.plan': (action: string, detail: string) => `${action}: ${detail}`,
  'tui.tool.summary.memory_op': (action: string) => `记忆: ${action}`,
  'tui.tool.summary.asking': (question: string) => `提问: ${question}`,
  'tui.tool.summary.finish': (summary: string) => `结束会话: ${summary}`,
  'tui.tool.summary.download_link': (path: string) => `下载链接: ${path}`,
  'tui.tool.summary.defining_role': (role: string) => `定义角色: ${role}`,
  'tui.tool.result.line_single': (line: number) => `第 ${line} 行`,
  'tui.tool.result.line_range': (a: number, b: number) => `第 ${a}-${b} 行`,
  'tui.tool.result.read_lines': (range: string, total: number) => `读取 ${range} (${total} 行)`,
  'tui.tool.result.read_chars': (chars: number) => `读取 (${chars} 字符)`,
  'tui.tool.result.no_output': '(无输出)',
  'tui.tool.result.listed': (entries: number, files: number, dirs: number) => `列出目录 (${entries} 项${files ? `，${files} 文件` : ''}${dirs ? `，${dirs} 目录` : ''})`,
  'tui.tool.result.fetched': (chars: number) => `抓取 (${chars} 字符)`,
  'tui.tool.result.searched': (count: number) => count > 0 ? `已搜索 (${count} 条结果)` : '已搜索',
  'tui.tool.result.generic': (chars: number) => `结果 (${chars} 字符)`,
  'tui.tool.result.created': '已创建/写入',
  'tui.tool.result.patched': (added: number, removed: number) => `补丁完成 (+${added} -${removed})`,
  'tui.tool.result.searched_code': (count: number) => `代码搜索 (${count} 处匹配)`,
  'tui.tool.result.git': 'Git 操作完成',
  'tui.tool.result.dispatched': '已派发',
  'tui.tool.result.browser': '浏览器操作完成',
  'tui.tool.result.executed': (lines: number) => `执行完成 (${lines} 行输出)`,
  'tui.tool.result.http': (status: string | number) => `HTTP 响应 (${status})`,
  'tui.tool.result.task_done': '任务操作完成',
  // Leader / Agent 运行状态显示文本
  'tui.leader.status.completed': '已完成',
  'tui.leader.status.leading': '主导中…',
  'tui.leader.status.thinking': '思考中…',
  'tui.leader.status.observing': '观察中…',
  'tui.leader.status.executing': '执行中…',
  'tui.leader.status.replanning': '重规划中…',
  'tui.leader.status.wrapping_up': '收尾中…',
  'tui.leader.status_log': (status: string) => `Leader: ${status}`,
  'tui.leader.mode_changed': (mode: string, reason: string) => `Leader 模式 -> ${mode}: ${reason}`,
  'tui.agent.status.calling': (tool: string) => `调用 ${tool}…`,
  'tui.agent.status.observing': '观察中…',
  'tui.agent.status.working': '工作中…',
  'tui.agent.status.thinking': '思考中…',
  'tui.agent.launched_count': (count: number) => `● 已启动 ${count} 个 Agent`,
  'tui.event.orchestration_rejected': (eventType: string, reason: string) => `编排被拒绝 ${eventType}: ${reason || 'unknown'}`,
  'tui.event.skills_ready': (count: number) => `${count} 个技能就绪`,
  'tui.event.skill_invoked': (name: string, sourceTag: string, summary: string) => `✓  使用技能: "${name}" (${sourceTag}) — ${summary}`,
  'tui.event.soul_updated': (path: string, count: number) => `· 灵魂已更新: ${path} (${count} 条)`,
  // tuiViewModel 元行段
  'tui.meta.eternal_goal': (goal: string) => `目标 ${goal}`,
  'tui.meta.pid': (pid: number) => `pid ${pid}`,
  'tui.meta.stderr': (text: string) => `stderr ${text}`,
  'tui.meta.shell': (text: string) => `shell ${text}`,
  // 杂项状态文案
  'tui.diff.hunk': (n: number) => `── 第 ${n} 块 ──`,
  'tui.runtime.shell': (text: string) => `shell ${text}`,
  'tui.channel.trimmed': (n: number) => `... 已省略 ${n} 条较早消息 ...`,
  'tui.error.not_a_tty': '错误: stdin 不是 TTY，不支持 raw 模式。',
  'tui.error.not_a_tty_hint': '请在交互式终端运行 lingxiao，不要在后台或通过管道运行。',
  // utils 模态表头/工具卡片摘要
  'tui.modal.tool_result': '工具结果',
  'tui.modal.tool_calling': (tool: string) => `调用 ${tool}...`,
  'tui.code.empty': '(空)',
  'tui.modal.task.header.id': 'ID',
  'tui.modal.task.header.status': '状态',
  'tui.modal.task.header.type': '类型',
  'tui.modal.task.header.agent': 'Agent',
  'tui.modal.task.header.subject': '主题',
  'tui.modal.task.field.agent': 'Agent',
  'tui.modal.session.header.session': '会话',
  'tui.modal.session.header.status': '状态',
  'tui.modal.session.header.time': '时间',
  'tui.modal.session.header.preview': '预览',
  'tui.modal.skill.header.skill': '技能',
  'tui.modal.skill.header.source': '来源',
  'tui.modal.skill.header.preview': '预览',
  // 批D: 布局/小UI 零散文案
  'tui.home.brand': '凌霄剑域',
  'tui.home.version_prefix': 'LingXiao CLI  v',
  'tui.home.input_hint': '输入你的问题... (/ 查看命令)',
  'tui.header.tokens': 'tokens',
  'tui.message.tool_default': '工具',
  'tui.message.tool_done': '完成',
  'tui.message.tool_running': '运行中',
  'tui.message.code_default': '代码',
  'tui.message.thinking_summary': (count: number) => `思考 · ${count} 字`,
  'tui.dag.title': '任务图',
  'tui.dag.help': '↑/↓ 导航  ←/→ 翻页  Enter 跳转  Ctrl+X 关闭',
  'tui.dag.stat_total': '总计 ',
  'tui.leader.mode_label': '模式: ',
  'tui.leader.control_label': '控制: ',
  'tui.leader.control_manual': '手动',
  'tui.sidebar.brand': '凌霄',
  'tui.sidebar.mode_chat': '对话',
  'tui.sidebar.mode_plan': '规划',
  'tui.sidebar.mode_agent': '代理',
  'tui.git.title': 'Git',
  'tui.graph.edges_header': (count: number) => `边 (${count})`,
  'tui.worknotes.blockers': '阻塞: ',
  'tui.question.other_label': '其他: ',
  'tui.task.empty_dash': '  --',
  'tui.settings.options': '  选项: ',
  'tui.agents.default_name': 'agent',
  'tui.session.status_active_default': '活跃',
  'tui.session.orchestration': '编排: ',
  'tui.team.no_task': '--',
  'tui.team.tools_count': (count: number) => `tools=${count}`,
  'tui.code.being_written': '... 代码正在写入 ...',
  'tui.code.generating_more': '... 生成更多 ...',
  'tui.code.first_lines_hidden': (count: number) => `... 前 ${count} 行已隐藏 ...`,
  'tui.table.column_fallback': (index: number) => `列 ${index}`,
  // 运行时错误（throw）
  'error.session_not_found': (id: string) => `会话不存在：${id}`,
  'error.role_not_found': (role: string) => `角色 '${role}' 不存在`,
  'error.filellock_timeout': (path: string, secs: number) => `获取文件锁超时: ${path} (等待 ${secs}s)`,
  'error.filerdlock_timeout': (path: string) => `获取读锁超时: ${path} (有写者等待)`,
  'error.filewrlock_timeout': (path: string) => `获取写锁超时: ${path} (有读者)`,
  'error.filellock_timeout_waiting': (path: string) => `获取文件锁超时: ${path}`,
  'error.filelock_need_readlock': '必须先持有读锁才能升级',
  'error.filelock_need_writelock': '必须先持有写锁才能降级',
  'error.task_out_of_scope': (abs: string, root: string) => `任务作用域越界：${abs} 不在工作区 ${root} 内`,
  'error.worktree_not_git': '当前目录不是 git 仓库，无法创建 worktree',
  'error.worktree_path_exists': (path: string) => `Worktree 路径已存在: ${path}`,
  'error.worktree_create_failed': (stderr: string) => `创建 worktree 失败: ${stderr}`,
  'error.config_validation': 'modelProviders 配置验证失败，请修复后重试',
  'error.worker_write_failed': (path: string, err: string) => `写入 worker payload 失败 (${path}): ${err}`,
  'error.redirect_unsafe': (reason: string) => `重定向目标不安全 - ${reason}`,
  'error.redirect_limit': (max: number) => `重定向次数超过限制 (${max})`,
  'error.redirect_no_location': '重定向响应缺少 Location 头',
  'error.redirect_invalid': (reason: string) => `重定向目标无效 - ${reason}`,
  'error.redirect_invalid_url': (reason: string) => reason || 'URL 无效',
  'error.summary_empty_response': '摘要模型返回空响应',
  'error.skill_not_registered': (name: string, available: string) => `技能 '${name}' 未注册，可用技能: ${available}`,
  'error.path_access_denied': '拒绝访问其他会话目录。请仅使用当前 session 的 scratchpad/context 路径。',
  'error.path_out_of_bounds': '路径越界：不能写到工作区之外',
  'error.write_out_of_scope': (path: string, roots: string) => `写入路径超出允许范围：${path}。允许范围：${roots}`,
  'error.ocr_file_not_found': (path: string) => `文件不存在: ${path}`,
  'error.ocr_svg_unsupported': 'SVG 矢量图不支持 OCR 识别',
  'error.ocr_invalid_data_uri': '无效的 data URI 格式',
  'error.ocr_unknown_source': '无法识别图片来源',
  'external_agent.role.claude_coding.description': 'Claude Code CLI 外部子 Agent，适合长链路代码实现、跨文件修改与 Claude 生态任务',
  'external_agent.role.codex_coding.description': 'Codex CLI 外部子 Agent，适合 OpenAI/Codex 生态代码实现、patch 与仓库内工程任务',
  'external_agent.disabled': (backend: string) => `ExternalAgent(${backend}) 已在设置中关闭`,
  'external_agent.command_not_found': (backend: string, command: string) => `ExternalAgent(${backend}) 命令未找到: ${command}`,
  'external_agent.model_missing': (backend: string) => `ExternalAgent(${backend}) 未配置模型，请为角色 role.model 配置模型`,
  'external_agent.api_key_missing': (backend: string, model: string, envKey: string) => `ExternalAgent(${backend}) 模型 '${model}' 缺少 API key（envKey=${envKey}）`,
  'external_agent.base_url_missing': (backend: string, model: string) => `ExternalAgent(${backend}) 模型 '${model}' 缺少 baseUrl`,
  'external_agent.claude_incompatible': (model: string, provider: string, baseUrl: string) => `ExternalAgent(claude) 需要 Anthropic API 协议模型，当前模型 '${model}' provider=${provider} baseUrl=${baseUrl}`,
  'external_agent.codex_incompatible': (model: string, provider: string, baseUrl: string) => `ExternalAgent(codex) 需要 OpenAI API 协议模型，当前模型 '${model}' provider=${provider} baseUrl=${baseUrl}`,
  'external_agent.timeout': (backend: string, ms: number) => `ExternalAgent(${backend}) 超时: ${ms}ms`,
  'external_agent.idle_timeout': (backend: string, ms: number) => `ExternalAgent(${backend}) 空闲超时: ${ms}ms`,
  'external_agent.terminated': (backend: string) => `ExternalAgent(${backend}) 已终止`,
  'external_agent.exit_nonzero': (backend: string, code: number | null, signal: string, stderr: string) => `ExternalAgent(${backend}) 退出异常 code=${code} signal=${signal} stderr=${stderr}`,
  // CLI 运行时提示
  'cli.instance_running': (pid: number, port: number) => `⚠ 检测到已有实例运行中 (PID ${pid}, 端口 ${port})`,
  'cli.port_in_use': (old: number, actual: number) => `⚠ 端口 ${old} 已占用，使用 ${actual}`,
  'cli.available_skills': '可用技能',
  'cli.no_skills': '暂无可用技能',
};

const enStrings: I18nStrings = {
  // LLM 错误标签
  'error.connect_timeout': 'Connection Timeout',
  'error.request_timeout': 'Request Timeout',
  'error.stream_timeout': 'Stream Timeout',
  'error.network_error': 'Network Error',
  'error.provider_error': 'Provider Error',
  'error.rate_limited': 'Rate Limited',
  'error.context_overflow': 'Context Overflow',
  'error.auth_error': 'Authentication Failed',
  'error.quota_exhausted': 'Quota Exhausted',
  'error.parse_error': 'Parse Error',
  'error.unknown_error': 'Unknown Error',
  // 心跳进度状态
  'progress.connecting': 'Connecting...',
  'progress.waiting_response': 'Waiting for response...',
  'progress.processing': (seconds: number) => `Processing... (${seconds}s)`,
  // Leader 等待状态
  'leader.waiting_model': (seconds: number, cancelHint: string) =>
    `… Leader waiting for model response (${seconds}s)${cancelHint}`,
  'leader.organizing_context': (seconds: number, cancelHint: string) =>
    `… Leader organizing context (${seconds}s)${cancelHint}`,
  'leader.planning_next': (seconds: number, cancelHint: string) =>
    `… Leader planning next step (${seconds}s)${cancelHint}`,
  'leader.still_working': (seconds: number, cancelHint: string) =>
    `… Leader still working (${seconds}s)${cancelHint}`,
  // TurnCoordinator status summaries
  'turn.waiting_permission': 'Waiting for permission approval',
  'turn.waiting_permission_tool': (toolName: string) => `Waiting for permission approval: ${toolName}`,
  'turn.waiting_review': 'Waiting for user review of the current plan',
  'turn.waiting_user_answer': 'Waiting for user answer',
  'turn.waiting_user_answer_preview': (preview: string) => `Waiting for user answer: ${preview}`,
  'turn.session_idle_waiting_instruction': 'Session idle, waiting for a new instruction',
  'turn.waiting_user_input': 'Waiting for user input',
  'turn.user_intervention': 'User intervention',
  'turn.user_intervention_preview': (preview: string) => `User intervention: ${preview}`,
  'turn.processing_user_input': 'Processing user input',
  'turn.processing_user_input_preview': (preview: string) => `Processing user input: ${preview}`,
  'turn.waiting_workers': (count: number) => `Waiting for or processing progress from ${count} worker(s)`,
  'turn.worker_recovery': (count: number) => `Autonomous recovery in progress, ${count} task(s) waiting for takeover or resume`,
  'turn.leader_processing_dispatchable': (count: number) => `Leader is processing, ${count} task(s) pending dispatch`,
  'turn.leader_processing_session': 'Leader is processing the current session',
  'turn.session_idle': 'Session idle',
  'permission.status.waiting_approval': 'Waiting for permission approval...',
  'leader.status.processing_user_input': 'Processing user input...',
  // LLM 日志前缀
  'llm.request_failed': '[LLM] Request failed',
  'llm.stream_failed': '[LLM] Stream request failed',
  'llm.stream_timeout': '[LLM] Stream response timed out, aborting',
  'llm.empty_messages': '[LLM] Warning: messages list is empty',
  'llm.anthropic.request_failed': '[LLM] Anthropic request failed',
  'llm.anthropic.stream_failed': '[LLM] Anthropic stream request failed',
  // Agent 状态
  'agent.llm_retrying': (attempt: number, _maxRetries: number) =>
    `⏳ LLM retrying (attempt ${attempt})`,
  'leader.llm_retrying': (attempt: number, _maxRetries: number) =>
    `⏳ LLM retrying (attempt ${attempt})`,
  // 通用
  'context.empty_response_retry': 'Empty response retrying',

  // === CLI Welcome & Init ===
  'cli.welcome': 'LingXiao - Dynamic Intelligent Orchestration System',
  'cli.init_detect_no_config': 'No configuration detected, starting initialization...',

  // === CLI Provider Selection ===
  'cli.provider_prompt': 'Select LLM Provider:',
  'cli.provider_option_openai': '  1. OpenAI Compatible (OpenAI, DeepSeek, Local LLMs, etc.)',
  'cli.provider_option_anthropic': '  2. Anthropic (Claude series)',
  'cli.provider_option_auto': '  3. Auto Detect (Automatically identify by Base URL)',
  'cli.provider_choice_prompt': 'Your choice (1-3):',

  // === CLI Auto Detect Config ===
  'cli.auto_detect_config': 'Auto Detect Configuration',
  'cli.auto_detect_hint': 'Hint: The system will auto-detect the provider based on your Base URL',
  'cli.api_key_prompt': 'API Key:',
  'cli.api_key_step': 'Configure API key and endpoint',
  'cli.base_url_prompt': 'Base URL:',
  'cli.detected_provider': 'Detected Provider:',

  // === CLI Model Selection ===
  'cli.model_select_step': 'Select Model',
  'cli.model_select_hint': 'Choose or type the Leader/Agent model name (press Enter to keep default)',
  'cli.model_leader_prompt': 'Leader Model',
  'cli.model_agent_prompt': 'Agent Model (leave empty to use same as Leader)',
  'cli.model_custom_input': 'Enter model name manually',
  'cli.model_same_as_leader': 'Same as Leader model',
  'cli.model_diff_agent_prompt': 'Use a different model for Agent? [N]',
  'cli.model_selected': (model: string) => `✓ Model selected: ${model}`,

  // === CLI Config Save ===
  'cli.current_config': 'Current Configuration:',
  'cli.config_save_failed': 'Failed to save config:',
  'cli.config_saved': 'Config saved to:',
  'cli.check_permissions_hint': 'Please check file write permissions:',

  // === CLI Command Descriptions ===
  'cli.command_start': 'Start the LingXiao TUI interface',
  'cli.command_init': 'Initialize configuration (interactive guided setup)',
  'cli.command_list': 'List all sessions',
  'cli.command_demo': 'Demo a specific session (by session_id)',
  'cli.command_doctor': 'Run system diagnostic checks',
  'cli.command_about': 'Show information about LingXiao',

  // === CLI Session Management ===
  'cli.session_not_found': 'Session not found:',
  'cli.session_resume_hint': 'A new session will be created instead',
  'cli.session_resumed': 'Session resumed',
  'cli.session_count': (count: number) => `${count} session(s) total`,
  'cli.session_status_active': 'active',
  'cli.session_status_completed': 'completed',

  // === CLI About Page ===
  'cli.about_title': 'LingXiao CLI',
  'cli.about_version': 'Version',
  'cli.about_footer': 'Run lingxiao --help for more commands',
  'cli.about_author_title': 'Author',
  'cli.about_author_body': 'LingXiao Community',
  'cli.about_license_title': 'License',
  'cli.about_license_body': 'ISC License',
  'cli.about_tech_title': 'Technical Features',
  'cli.about_tech_dynamic': 'Dynamic Task Orchestration - Leader/Worker multi-agent collaboration',
  'cli.about_tech_typesafe': 'Type-Safe - Full TypeScript type system support',
  'cli.about_tech_session': 'Session Management - Persistent sessions with resume capability',
  'cli.about_tech_permission': 'Permission Management - Fine-grained tool permissions with project and user-level config',
  'cli.about_tech_skills': 'Skill System - Extensible skill catalog with workspace-level skills',
  'cli.about_vision_title': 'Vision',
  'cli.about_vision_body': 'Building a dynamic, intelligent, and evolvable developer collaboration platform where AI truly becomes your programming partner.',

  // === CMD Language Commands ===
  'cmd.language.current': (lang: string) => `Current language: ${lang}`,
  'cmd.language.changed': (lang: string) => `Language changed to: ${lang}`,
  'cmd.language.invalid': (lang: string) => `Invalid language code: ${lang}. Use 'zh' or 'en'`,

  // === TUI Leader Status ===
  'tui.leader.awaiting_input': 'Ready',
  'tui.leader.label': 'Leader',
  'tui.main.log_label': 'Log',
  'tui.exit.goodbye': 'Goodbye!',
  'tui.exit.ctrl_c_again': 'Press Ctrl+C again to exit',
  'tui.exit.input_cleared': 'Input cleared. Press Ctrl+C again to exit',
  'tui.command.clear_failed': (message: string) => `Clear failed: ${message}`,
  'tui.command.compact_requested': 'Context compaction requested',
  'tui.command.compact_failed': (message: string) => `Compaction failed: ${message}`,
  'tui.command.language_changed': (lang: string) => `Language switched to ${lang === 'zh' ? 'Chinese' : 'English'}`,
  'tui.command.language_usage': 'Usage: /language zh or /language en',
  'tui.command.intervene_usage': 'Usage: /intervene @agent <message>',
  'tui.command.intervene_sent': (agent: string) => `Intervention sent to @${agent}`,
  'tui.command.intervene_failed': (message: string) => `Intervention failed: ${message}`,
  'tui.command.git_load_failed': (message: string) => `Git load failed: ${message}`,
  'tui.command.config_usage': 'Usage: /config [set <key> <value> | reset <key> | reset-all | init [--force] | export]',
  'tui.command.reset_view': 'Current session view reset. The next input will create a new session.',
  'tui.command.error': (message: string) => `Error: ${message}`,
  'tui.input.target.plan': 'Plan review',
  'tui.input.target.leader': 'Leader',
  'tui.input.route.plan': 'Send plan feedback',
  'tui.input.route.leader': 'Send to Leader',
  'tui.input.route.agent': (agent: string) => `Send to @${agent}`,
  'tui.input.placeholder.plan': 'Type plan feedback, Enter to send...',
  'tui.input.placeholder.leader': 'Type a request or question, Enter to send...',
  'tui.input.placeholder.agent': (agent: string) => `Type to @${agent}, Enter to send...`,
  'tui.input.route.intervene': (agent: string) => `Input will high-priority intervene @${agent}`,
  'tui.input.route.command': (target: string) => `Input is a command and will be sent to ${target}`,
  'tui.input.route.queued': (target: string) => `Input will be queued for ${target}`,
  'tui.input.route.leader_busy': 'Leader is processing',
  'tui.input.route.leader_busy_queue': 'Leader is processing; input will be queued',
  'tui.input.badge.intervene': 'Intervene',
  'tui.input.badge.command': 'Command',
  'tui.input.badge.queued': (count: number) => `Queued ${count}`,
  'tui.input.badge.processing': 'Processing',
  'tui.input.badge.direct': 'Direct',
  'tui.input.continue': 'Continue typing...',
  'tui.input.processing': 'Processing...',
  'tui.input.cancel_hint': 'esc cancel',
  'tui.shortcut.compact': 'Esc clear/interrupt · Enter send · Ctrl+X task graph · Alt+C/R/P modes',
  'tui.shortcut.medium': 'Esc clear/interrupt · Enter send · Ctrl+X task graph · Tab switch channel · Alt+C collab · Alt+R route · Alt+P permission',
  'tui.shortcut.full': 'Esc clear/interrupt · Enter send · Shift+Enter newline · Tab switch channel · Ctrl+X task graph · Ctrl+E collapse card · Ctrl+Y copy code · Ctrl+T native select · Alt+C/R/P modes · PgUp/PgDn scroll',
  'tui.mode.header': 'Current modes',
  'tui.mode.feedback': (message: string) => `[OK] ${message}`,
  'tui.mode.feedback.success': (message: string) => `[OK] ${message}`,
  'tui.mode.feedback.error': (message: string) => `[ERR] ${message}`,
  'tui.mode.collaboration': (current: string, _next: string) => `Collab: ${current} (Alt+C to switch)`,
  'tui.mode.route': (current: string, _next: string) => `Route: ${current} (Alt+R to switch)`,
  'tui.mode.permission': (current: string, _next: string) => `Permission: ${current} (Alt+P to switch)`,
  'tui.mode.compact.collaboration': (current: string) => `Collab:${current}`,
  'tui.mode.compact.route': (current: string) => `Route:${current}`,
  'tui.mode.compact.permission': (current: string) => `Perm:${current}`,
  'tui.mode.collaboration.solo': 'solo',
  'tui.mode.collaboration.team': 'team',
  'tui.mode.route.auto': 'auto',
  'tui.mode.route.direct': 'direct',
  'tui.mode.route.hybrid': 'hybrid',
  'tui.mode.route.delegate': 'delegate',
  'tui.mode.route.unknown': 'unknown',
  'tui.mode.route.autoHint': 'Auto-decide by complexity: simple work direct, heavy work delegated',
  'tui.mode.route.directHint': 'Leader executes directly, no helper; fastest, lowest cost',
  'tui.mode.route.delegateHint': 'Prefer delegating to worker agents; for large or heavy work',
  'tui.mode.permission.yolo': 'yolo',
  'tui.mode.permission.networked': 'networked',
  'tui.mode.permission.dev': 'dev',
  'tui.mode.permission.strict': 'strict',
  'tui.mode.switched.collaboration': (mode: string) => `collab switched to ${mode}`,
  'tui.mode.switched.route': (mode: string) => `route switched to ${mode}`,
  'tui.mode.switched.permission': (mode: string) => `permission switched to ${mode}`,
  'tui.mode.error.collaboration': (mode: string, message: string) => `Failed to switch collaboration to ${mode}: ${message}`,
  'tui.mode.error.route': (mode: string, message: string) => `Failed to switch route to ${mode}: ${message}`,
  'tui.mode.error.permission': (mode: string, message: string) => `Failed to switch permission to ${mode}: ${message}`,
  'tui.selection.copied': 'Selected text copied',
  'tui.paste.unresolved': 'Unexpanded paste placeholders were detected, so the message was not sent. Paste again and retry.',
  'tui.paste.expanded': (count: number, chars: number) => `Expanded ${count} pasted block(s) and sent them (${chars} chars)`,
  'tui.interrupt.done': 'Session interrupted',
  'tui.terminal.too_narrow': 'Terminal too narrow',
  'tui.terminal.too_narrow_hint': 'Widen the terminal to at least 24 columns',
  'tui.terminal.current_size': (cols: number, rows: number) => `Current: ${cols}x${rows}`,
  'tui.permission.request_title': (source: string, workerName: string, toolName: string) =>
    `Permission request · ${source}${workerName ? ` @${workerName}` : ''} · tool=${toolName}`,
  'tui.permission.approve_hint': (hint: string) => `${hint} · /approve or /deny`,
  'tui.permission.hint.file': 'May modify files · preview: inspect tool call/result',
  'tui.permission.hint.shell': 'May run commands · preview: inspect tool call/output',
  'tui.permission.hint.generic': 'Preview: inspect tool call details',
  'tui.permission.check.file': 'Check target path and change scope',
  'tui.permission.check.shell': 'Check command and impact scope',
  'tui.permission.check.network': 'Check target and necessity',
  'tui.permission.check.generic': 'Check tool arguments and expected output',
  'tui.permission.risk.file': 'May modify files or overwrite content',
  'tui.permission.risk.shell': 'May run commands and change the runtime environment',
  'tui.permission.risk.read': 'May read sensitive file content',
  'tui.permission.risk.search': 'May discover sensitive information',
  'tui.permission.risk.network': 'May access external network or download content',
  'tui.permission.risk.generic': 'May have unexpected side effects',
  'tui.permission.summary.empty': 'No tool call records yet',
  'tui.permission.summary.call': (summary: string) => `Call: ${summary}`,
  'tui.permission.summary.result': (summary: string) => `Result: ${summary}`,
  'tui.permission.section.overview': 'Overview',
  'tui.permission.section.risk': 'Risk & Checks',
  'tui.permission.section.preview': 'Preview',
  'tui.permission.section.approval': 'Approval',
  'tui.permission.label.source': 'Source',
  'tui.permission.label.tool': 'Tool',
  'tui.permission.label.reason': 'Reason',
  'tui.permission.label.checklist': 'Checklist',
  'tui.permission.label.risk': 'Risk',
  'tui.permission.label.recent_call': 'Recent call',
  'tui.permission.label.recent_result': 'Recent result',
  'tui.permission.label.latest_result': 'Latest result',
  'tui.permission.label.action': 'Action',
  'tui.permission.label.tip': 'Tip',
  'tui.permission.action.approve_deny': 'Approve /approve · Deny /deny',
  'tui.permission.panel_title': 'Permission confirmation · approval/preview',
  'tui.permission.panel_footer': 'Action: /approve or /deny',
  'tui.permission.state_updated': (summary: string) => `Permission state updated: ${summary}`,
  'tui.permission.request_log': (
    requestId: string,
    source: string,
    workerName: string,
    toolName: string,
    reason: string,
    previewHint: string,
  ) => `Permission request [${requestId}]\nSource: ${source}${workerName ? ` @${workerName}` : ''}\nTool: ${toolName}\nReason: ${reason}\n${previewHint}\nUse /approve or /deny`,
  'tui.leader.heartbeat.waiting_model': 'Waiting for model response',
  'tui.leader.heartbeat.organizing_context': 'Organizing context',
  'tui.leader.heartbeat.planning_next': 'Planning next step',
  'tui.leader.heartbeat.autonomous_recovery': 'Autonomous recovery',
  'tui.leader.heartbeat.autonomous_orchestration': 'Autonomous orchestration',
  'tui.leader.heartbeat.working': 'Processing',
  'tui.leader.heartbeat.cancel_hint': ' · Esc to interrupt',
  'tui.leader.heartbeat.tool_executing': (tool: string, seconds: number) => `still executing ${tool} (${seconds}s)`,
  'tui.leader.heartbeat.long_stall': (status: string, seconds: number) => `${status} (${seconds}s) · try Ctrl+C to interrupt if it keeps hanging`,
  'tui.meta.age.seconds': (seconds: number) => `${seconds}s ago`,
  'tui.meta.age.minutes_seconds': (minutes: number, seconds: number) => `${minutes}m${seconds}s ago`,
  'tui.meta.age.minutes': (minutes: number) => `${minutes}m ago`,
  'tui.meta.tool': (tool: string, age: string) => `tool ${tool} ${age}`,
  'tui.meta.output': (age: string) => `output ${age}`,
  'tui.meta.heartbeat': (age: string) => `heartbeat ${age}`,
  'tui.meta.progress': (message: string) => `progress ${message}`,
  'tui.meta.backend': (backend: string) => `backend ${backend}`,
  'tui.meta.external_session': (id: string) => `external session ${id}`,
  'tui.meta.recovery': (action: string) => `recovery ${action}`,
  'tui.meta.approvals': (count: number) => `approvals ${count}`,
  'tui.meta.stream_outputs': (count: number) => `stream outputs ${count}`,
  'tui.meta.tasks': (total: number, inProgress: number, pending: number, blocked: number, completed: number, failed: number) =>
    `tasks ${total} · run ${inProgress} · pend ${pending} · block ${blocked} · done ${completed} · fail ${failed}`,
  'tui.meta.cwd': (workspace: string) => `cwd ${workspace}`,
  'tui.meta.tabs': (tabs: string, hiddenCount: number) => `tabs ${tabs}${hiddenCount > 0 ? ` +${hiddenCount}` : ''}`,
  'tui.meta.permission': (summary: string) => `permission:${summary}`,
  'tui.meta.route': (mode: string, preference: string) => `execution:${mode}${preference ? ` · preference:${preference}` : ''}`,
  'tui.meta.collaboration': (mode: string, activeTeamName: string) => `collab:${mode}${activeTeamName ? ` · team:${activeTeamName}` : ''}`,
  'tui.meta.unconfigured': '(unconfigured)',
  'tui.meta.control': (mode: string) => `control ${mode}`,
  'tui.meta.control_eternal': 'Eternal(auto)',
  'tui.meta.control_manual': 'Manual',
  'tui.meta.eternal': (status: string, idleCount: number, patrolCount: number) => `Eternal ${status} · idle ${idleCount} · patrol ${patrolCount}`,
  'tui.meta.queue': (count: number) => `queue ${count}`,
  'tui.meta.model': (model: string) => `model ${model}`,
  'tui.meta.tokens': (tokens: string) => `tokens ${tokens}`,
  'tui.meta.running': (count: number) => `running ${count}`,
  'tui.meta.done': (done: number, total: number) => `done ${done}/${total}`,
  'tui.meta.duration': (duration: string) => `duration ${duration}`,
  'tui.runtime.empty_output': '(empty output)',
  'tui.runtime.queue': (count: number) => `queue ${count}`,
  'tui.runtime.approval': (count: number) => `approval ${count}`,
  'tui.runtime.output': (count: number) => `output ${count}`,
  'tui.runtime.terminal': (count: number) => `terminal ${count}`,
  'tui.runtime.progress': (message: string) => `progress: ${message}`,
  'tui.runtime.pending': (message: string) => `pending: ${message}`,
  'tui.runtime.approval_line': (toolName: string, reason: string, hint: string) => `approval: ${toolName} · ${reason} · ${hint}`,
  'tui.runtime.output_line': (toolName: string, stream: string, pidText: string, summary: string) => `output: ${toolName} [${stream}${pidText}] · ${summary}`,
  'tui.runtime.terminal_line': (terminalId: string, pidText: string, status: string) => `terminal: tid=${terminalId}${pidText} · ${status}`,
  'tui.runtime.terminal.suspended': 'suspended',
  'tui.runtime.terminal.running': 'running',
  'tui.panel.loading': 'Loading...',
  'tui.panel.help.close': 'Up/Down scroll · PgUp/PgDn page · Esc/Ctrl+X close',
  'tui.sidebar.chat': 'Chat',
  'tui.sidebar.tasks': 'Tasks',
  'tui.sidebar.blueprint': 'Blueprint',
  'tui.sidebar.agents': 'Agents',
  'tui.sidebar.graph': 'Graph',
  'tui.sidebar.git': 'Git',
  'tui.sidebar.memory': 'Memory',
  'tui.sidebar.memory_running': 'running',
  'tui.sidebar.memory_due': 'due',
  'tui.sidebar.settings': 'Settings',
  'tui.sidebar.status': 'Status',
  'tui.sidebar.report': 'Report',
  'tui.sidebar.cost': 'Cost',
  'tui.sidebar.mode': 'Mode',
  'tui.sidebar.workers': 'Agents',
  'tui.sidebar.context': 'Context',
  'tui.sidebar.tokens': 'Usage',
  'tui.sidebar.model': 'Model',
  'tui.settings.title': 'Settings',
  'tui.settings.help': 'Up/Down select · Enter/click edit · Space toggle · Esc close',
  'tui.settings.help_nav': 'Up/Down select · Enter/click edit · Space toggle · Esc close',
  'tui.settings.help_edit': 'Type value · Enter save · Esc cancel · Home/End jump',
  'tui.settings.group.llm': 'LLM',
  'tui.settings.group.agents': 'Agents',
  'tui.settings.group.security': 'Security',
  'tui.settings.group.ui': 'UI',
  'tui.graph.title': 'Blackboard Graph',
  'tui.graph.empty_disabled': 'Blackboard is empty · it will fill after messages',
  'tui.graph.empty': 'No graph data yet',
  'tui.graph.more_edges': (count: number) => `  ... ${count} more edge(s)`,
  'tui.graph.meta': (nodes: number, factsConfirmed: number, factsTotal: number, openIntents: number, edges: number) =>
    `nodes ${nodes} · facts ${factsConfirmed}/${factsTotal} · open intents ${openIntents} · edges ${edges}`,
  'tui.git.not_repo': 'Current workspace is not a git repository',
  'tui.git.no_upstream': '(no upstream)',
  'tui.git.summary': (staged: number, unstaged: number, untracked: number, conflicted: number) =>
    `staged ${staged} · changed ${unstaged} · untracked ${untracked}${conflicted ? ` · conflicts ${conflicted}` : ''}`,
  'tui.git.staged': 'Staged',
  'tui.git.unstaged': 'Changed',
  'tui.git.untracked': 'Untracked',
  'tui.git.recent_commits': 'Recent commits',
  'tui.git.diff_header': (start: number, end: number, total: number) =>
    `Diff (${start}-${end}/${total} lines · Up/Down scroll)`,
  'tui.git.help': 'Up/Down scroll diff · Esc/Ctrl+X close · /git refresh',
  'tui.report.title': 'Report',
  'tui.report.help': 'Up/Down scroll · PgUp/PgDn page · Esc/Ctrl+X close',
  'tui.modal.resume_title': (count: number) => `Resume sessions · ${count} item(s)`,
  'tui.modal.history_title': (count: number) => `Session history · ${count} item(s)`,
  'tui.modal.picker_help': '  Up/Down select · Enter resume · Esc cancel',
  'tui.agent.running_task': (taskId: string) => `Running task ${taskId}`,
  'tui.agent.started_task': (taskId: string, backend: string) => `Started task ${taskId}${backend ? ` · backend ${backend}` : ''}`,
  'tui.agent.completed': (agentName: string, iterations: string, toolCalls: string) =>
    `● @${agentName} completed ✓ (${iterations} iterations, ${toolCalls} tool calls)`,
  'tui.agent.completed_self': (iterations: string, toolCalls: string) => `● completed ✓ (${iterations} iterations, ${toolCalls} tool calls)`,
  'tui.agent.tool_call': (tool: string) => `Calling ${tool}`,
  'tui.agent.tool_result': (tool: string) => `Received ${tool} result`,
  'tui.agent.failed': (error: string, recovery: string) => `Failed: ${error}${recovery ? ` · ${recovery}` : ''}`,
  'tui.agent.heartbeat_wait': 'Waiting for next output (worker heartbeat is healthy)',
  'tui.agent.task_created': (taskId: string, subject: string) => `Task ${taskId} created: ${subject}`,
  'tui.leader.interrupted': (stoppedAgents: number) =>
    `⏸ Interrupted${stoppedAgents > 0 ? `; stopped ${stoppedAgents} agent(s)` : ''}. Type a message to continue`,
  'tui.leader.session_completed': (sessionId: string) => `Session ${sessionId} completed`,
  'tui.plan.approved': '✅ Plan approved, starting execution...',
  'tui.plan.rejected': (feedback: string) => `Plan rejected, waiting for replanning${feedback}`,
  'tui.plan.rewrite_wait': 'Waiting for Leader to rewrite the plan from review feedback',
  'tui.plan.resubmit_wait': 'Waiting for Leader to resubmit the plan',
  'tui.plan.review_wait': 'Waiting for user plan review',
  'tui.plan.submitted': 'Execution plan submitted, waiting for approval.',
  'tui.event.session_created': (sessionId: string) => `Session ${sessionId} created`,
  'tui.event.session_failed': (sessionId: string, error: string) => `✗ Session ${sessionId} initialization failed: ${error}`,
  'tui.event.session_deleted': (sessionId: string) => `Session ${sessionId} deleted`,
  'tui.event.skills_project': (count: number) => `${count} project`,
  'tui.event.skills_plugin': (count: number) => `${count} plugin`,
  'tui.event.skill_source.project': 'project',
  'tui.event.skill_source.plugin': 'plugin',
  'tui.event.skill_source.global': 'global',
  'tui.event.skill_source.builtin': 'built-in',
  'tui.event.question_required': 'Your input is required',
  'tui.event.control_eternal': 'Switched to Eternal Mode (Leader autonomous)',
  'tui.event.control_manual': 'Switched to Manual Mode (user-led)',
  'tui.event.collaboration_mode_changed': (mode: string) => `Collaboration mode switched to ${mode}`,
  'tui.event.route_changed': (mode: string) => `Execution route preference switched to ${mode}`,
  'tui.event.permission_mode_changed': (mode: string) => `Permission mode switched to ${mode}`,
  'tui.event.blackboard_disabled': (reason: string) => `· Blackboard disabled: ${reason}`,
  'tui.event.llm_retry': (attempt: string, kind: string, message: string) => `⏳ LLM ${attempt}${kind}: ${message}`,
  'tui.event.llm_retry_attempt': (attempt: number) => `retry ${attempt}`,
  'tui.event.network_fluctuation': 'network/service fluctuation',
  'tui.event.agent_crashed': (agentName: string, detail: string) => `✗ @${agentName} process crashed${detail ? ` (${detail})` : ''}`,
  'tui.event.intervention': (agentName: string, messageType: string, content: string) =>
    `↳ Intervene @${agentName}${messageType ? ` [${messageType}]` : ''}: ${content}`,
  'tui.event.context_overflow': (tokens: string, threshold: string) => `⚠ Context is near the limit (${tokens}/${threshold} tokens), compacting soon`,
  'tui.event.building_args': (tool: string) => `⚙ Building arguments for ${tool}...`,
  'tui.event.partial_json': (partial: string) => `building params: ${partial}…`,
  'tui.event.session_synced': (sessionId: string) => `Synced to Web UI session ${sessionId}...`,
  'tui.event.session_switched': 'Session switched',
  'tui.event.wiki_started': '📖 Wiki generation started...',
  'tui.event.wiki_completed': (docs: number | null) => `✓ Wiki generation completed${docs != null ? ` (${docs} document(s))` : ''}`,
  'tui.event.wiki_failed': (error: string) => `✗ Wiki generation failed: ${error}`,
  'tui.event.unknown_error': 'unknown error',
  'tui.event.context_compressed': (oldTokens: string, newTokens: string) => `Context compressed: ${oldTokens} -> ${newTokens} tokens`,
  'tui.event.queue_cleared': (count: number) => `Cleared ${count} queued message(s)`,
  'tui.event.agent_stopped': (name: string) => `Stopped agent ${name} (leader and other agents are unaffected)`,
  'tui.diff.hidden': (count: number) => `... ${count} line(s) omitted ...`,
  'tui.tool.call': (toolName: string, preview: string) => `Call ${toolName}${preview ? `\n  ⎿ ${preview}` : ''}`,
  'tui.tool.result': (toolName: string, preview: string) => `Tool result ${toolName}${preview ? `\n  ⎿ ${preview}` : ''}`,
  'tui.message.collapse_long': 'Ctrl+S collapse long messages',
  'tui.message.hidden_top': (count: number) => `... ${count} earlier line(s) hidden ...`,
  'tui.message.hidden_bottom': (count: number) => `... ${count} later line(s) hidden ...`,
  'tui.copy.success': 'Copied to clipboard',
  'tui.copy.code_copied': (lines: number) => `Code copied (${lines} lines)`,
  'tui.copy.no_code': 'No code block to copy',
  'tui.mouse.tracking_on': 'Mouse tracking on · in-TUI select/click active',
  'tui.mouse.tracking_off': 'Mouse tracking off · use native terminal drag-select to copy',
  'slash.help.title': 'Available commands (/help or / to search):',
  'slash.help.image_upload': 'Image upload: include an image path in a message to detect it automatically (png/jpg/gif/webp)',
  'slash.help.image_example': '  Example: Analyze this image ./screenshot.png',
  'slash.help.shortcuts': 'Shortcuts:',
  'slash.help.ctrl_c': '  Ctrl+C  Interrupt the current session; press twice to exit',
  'slash.help.ctrl_s': '  Ctrl+S  Collapse/expand long messages',
  'slash.help.ctrl_q': '  Ctrl+Q  Exit',
  'slash.help.ctrl_x': '  Ctrl+X  Task DAG panel',
  'slash.help.ctrl_e': '  Ctrl+E  Team/Agent panel',
  'slash.help.ctrl_n': '  Ctrl+N  Notification center',
  'slash.help.ctrl_w': '  Ctrl+W  Work notes panel',
  'slash.help.ctrl_g': '  Ctrl+G  Git workspace panel',
  'slash.help.ctrl_digits': '  Ctrl+0-9  Quick channel switch',
  'slash.help.history': '  Up/Down  Navigate input history',
  'slash.help.mouse_wheel': '  Mouse wheel  Scroll log',
  'slash.help.skill': '  $skill_name  Inject a skill',
  'slash.category.session': 'Session',
  'slash.category.view': 'Views / Panels',
  'slash.category.permission': 'Permissions / Approvals',
  'slash.category.project': 'Project Orchestration',
  'slash.category.model': 'Models / Config',
  'slash.category.tools': 'Tools / Skills',
  'slash.category.misc': 'Other',

  // === TUI Task Board ===
  'tui.task.no_tasks': 'No tasks yet',
  'tui.task.depends_on': 'depends on',
  'tui.task.switch_hint': 'Press Tab to switch panels',
  'tui.task.total': 'total',
  'tui.task.pending': 'Pending',
  'tui.task.in_progress': 'In Progress',
  'tui.task.completed': 'Completed',

  // === TUI Team View ===
  'tui.team.title': 'Team',
  'tui.team.no_agents': 'No active agents',
  'tui.team.auto_refresh': 'Auto-refresh',
  'tui.team.never': 'never',
  'tui.team.seconds_ago': (seconds: number) => `${seconds}s ago`,
  'tui.team.minutes_ago': (minutes: number) => `${minutes}m ago`,
  'tui.team.hours_ago': (hours: number) => `${hours}h ago`,
  'tui.team.pid': 'pid',
  'tui.team.session': 'session',
  'tui.team.recovery': 'recovery',
  'tui.team.stderr': 'stderr',
  'tui.team.depends': 'depends',
  'tui.team.stop_hint': '↑/↓ select agent · Enter to focus · switch to it, then Esc to stop only that one',

  // === TUI Notification Center ===
  'tui.notification.title': 'Notifications',
  'tui.notification.empty': 'No notifications',
  'tui.notification.unread': 'unread',

  // === TUI Session Status ===
  'tui.main.no_session': 'No session created yet',
  'tui.session.status_label': 'Session:',
  'tui.session.status_field': 'Status',
  'tui.session.workspace': 'Workspace',
  'tui.permissions.label': 'Permissions',

  // === TUI Message Log ===
  'tui.message.above_hint': (count: number) => `↑ ${count} more message(s) above`,
  'tui.message.no_messages': 'No messages yet',

  // === TUI DAG Panel ===
  'tui.dag.status.completed': 'Done',
  'tui.dag.status.in_progress': 'In Progress',
  'tui.dag.status.pending': 'Pending',
  'tui.dag.status.blocked': 'Blocked',
  'tui.dag.status.failed': 'Failed',
  'tui.dag.status.cancelled': 'Cancelled',
  'tui.dag.role.research': 'Research',
  'tui.dag.role.coding': 'Coding',
  'tui.dag.role.review': 'Review',
  'tui.dag.role.verify': 'Verify',
  'tui.dag.role.frontend': 'Frontend',
  'tui.dag.role.backend': 'Backend',
  'tui.dag.role.qa': 'QA',
  'tui.dag.role.ux_designer': 'Design',
  'tui.dag.empty': 'No tasks yet',
  'tui.dag.meta': (tasks: number, levels: number, agents: number, page: string) =>
    `${tasks} tasks · ${levels} levels · ${agents} agents${page}`,
  'tui.dag.dependency': 'Depends: ',
  'tui.dag.progress': 'Progress: ',
  'tui.suggestions.help': '  Up/Down select · Tab apply · Esc cancel',
  'tui.error.component_crashed_log': (name: string) => `[ErrorBoundary] ${name} component crashed:`,
  'tui.error.component_stack_log': '[ErrorBoundary] component stack:',
  'tui.error.component_error': (name: string) => `Component error: ${name}`,
  'tui.error.component_retry_hint': 'Press any key to retry or continue elsewhere',
  'tui.agent.runtime_title': 'Runtime',
  'tui.agent.heartbeat_ok': (phase: string) => `worker heartbeat healthy${phase ? ` · ${phase}` : ''}`,
  'tui.agent.wait_progress': 'Waiting for new progress',
  'tui.leader.agents_working_one': (agent: string) => `${agent} is working`,
  'tui.leader.agents_working_many': (count: number) => `${count} agents working in parallel`,
  'tui.agent.spawn_task_desc': (taskId: string) => `task ${taskId}`,
  'tui.modal.task.field.status': 'Status',
  'tui.modal.task.field.type': 'Type',
  'tui.modal.task.field.dependency': 'Depends',
  'tui.modal.task.field.directory': 'Directory',
  'tui.modal.task.detail_title': (taskId: string) => `Task detail [${taskId}]`,
  'tui.modal.task.subject': 'Subject',
  'tui.modal.task.working_directory': 'Working directory',
  'tui.modal.task.write_scope': 'Write scope',
  'tui.plan.dependency': (deps: string) => ` <- depends on ${deps}`,
  'tui.plan.status': (status: string) => ` · status=${status}`,
  'tui.plan.batch': (index: number, group: string) => `**Batch ${index}** (parallel): ${group}`,
  'tui.plan.title': '# 📋 Execution Plan',
  'tui.plan.goal': 'Goal',
  'tui.plan.analysis': 'Analysis',
  'tui.plan.approach': 'Approach',
  'tui.plan.risks': 'Risks and Decisions',
  'tui.plan.tasks': 'Tasks',
  'tui.plan.strategy': 'Execution Strategy',
  'tui.plan.verification': 'Verification Plan',
  'tui.plan.approve_hint': '✅ Type `/approve` to approve · 💬 Type feedback · ⬅️ Press Tab back to @main',

  // === TUI Welcome Banner ===
  'tui.welcome.tagline': '凌霄剑域',
  'tui.welcome.motto': '青锋照夜',
  'cli.farewell.motto': '剑归鞘 · 青锋照夜',
  'cli.farewell.session': '会话',
  'cli.farewell.resume': '续接',
  'tui.welcome.shortcuts': 'Shortcuts',
  'tui.welcome.shortcut.cmd': '  /         Command',
  'tui.welcome.shortcut.interrupt': '  Esc       Interrupt',
  'tui.welcome.shortcut.dag': '  Ctrl+X    DAG Workflow',
  'tui.welcome.shortcut.tab': '  Tab       Switch Panel',

  // === TUI Work Notes ===
  'tui.worknotes.title': '📋 Work Notes',
  'tui.worknotes.empty': 'No work notes yet. Agents will write notes as they work.',
  'tui.worknotes.count': (count: number) => `(${count} notes)`,

  // === TUI Picker Panel ===
  'tui.picker.empty': 'No items',
  'tui.picker.showing': (start: number, end: number, total: number) => `  Showing ${start}-${end} / ${total}`,
  'tui.picker.above': (count: number) => `  ↑ ${count} more above`,
  'tui.picker.below': (count: number) => `  ↓ ${count} more below`,

  // === TUI Agent Status Bar ===
  'tui.agents.running': (count: number) => `Agents: ${count} running`,
  'tui.agents.done': (count: number) => `${count} done`,
  'tui.agents.paused': (count: number) => `${count} paused`,
  'tui.agents.failed': (count: number) => `${count} failed`,

  // === TUI Command Arg Picker ===
  'tui.cmdpicker.filter': 'Filter:',
  'tui.cmdpicker.filter_hint': 'Backspace to clear',
  'tui.cmdpicker.help': '  ↑/↓ move  ·  Enter select  ·  1-9 jump  ·  Esc cancel',

  // === TUI rewind dialog /rewind ===
  'tui.rewind.title': 'Rewind to checkpoint',
  'tui.rewind.help_pick': '  ↑/↓ select  ·  type to filter  ·  1-9 jump  ·  Enter next  ·  Esc cancel',
  'tui.rewind.help_scope': '  ↑/↓ choose scope  ·  Enter next  ·  Esc cancel',
  'tui.rewind.help_confirm': '  ↑/↓ select  ·  Enter confirm  ·  Esc cancel',
  'tui.rewind.empty': 'Nothing to rewind',
  'tui.rewind.working_label': 'Working tree (uncommitted)',
  'tui.rewind.files_unit': ' files',
  'tui.rewind.just_now': 'just now',
  'tui.rewind.minutes_ago': (n: number) => `${n}m ago`,
  'tui.rewind.hours_ago': (n: number) => `${n}h ago`,
  'tui.rewind.days_ago': (n: number) => `${n}d ago`,
  'tui.rewind.target': 'Rewind to:',
  'tui.rewind.impact_title': 'Impact preview',
  'tui.rewind.code_label': 'Code:',
  'tui.rewind.conv_label': 'Chat:',
  'tui.rewind.messages_to_delete': (n: number) => `${n} message(s) will be deleted`,
  'tui.rewind.no_messages': 'no chat change',
  'tui.rewind.cross_session_warn': (ids: string) => `Other sessions committed after this checkpoint (${ids}); reverting code may affect them`,
  'tui.rewind.db_only_hint': 'No git snapshot for this checkpoint — chat-only rewind',
  'tui.rewind.scope_all': 'Both (code + chat)',
  'tui.rewind.scope_all_desc': 'full rewind to this checkpoint',
  'tui.rewind.scope_code': 'Code only',
  'tui.rewind.scope_code_desc': 'restore files, keep chat',
  'tui.rewind.scope_conversation': 'Chat only',
  'tui.rewind.scope_conversation_desc': 'drop messages, keep files',
  'tui.rewind.confirm_plan': 'About to:',
  'tui.rewind.plan_code': (n: number) => `restore ${n} file(s) to this checkpoint`,
  'tui.rewind.plan_conv': (n: number) => `delete ${n} message(s) after the rewind point`,
  'tui.rewind.plan_conv_none': 'no chat change',
  'tui.rewind.will_interrupt': 'interrupt in-flight work (Leader resumes from the truncated point)',
  'tui.rewind.confirm_label': 'Confirm rewind',
  'tui.rewind.cancel': 'Cancel',
  // === /rewind command strings ===
  'cmd.rewind.no_session': 'No active session',
  'cmd.rewind.no_workspace': 'Current session has no workspace; cannot rewind',
  'cmd.rewind.load_failed': (err: string) => `Failed to load checkpoints: ${err}`,
  'cmd.rewind.empty': 'No checkpoints or working-tree changes to rewind',
  'cmd.rewind.pick_loaded': (count: number) => `${count} checkpoint(s) loaded`,
  'cmd.rewind.working_entry': (count: number) => `${count} uncommitted file(s) in working tree`,
  'cmd.rewind.cp_not_found': (id: string) => `Checkpoint not found: ${id}`,
  'cmd.rewind.scope_loaded': (label: string) => `Selected: ${label}`,
  'cmd.rewind.bad_scope': (raw: string) => `Invalid scope "${raw}"; expected code / conversation / all`,
  'cmd.rewind.db_only_conversation': 'No git snapshot for this checkpoint; chat-only rewind (use scope conversation)',
  'cmd.rewind.confirm_ready': 'Confirm the rewind plan',
  'cmd.rewind.need_confirm': 'Confirmation required: run /rewind <id> <scope> confirm to execute',
  'cmd.rewind.exec_failed': (err: string) => `Rewind failed: ${err} (shadow git keeps full history; you can recover manually)`,
  'cmd.rewind.done_working': 'Discarded all uncommitted working-tree changes',
  'cmd.rewind.done': (scope: string, label: string, truncated: number) =>
    scope === 'all' ? `Rewound to "${label}" (code + ${truncated} chat messages)`
      : scope === 'conversation' ? `Deleted ${truncated} chat message(s) (code untouched)`
        : `Restored code to "${label}"`,
  'cmd.rewind.usage': 'Usage: /rewind [checkpointId] [code|conversation|all] [confirm]',

  // === TUI Question Dialog ===
  'tui.question.title': 'Please answer the following',
  'tui.question.tab_hint': '  ←/→ switch  ·  ↑/↓ select  ·  Space toggle  ·  Enter submit  ·  Esc cancel',
  'tui.question.submit': 'Submit',
  'tui.question.cancel': 'Cancel',
  'tui.question.other': 'Other...',
  'tui.question.other_placeholder': 'Type here...',
  'tui.question.answered': '✓',
  'tui.question.answered_count': (answered: number, total: number) => `${answered}/${total} answered`,
  'tui.question.help_single': '  ↑/↓ move  ·  Enter select  ·  1-9 jump  ·  Esc cancel',
  'tui.question.help_multi': '  ↑/↓ move  ·  Space toggle  ·  Enter submit  ·  Esc cancel',
  'tui.question.type_answer': 'Type your answer:',
  'tui.question.help_multi_step': (isFinal: boolean) =>
    `Up/Down move  Space/number toggle  Tab ${isFinal ? 'submit' : 'next question'}  b previous`,
  'tui.question.help_single_step': (isFinal: boolean) =>
    `Up/Down move  number jump  Tab ${isFinal ? 'submit' : 'next question'}  b previous`,
  'tui.question.help_text_step': (isFinal: boolean) =>
    isFinal ? 'Enter submit  b previous' : 'Enter/Tab next question  b previous',
  'tui.question.selected_count': (count: number) => `  ✓ ${count} selected`,
  'tui.question.multi_title': (count: number) => `${count} questions require answers`,
  // Settings 面板反馈
  'tui.settings.feedback.invalid_number': 'Invalid number',
  'tui.settings.feedback.validation_failed': 'Validation failed',
  'tui.settings.feedback.write_failed': 'Write failed',
  'tui.settings.feedback.saved': (label: string) => `${label} saved`,
  'tui.settings.feedback.schema_failed': 'Schema validation failed',
  'tui.settings.feedback.save_failed': 'Save failed',
  'tui.settings.feedback.value_set': (label: string, value: string) => `${label} = ${value}`,
  // StreamingStatusLine 流式状态条
  'tui.stream.phrases': ['Processing', 'Streaming', 'Calculating', 'Analyzing', 'Generating', 'Scanning', 'Fetching', 'Syncing', 'Mapping', 'Exploring', 'Linking', 'Adapting', 'Learning', 'Observing', 'Connecting'],
  'tui.stream.tool.write': 'writing file',
  'tui.stream.tool.edit': 'editing',
  'tui.stream.tool.notebookedit': 'editing notebook',
  'tui.stream.tool.read': 'reading file',
  'tui.stream.tool.bash': 'running command',
  'tui.stream.tool.powershell': 'running command',
  'tui.stream.tool.grep': 'searching content',
  'tui.stream.tool.glob': 'searching files',
  'tui.stream.tool.webfetch': 'fetching web',
  'tui.stream.tool.websearch': 'searching web',
  'tui.stream.tool.agent': 'spawning agent',
  'tui.stream.tool.skill': 'running skill',
  'tui.stream.tool.default': (tool: string) => `writing ${tool}`,
  'tui.stream.phase.running_tool': (tool: string) => `running ${tool}`,
  'tui.stream.phase.waiting_model': 'waiting for model',
  'tui.stream.phase.retrying': 'retrying',
  'tui.stream.phase.compacting': (tool?: string) => tool ? `compacting context (${tool})` : 'compacting context',
  'tui.stream.phase.streaming': 'streaming',
  'tui.stream.phase.tool_executing': (tool: string) => `executing ${tool}`,
  'tui.stream.building_params': (partial: string) => `building params: ${partial}…`,
  'tui.stream.chunk': (index: string | number, total: string | number) => `chunk ${index}/${total}`,
  'tui.stream.tokens_up': (n: string) => `↑ ${n} tokens`,
  'tui.stream.tokens_down': (n: string) => `↓ ${n} tokens`,
  'tui.stream.llm_summary': (tool?: string) => tool ? `LLM summary (${tool})` : 'LLM summary',
  'tui.stream.compacting_conversation': '· Compacting conversation…',
  'tui.stream.esc_interrupt': 'esc to interrupt',
  // MemoryPanel 记忆维护面板
  'tui.memory.title': 'Memory Maintenance',
  'tui.memory.loading_hint': 'Memory status is loading. Use /dream or /distill to run maintenance.',
  'tui.memory.never': 'never',
  'tui.memory.kind.dream': 'dream',
  'tui.memory.kind.distill': 'distill',
  'tui.memory.pipeline_due': 'due',
  'tui.memory.pipeline_scheduled': 'scheduled',
  'tui.memory.pipeline_interval': (interval: number, lookback: number) => `every ${interval}d · lookback ${lookback}d`,
  'tui.memory.pipeline_last': (date: string) => `last ${date}`,
  'tui.memory.memory_lines': (lines: number, bytes: string) => `${lines} lines · ${bytes}`,
  'tui.memory.memory_not_created': 'not created',
  'tui.memory.checkpoints_assets': (checkpoints: number, assets: number) => `checkpoints ${checkpoints} · assets ${assets}`,
  'tui.memory.recent_assets': 'Recent assets',
  'tui.memory.no_assets': 'No distilled assets yet.',
  'tui.memory.run_hint': 'Run /dream to consolidate memory, /distill [days] to extract reusable assets.',
  // TipsRotator 提示轮播
  'tui.tips': ['Type / to see all available commands', 'Ctrl+C interrupts the current task', 'Tab switches channels to view agent status', 'Supports multi-agent parallel collaboration', 'Describe your needs in natural language to start', '/dag views the task dependency graph', 'Ctrl+S toggles message collapse mode', 'Long pastes auto-collapse, expand on submit'],
  // toolLogItem 工具调用/结果摘要
  'tui.tool.unserializable': '[unserializable payload]',
  'tui.tool.summary.calling': (tool: string) => `Calling ${tool}...`,
  'tui.tool.summary.reading': (path: string, lineInfo: string) => `Reading ${path || 'file'}${lineInfo}`,
  'tui.tool.summary.listing': (path: string) => `Listing ${path}`,
  'tui.tool.summary.fetching': (url: string) => `Fetching ${url || 'URL'}`,
  'tui.tool.summary.searching': (query: string) => `Searching "${query || '...'}"`,
  'tui.tool.summary.writing': (path: string) => `Writing ${path || 'file'}`,
  'tui.tool.summary.running': (cmd: string) => `Running: ${cmd || 'command'}`,
  'tui.tool.summary.args': (keys: string) => `Args: ${keys}`,
  'tui.tool.summary.creating': (path: string) => `Creating ${path || 'file'}`,
  'tui.tool.summary.patching': (path: string, hunks: number) => `Patching ${path || 'file'} (${hunks} hunks)`,
  'tui.tool.summary.globbing': (pattern: string) => `Glob ${pattern}`,
  'tui.tool.summary.searching_code': (detail: string) => `Code search: ${detail}`,
  'tui.tool.summary.python': (code: string) => `Python: ${code}`,
  'tui.tool.summary.http': (method: string, url: string) => `${method} ${url}`,
  'tui.tool.summary.browser': (action: string, target: string) => `Browser ${action}${target ? ` → ${target}` : ''}`,
  'tui.tool.summary.browser_verify': (url: string) => `Verify page ${url || '...'}`,
  'tui.tool.summary.screenshot': (url: string) => `Screenshot ${url || '...'}`,
  'tui.tool.summary.git': (action: string) => `Git: ${action}`,
  'tui.tool.summary.creating_task': (subject: string) => `Create task: ${subject}`,
  'tui.tool.summary.updating_task': (taskId: string) => `Update task ${taskId}`,
  'tui.tool.summary.updating_status': (taskId: string, status: string) => `Status ${taskId} → ${status}`,
  'tui.tool.summary.dispatching': (taskId: string, agent: string) => `Dispatch ${taskId} → ${agent}`,
  'tui.tool.summary.exploring': (goal: string) => `Explore: ${goal}`,
  'tui.tool.summary.agent_op': (op: string, agent: string) => `${op} ${agent}`,
  'tui.tool.summary.messaging': (recipient: string) => `Message ${recipient}`,
  'tui.tool.summary.writing_note': (summary: string) => `Note: ${summary}`,
  'tui.tool.summary.plan': (action: string, detail: string) => `${action}: ${detail}`,
  'tui.tool.summary.memory_op': (action: string) => `Memory: ${action}`,
  'tui.tool.summary.asking': (question: string) => `Ask: ${question}`,
  'tui.tool.summary.finish': (summary: string) => `Finish: ${summary}`,
  'tui.tool.summary.download_link': (path: string) => `Download link: ${path}`,
  'tui.tool.summary.defining_role': (role: string) => `Define role: ${role}`,
  'tui.tool.result.line_single': (line: number) => `line ${line}`,
  'tui.tool.result.line_range': (a: number, b: number) => `lines ${a}-${b}`,
  'tui.tool.result.read_lines': (range: string, total: number) => `Read ${range} (${total} lines)`,
  'tui.tool.result.read_chars': (chars: number) => `Read (${chars} chars)`,
  'tui.tool.result.no_output': '(no output)',
  'tui.tool.result.listed': (entries: number, files: number, dirs: number) => `Listed directory (${entries} entries${files ? `, ${files} files` : ''}${dirs ? `, ${dirs} dirs` : ''})`,
  'tui.tool.result.fetched': (chars: number) => `Fetched (${chars} chars)`,
  'tui.tool.result.searched': (count: number) => count > 0 ? `Searched (${count} results)` : 'Searched',
  'tui.tool.result.generic': (chars: number) => `Result (${chars} chars)`,
  'tui.tool.result.created': 'Created/written',
  'tui.tool.result.patched': (added: number, removed: number) => `Patched (+${added} -${removed})`,
  'tui.tool.result.searched_code': (count: number) => `Code search (${count} matches)`,
  'tui.tool.result.git': 'Git operation done',
  'tui.tool.result.dispatched': 'Dispatched',
  'tui.tool.result.browser': 'Browser action done',
  'tui.tool.result.executed': (lines: number) => `Executed (${lines} lines output)`,
  'tui.tool.result.http': (status: string | number) => `HTTP response (${status})`,
  'tui.tool.result.task_done': 'Task operation done',
  // Leader / Agent 运行状态显示文本
  'tui.leader.status.completed': 'Completed',
  'tui.leader.status.leading': 'Leading…',
  'tui.leader.status.thinking': 'Thinking…',
  'tui.leader.status.observing': 'Observing…',
  'tui.leader.status.executing': 'Executing…',
  'tui.leader.status.replanning': 'Replanning…',
  'tui.leader.status.wrapping_up': 'Wrapping up…',
  'tui.leader.status_log': (status: string) => `Leader: ${status}`,
  'tui.leader.mode_changed': (mode: string, reason: string) => `Leader mode -> ${mode}: ${reason}`,
  'tui.agent.status.calling': (tool: string) => `Calling ${tool}…`,
  'tui.agent.status.observing': 'Observing…',
  'tui.agent.status.working': 'Working…',
  'tui.agent.status.thinking': 'Thinking…',
  'tui.agent.launched_count': (count: number) => `● ${count} agents launched`,
  'tui.event.orchestration_rejected': (eventType: string, reason: string) => `Orchestration rejected ${eventType}: ${reason || 'unknown'}`,
  'tui.event.skills_ready': (count: number) => `${count} skills ready`,
  'tui.event.skill_invoked': (name: string, sourceTag: string, summary: string) => `✓  Use skill: "${name}" (${sourceTag}) — ${summary}`,
  'tui.event.soul_updated': (path: string, count: number) => `· Soul updated: ${path} (${count} entries)`,
  // tuiViewModel 元行段
  'tui.meta.eternal_goal': (goal: string) => `goal ${goal}`,
  'tui.meta.pid': (pid: number) => `pid ${pid}`,
  'tui.meta.stderr': (text: string) => `stderr ${text}`,
  'tui.meta.shell': (text: string) => `shell ${text}`,
  // 杂项状态文案
  'tui.diff.hunk': (n: number) => `── Hunk ${n} ──`,
  'tui.runtime.shell': (text: string) => `shell ${text}`,
  'tui.channel.trimmed': (n: number) => `... ${n} earlier messages trimmed ...`,
  'tui.error.not_a_tty': 'Error: stdin is not a TTY. Raw mode is not supported.',
  'tui.error.not_a_tty_hint': 'Please run lingxiao in an interactive terminal, not in background or through pipes.',
  // utils 模态表头/工具卡片摘要
  'tui.modal.tool_result': 'Tool result',
  'tui.modal.tool_calling': (tool: string) => `Calling ${tool}...`,
  'tui.code.empty': '(empty)',
  'tui.modal.task.header.id': 'ID',
  'tui.modal.task.header.status': 'STATUS',
  'tui.modal.task.header.type': 'TYPE',
  'tui.modal.task.header.agent': 'AGENT',
  'tui.modal.task.header.subject': 'SUBJECT',
  'tui.modal.task.field.agent': 'Agent',
  'tui.modal.session.header.session': 'SESSION',
  'tui.modal.session.header.status': 'STATUS',
  'tui.modal.session.header.time': 'TIME',
  'tui.modal.session.header.preview': 'PREVIEW',
  'tui.modal.skill.header.skill': 'SKILL',
  'tui.modal.skill.header.source': 'SOURCE',
  'tui.modal.skill.header.preview': 'PREVIEW',
  // 批D: 布局/小UI 零散文案
  'tui.home.brand': 'LingXiao',
  'tui.home.version_prefix': 'LingXiao CLI  v',
  'tui.home.input_hint': 'Type your question... (/ for commands)',
  'tui.header.tokens': 'tokens',
  'tui.message.tool_default': 'tool',
  'tui.message.tool_done': 'done',
  'tui.message.tool_running': 'running',
  'tui.message.code_default': 'code',
  'tui.message.thinking_summary': (count: number) => `Thought · ${count}`,
  'tui.dag.title': 'Task Graph',
  'tui.dag.help': '↑/↓ navigate  ←/→ page  Enter jump  Ctrl+X close',
  'tui.dag.stat_total': 'TOTAL ',
  'tui.leader.mode_label': 'mode: ',
  'tui.leader.control_label': 'control: ',
  'tui.leader.control_manual': 'manual',
  'tui.sidebar.brand': 'LingXiao',
  'tui.sidebar.mode_chat': 'CHAT',
  'tui.sidebar.mode_plan': 'PLAN',
  'tui.sidebar.mode_agent': 'AGENT',
  'tui.git.title': 'Git',
  'tui.graph.edges_header': (count: number) => `Edges (${count})`,
  'tui.worknotes.blockers': 'blockers: ',
  'tui.question.other_label': 'Other: ',
  'tui.task.empty_dash': '  --',
  'tui.settings.options': '  options: ',
  'tui.agents.default_name': 'agent',
  'tui.session.status_active_default': 'active',
  'tui.session.orchestration': 'orchestration: ',
  'tui.team.no_task': '--',
  'tui.team.tools_count': (count: number) => `tools=${count}`,
  'tui.code.being_written': '... code is being written ...',
  'tui.code.generating_more': '... generating more ...',
  'tui.code.first_lines_hidden': (count: number) => `... first ${count} line${count === 1 ? '' : 's'} hidden ...`,
  'tui.table.column_fallback': (index: number) => `Column ${index}`,
  // Runtime errors (throw)
  'error.session_not_found': (id: string) => `Session not found: ${id}`,
  'error.role_not_found': (role: string) => `Role '${role}' not found`,
  'error.filellock_timeout': (path: string, secs: number) => `File lock timeout: ${path} (waited ${secs}s)`,
  'error.filerdlock_timeout': (path: string) => `Read lock timeout: ${path} (writer waiting)`,
  'error.filewrlock_timeout': (path: string) => `Write lock timeout: ${path} (readers active)`,
  'error.filellock_timeout_waiting': (path: string) => `File lock timeout: ${path}`,
  'error.filelock_need_readlock': 'Must hold a read lock before upgrading',
  'error.filelock_need_writelock': 'Must hold a write lock before downgrading',
  'error.task_out_of_scope': (abs: string, root: string) => `Task out of scope: ${abs} is not inside workspace ${root}`,
  'error.worktree_not_git': 'Current directory is not a git repository, cannot create worktree',
  'error.worktree_path_exists': (path: string) => `Worktree path already exists: ${path}`,
  'error.worktree_create_failed': (stderr: string) => `Failed to create worktree: ${stderr}`,
  'error.config_validation': 'modelProviders configuration validation failed, please fix and retry',
  'error.worker_write_failed': (path: string, err: string) => `Failed to write worker payload (${path}): ${err}`,
  'error.redirect_unsafe': (reason: string) => `Unsafe redirect target - ${reason}`,
  'error.redirect_limit': (max: number) => `Redirect limit exceeded (${max})`,
  'error.redirect_no_location': 'Redirect response missing Location header',
  'error.redirect_invalid': (reason: string) => `Invalid redirect target - ${reason}`,
  'error.redirect_invalid_url': (reason: string) => reason || 'Invalid URL',
  'error.summary_empty_response': 'Summary model returned empty response',
  'error.skill_not_registered': (name: string, available: string) => `Skill '${name}' not registered. Available skills: ${available}`,
  'error.path_access_denied': 'Access denied to other session directories. Use only the current session scratchpad/context paths.',
  'error.path_out_of_bounds': 'Path out of bounds: cannot write outside workspace',
  'error.write_out_of_scope': (path: string, roots: string) => `Write path out of allowed scope: ${path}. Allowed: ${roots}`,
  'error.ocr_file_not_found': (path: string) => `File not found: ${path}`,
  'error.ocr_svg_unsupported': 'SVG vector images are not supported for OCR',
  'error.ocr_invalid_data_uri': 'Invalid data URI format',
  'error.ocr_unknown_source': 'Cannot determine image source',
  'external_agent.role.claude_coding.description': 'Claude Code CLI external sub-agent for long-running code implementation, cross-file edits, and Claude ecosystem tasks',
  'external_agent.role.codex_coding.description': 'Codex CLI external sub-agent for OpenAI/Codex ecosystem coding, patching, and repository engineering tasks',
  'external_agent.disabled': (backend: string) => `ExternalAgent(${backend}) is disabled in settings`,
  'external_agent.command_not_found': (backend: string, command: string) => `ExternalAgent(${backend}) command not found: ${command}`,
  'external_agent.model_missing': (backend: string) => `ExternalAgent(${backend}) has no configured model. Set role.model`,
  'external_agent.api_key_missing': (backend: string, model: string, envKey: string) => `ExternalAgent(${backend}) model '${model}' is missing API key (envKey=${envKey})`,
  'external_agent.base_url_missing': (backend: string, model: string) => `ExternalAgent(${backend}) model '${model}' is missing baseUrl`,
  'external_agent.claude_incompatible': (model: string, provider: string, baseUrl: string) => `ExternalAgent(claude) requires an Anthropic-compatible model. Current model '${model}' provider=${provider} baseUrl=${baseUrl}`,
  'external_agent.codex_incompatible': (model: string, provider: string, baseUrl: string) => `ExternalAgent(codex) requires an OpenAI-compatible model. Current model '${model}' provider=${provider} baseUrl=${baseUrl}`,
  'external_agent.timeout': (backend: string, ms: number) => `ExternalAgent(${backend}) timed out after ${ms}ms`,
  'external_agent.idle_timeout': (backend: string, ms: number) => `ExternalAgent(${backend}) idle timeout after ${ms}ms`,
  'external_agent.terminated': (backend: string) => `ExternalAgent(${backend}) terminated`,
  'external_agent.exit_nonzero': (backend: string, code: number | null, signal: string, stderr: string) => `ExternalAgent(${backend}) exited with code=${code} signal=${signal} stderr=${stderr}`,
  // CLI runtime hints
  'cli.instance_running': (pid: number, port: number) => `⚠ Existing instance detected (PID ${pid}, port ${port})`,
  'cli.port_in_use': (old: number, actual: number) => `⚠ Port ${old} in use, using ${actual}`,
  'cli.available_skills': 'Available skills',
  'cli.no_skills': 'No skills available',
};

/**
 * 当前语言实例（运行时可变）
 */
let currentLanguage: Language = 'zh';
let currentStrings: I18nStrings = zhStrings;

/**
 * 会话级语言（独立于 UI 语言，用于控制 LLM 回复语言）
 */
let sessionLanguage: Language = 'zh';

/**
 * 设置当前语言
 */
export function setLanguage(lang: Language): void {
  currentLanguage = lang;
  currentStrings = lang === 'zh' ? zhStrings : enStrings;
  mergeCliStrings();
  cliStringsMerged = true;
}

/**
 * 获取当前语言
 */
export function getLanguage(): Language {
  return currentLanguage;
}

/**
 * 设置会话语言（用于 LLM 交互语言控制）
 */
export function setSessionLanguage(lang: Language): void {
  sessionLanguage = lang;
}

/**
 * 获取会话语言
 */
export function getSessionLanguage(): Language {
  return sessionLanguage;
}

/**
 * 规范化语言代码，接受 'zh'/'en'/'zh-CN'/'en-US' 等变体
 */
export function normalizeLanguage(raw: string): Language {
  const lower = raw.toLowerCase().trim();
  if (lower.startsWith('zh') || lower.startsWith('cn') || lower.startsWith('zh-cn') || lower.startsWith('zh_cn')) return 'zh';
  if (lower.startsWith('en') || lower.startsWith('us') || lower.startsWith('en-us') || lower.startsWith('en_us')) return 'en';
  throw new Error(`Unsupported language: ${raw}`);
}

/**
 * 便捷函数：获取错误标签
 */
export function errorLabel(key: I18nKey & `error.${string}`): string {
  return currentStrings[key] as string;
}

/**
 * 仅供校验：返回 zh/en 两套 catalog 的 key 集合（含懒加载的 cli.* 合并结果），
 * 用于 parity 测试，确保两语言一一对应、杜绝只加了一种语言的 key。
 */
export function getI18nCatalogKeys(): { zh: string[]; en: string[] } {
  return {
    zh: Object.keys({ ...zhStrings, ...zhCliStrings }),
    en: Object.keys({ ...enStrings, ...enCliStrings }),
  };
}

/**
 * 便捷函数：获取进度文本
 */
export function progressText(elapsedSec: number): string {
  if (elapsedSec < 5) return currentStrings['progress.connecting'];
  if (elapsedSec < 15) return currentStrings['progress.waiting_response'];
  return currentStrings['progress.processing'](elapsedSec);
}

// ============================================================================
// CLI 消息目录 (延迟加载，保持核心模块轻量)
// ============================================================================

type CliStrings = Record<`cli.${string}`, string>;

const zhCliStrings: CliStrings = {
  'cli.welcome': '凌霄剑域 - 动态智能编排系统',
  'cli.init_detect_no_config': '未检测到配置文件，开始首次设置...',
  'cli.provider_prompt': '选择 Provider 类型:',
  'cli.provider_option_openai': '  1. OpenAI 格式 (OpenAI, DeepSeek, Kimi, Groq 等)',
  'cli.provider_option_anthropic': '  2. Anthropic 格式 (Claude API)',
  'cli.provider_option_auto': '  3. 自动检测',
  'cli.provider_choice_prompt': '请输入选项 (默认 3):',
  'cli.auto_detect_config': '自动检测模式',
  'cli.auto_detect_hint': '请输入 API Key 和 Base URL，系统将自动识别 Provider 类型。',
  'cli.api_key_prompt': 'API Key:',
  'cli.base_url_prompt': 'Base URL:',
  'cli.detected_provider': '检测到 Provider:',
  'cli.config_saved': '配置已保存到',
  'cli.config_save_failed': '保存配置失败:',
  'cli.check_permissions_hint': '请检查写入权限:',
  'cli.current_config': '当前配置:',
  'cli.command_start': '启动凌霄会话',
  'cli.command_init': '初始化配置',
  'cli.command_list': '列出活跃会话',
  'cli.command_demo': '演示模式',
  'cli.command_doctor': '诊断系统状态',
  'cli.command_about': '关于凌霄',
  'cli.session_not_found': '会话不存在:',
  'cli.session_resume_hint': '使用 lingxiao --session <session_id> 恢复会话',
  'cli.session_resumed': '已恢复会话',
  'cli.session_status_active': '活跃',
  'cli.session_status_completed': '已完成',
  'cli.about_title': '关于凌霄',
  'cli.about_version': '版本',
  'cli.about_footer': '更多信息请访问项目文档。',
  'cli.about_author_title': '作者',
  'cli.about_author_body': 'LingXiao Community',
  'cli.about_license_title': '许可证',
  'cli.about_license_body': 'ISC License',
  'cli.about_tech_title': '技术特性',
  'cli.about_tech_dynamic': '• 动态智能编排',
  'cli.about_tech_session': '• 会话状态持久化',
  'cli.about_tech_skills': '• 技能插件系统',
  'cli.about_tech_typesafe': '• TypeScript 类型安全',
  'cli.about_tech_permission': '• 沙盒权限控制',
  'cli.about_vision_title': '愿景',
  'cli.about_vision_body': '打造下一代 AI 智能体编排平台',
};

const enCliStrings: CliStrings = {
  'cli.welcome': 'LingXiao - Dynamic Intelligent Orchestration System',
  'cli.init_detect_no_config': 'No configuration detected. Starting first-time setup...',
  'cli.provider_prompt': 'Select Provider type:',
  'cli.provider_option_openai': '  1. OpenAI format (OpenAI, SiliconFlow, DeepSeek, Tongyi, etc.)',
  'cli.provider_option_anthropic': '  2. Anthropic format (Claude API)',
  'cli.provider_option_auto': '  3. Auto-detect',
  'cli.provider_choice_prompt': 'Enter choice (default 3):',
  'cli.auto_detect_config': 'Auto-detect mode',
  'cli.auto_detect_hint': 'Enter API Key and Base URL, the system will auto-detect Provider type.',
  'cli.api_key_prompt': 'API Key:',
  'cli.base_url_prompt': 'Base URL:',
  'cli.detected_provider': 'Detected Provider:',
  'cli.config_saved': 'Configuration saved to',
  'cli.config_save_failed': 'Failed to save configuration:',
  'cli.check_permissions_hint': 'Please check write permissions:',
  'cli.current_config': 'Current configuration:',
  'cli.command_start': 'Start a LingXiao session',
  'cli.command_init': 'Initialize configuration',
  'cli.command_list': 'List active sessions',
  'cli.command_demo': 'Demo mode',
  'cli.command_doctor': 'Diagnose system status',
  'cli.command_about': 'About LingXiao',
  'cli.session_not_found': 'Session not found:',
  'cli.session_resume_hint': 'Use lingxiao --session <session_id> to resume session',
  'cli.session_resumed': 'Session resumed',
  'cli.session_status_active': 'active',
  'cli.session_status_completed': 'completed',
  'cli.about_title': 'About LingXiao',
  'cli.about_version': 'Version',
  'cli.about_footer': 'For more info, visit the project docs.',
  'cli.about_author_title': 'Author',
  'cli.about_author_body': 'LingXiao Community',
  'cli.about_license_title': 'License',
  'cli.about_license_body': 'ISC License',
  'cli.about_tech_title': 'Tech Features',
  'cli.about_tech_dynamic': '• Dynamic intelligent orchestration',
  'cli.about_tech_session': '• Persistent session state',
  'cli.about_tech_skills': '• Skill plugin system',
  'cli.about_tech_typesafe': '• TypeScript type safety',
  'cli.about_tech_permission': '• Sandbox permission control',
  'cli.about_vision_title': 'Vision',
  'cli.about_vision_body': 'Build focused AI agent orchestration platform',
};

/**
 * 合并 CLI 字符串到主字符串表
 */
function mergeCliStrings(): void {
  const src = currentLanguage === 'zh' ? zhCliStrings : enCliStrings;
  Object.assign(currentStrings as unknown as Record<string, unknown>, src);
}

let cliStringsMerged = false;

/**
 * 获取翻译字符串 - 自动合并 CLI key 于首次调用
 *
 * 对于参数化的字符串（函数类型），调用时传入参数会自动展开。
 * 对于简单字符串 key，第二个参数被忽略。
 */
export function t<K extends string>(key: K, ...args: unknown[]): string {
  if (!cliStringsMerged) {
    mergeCliStrings();
    cliStringsMerged = true;
  }
  const value = (currentStrings as unknown as Record<string, unknown>)[key];
  if (typeof value === 'function') {
    return (value as (...a: unknown[]) => string)(...args);
  }
  return (value as string) || key;
}

/**
 * 获取数组型文案（如旋转短语列表）。
 * key 不存在或值非数组时返回空数组。
 */
export function getList<K extends string>(key: K): string[] {
  const value = (currentStrings as unknown as Record<string, unknown>)[key];
  return Array.isArray(value) ? (value as string[]) : [];
}

/**
 * 获取 LLM 语言指令
 *
 * 返回一个用于附加到 LLM 提示词的语言指令字符串，
 * 指示模型用当前语言回复。
 */
export function getLlmLanguageDirective(): string {
  return sessionLanguage === 'zh'
    ? '\n\n请使用中文回复。保留 XML tags、JSON keys、tool names、enum values、Context Manifest、graph_contract、lingxiao_completion 等机器协议字段的英文原文，不要翻译这些协议标识。'
    : '\n\nPlease respond in English. Preserve machine protocol identifiers exactly as written, including XML tags, JSON keys, tool names, enum values, Context Manifest, graph_contract, and lingxiao_completion.';
}
