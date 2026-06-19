/**
 * Session state key constants
 *
 * All string keys used with db.getSessionState() / db.setSessionState()
 * are centralized here to prevent typos and duplication.
 */
export const SESSION_KEYS = {
  /** Whether the leader is waiting for user input ('true' | 'false') */
  LEADER_WAITING_FOR_USER: 'leader_waiting_for_user',
  /** Pending plan review flag */
  LEADER_PENDING_REVIEW: 'leader_pending_review',
  /** Whether the plan has been approved */
  LEADER_PLAN_APPROVED: 'leader_plan_approved',
  /** Current leader execution mode */
  LEADER_EXECUTION_MODE: 'leader_execution_mode',
  /** Reason for the current execution mode */
  LEADER_EXECUTION_REASON: 'leader_execution_reason',
  /** Serialized ToolPermissionContext */
  TOOL_PERMISSION_CONTEXT: 'tool_permission_context',
  /** Serialized PermissionRequestPayload when awaiting user approval */
  PENDING_PERMISSION_REQUEST: 'pending_permission_request',
  /** Session collaboration mode ('solo' | 'team') */
  COLLABORATION_MODE: 'collaboration_mode',
  /** User/session route preference override ('auto' | 'direct' | 'hybrid' | 'delegate') */
  EXECUTION_ROUTE_OVERRIDE: 'execution_route_override',
  /** Active Leader/session progress plan (separate from PENDING_PLAN approval gate) */
  ACTIVE_PLAN: 'active_plan',
  /** Structured permission audit records for bypass/auto-approval decisions */
  PERMISSION_AUDIT_LOG: 'permission_audit_log',
  /** Kind of pending user input (message, plan_review, permission_request, etc.) */
  PENDING_USER_INPUT: 'pending_user_input',
  /** Structured user gate currently blocking or idling the leader */
  PENDING_USER_GATE: 'pending_user_gate',
  /** Custom role definitions */
  CUSTOM_ROLES: 'custom_roles',
  /** Leader route history */
  LEADER_ROUTE_HISTORY: 'leader_route_history',
  /** Leader selected skills history */
  LEADER_SELECTED_SKILLS_HISTORY: 'leader_selected_skills_history',
  /** Latest invisible understanding snapshot for this session */
  INTUITION_SNAPSHOT: 'intuition_snapshot',
  /** Active Bughunt DAG and finding ledger */
  BUGHUNT_LEDGER: 'bughunt_ledger',
  /**
   * Leader context summary — plaintext extracted from the latest compression summary message.
   * Written by ContextManager after each successful LLM compression.
   * Read by AgentPool when building WorkerTaskPayload to give workers leader context.
   */
  LEADER_CONTEXT_SUMMARY: 'leader_context_summary',
  /** Current model ID for this session (written by LeaderAgent.setModel) */
  CURRENT_MODEL: 'current_model',
  /** Active team name (set by Leader when calling team_manage(action="create")) */
  LEADER_ACTIVE_TEAM: 'leader_active_team',
  /** Bughunt mode flag ('true' | 'false') */
  BUGHUNT_MODE_ACTIVE: 'bughunt_mode_active',
  /** Office mode flag ('true' | 'false') */
  OFFICE_MODE_ACTIVE: 'office_mode_active',
  /** Workflow mode flag ('true' | 'false') — 控制 workflow_* 工具是否注入到 Leader/Worker */
  WORKFLOW_MODE_ACTIVE: 'workflow_mode_active',
  /** Pending plan content awaiting user approval */
  PENDING_PLAN: 'pending_plan',
  /** Latest scratchpad review digest fingerprint (Leader only) */
  LEADER_LAST_SCRATCHPAD_REVIEW_DIGEST: 'leader_last_scratchpad_review_digest',
  /** EternalLoop patrol interval (ms) */
  ETERNAL_PATROL_INTERVAL: 'eternal_patrol_interval',
  /** EternalLoop consecutive idle patrol count */
  ETERNAL_IDLE_PATROL_COUNT: 'eternal_idle_patrol_count',
  /** EternalLoop last patrol timestamp (epoch ms) */
  ETERNAL_LAST_PATROL_AT: 'eternal_last_patrol_at',
  /** EternalLoop current hourly token window usage */
  ETERNAL_WINDOW_TOKENS: 'eternal_window_tokens',
  /** EternalLoop configured hourly token budget */
  ETERNAL_TOKEN_BUDGET_PER_HOUR: 'eternal_token_budget_per_hour',
  /** EternalLoop current token window start timestamp (epoch ms) */
  ETERNAL_WINDOW_START_MS: 'eternal_window_start_ms',
  /** EternalLoop consecutive API failure count */
  ETERNAL_API_FAILURE_COUNT: 'eternal_api_failure_count',
  /** EternalLoop circuit breaker open-until timestamp (epoch ms) */
  ETERNAL_CIRCUIT_OPEN_UNTIL: 'eternal_circuit_open_until',
  /** EternalLoop total patrol count */
  ETERNAL_TOTAL_PATROLS: 'eternal_total_patrols',
  /** EternalLoop silence lock flag */
  ETERNAL_SILENCE_LOCK_ENGAGED: 'eternal_silence_lock_engaged',
  /** EternalLoop last patrol outcome */
  ETERNAL_LAST_PATROL_OUTCOME: 'eternal_last_patrol_outcome',
  /** EternalLoop worker completion count used in fingerprint */
  ETERNAL_WORKER_COMPLETION_COUNT: 'eternal_worker_completion_count',
  /** EternalLoop last real project fingerprint */
  ETERNAL_LAST_FINGERPRINT: 'eternal_last_fingerprint',
  /** User-directed persistent Eternal goal */
  ETERNAL_GOAL: 'eternal_goal',
  /** Current Leader autonomy control mode ('manual' | 'eternal') */
  CONTROL_MODE: 'control_mode',
  /** Metadata for side conversations linked to a parent thread */
  SIDE_THREAD_META: 'side_thread:meta',
  /** Global web channel records */
  GLOBAL_CHANNELS: 'global:channels',
  /** Fork metadata: parent session ID and fork point */
  FORK_PARENT_SESSION_ID: 'fork:parent_session',
  /** Active project blueprint (project_type + standard subsystems + coverage taskIds) — serialized ProjectBlueprint JSON */
  PROJECT_BLUEPRINT: 'project_blueprint',
} as const;

/** All known session_state key prefixes for namespace validation */
export const SESSION_KEY_PREFIXES = [
  'leader_',
  'intuition_',
  'tool_',
  'pending_',
  'collaboration_',  // written by mode split collaboration controls
  'execution_route_', // written by route preference controls
  'active_plan',     // written by Active Plan tools
  'custom_',
  'runtime_recovery:', // written by RecoveryRecords
  'context_runtime:',  // written by ContextRuntimeState
  'agent_checkpoint:', // written by ResumeManager
  'bughunt_',
  'eternal_',          // written by EternalLoop
  'orchestration_runtime:', // written by OrchestrationRuntime
  'current_model',     // written by LeaderAgent.setModel()
  'control_mode',      // written by LeaderAgent.setControlMode()
  'side_thread:',      // written by SessionRoutes side-thread creation
  'global:',           // global pseudo-session state
  'config:',           // web/ACP session config options
  'office_',           // office mode flags
  'workflow_',         // workflow mode flag
  'findings',          // shared findings list
  'running',           // approval/runtime marker
  'fork:',             // fork metadata
  'project_blueprint', // written by define_project_blueprint
] as const;
