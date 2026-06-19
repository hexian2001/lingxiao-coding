export type ToolTier = 'read' | 'write' | 'execute' | 'compute';
export type ToolVisibility = 'all' | 'leader' | 'agent';
export type ToolCategory = 'session' | 'file' | 'search' | 'network' | 'browser' | 'execution' | 'communication' | 'team' | 'workflow' | 'blackboard' | 'office' | 'security' | 'memory' | 'git' | 'completion' | 'custom';

export interface ToolMetadata {
  tier?: ToolTier;
  visibility?: ToolVisibility;
  category?: ToolCategory | string;
  core?: boolean;
  hidden?: boolean;
  deprecated?: boolean;
  parallelSafe?: boolean;
  leaderParallelSafe?: boolean;
  modifiesWorkspace?: boolean;
  requiresReadFirst?: boolean;
  dangerous?: boolean;
  readOnly?: boolean;
  requiresNetwork?: boolean;
  privileged?: boolean;
  nextToolHints?: string[];
  resultShape?: 'text' | 'json' | 'file' | 'browser_snapshot' | 'task_handle';
}

const read = (category: ToolCategory, extra: ToolMetadata = {}): ToolMetadata => ({ tier: 'read', category, readOnly: true, resultShape: 'json', ...extra });
const compute = (category: ToolCategory, extra: ToolMetadata = {}): ToolMetadata => ({ tier: 'compute', category, readOnly: true, resultShape: 'text', ...extra });
const write = (category: ToolCategory, extra: ToolMetadata = {}): ToolMetadata => ({ tier: 'write', category, modifiesWorkspace: true, resultShape: 'text', ...extra });
const execute = (category: ToolCategory, extra: ToolMetadata = {}): ToolMetadata => ({ tier: 'execute', category, dangerous: true, resultShape: 'text', ...extra });

export const TOOL_METADATA: Readonly<Record<string, ToolMetadata>> = Object.freeze({
  // Session / coordination

  session_artifacts: read('session', { core: true, parallelSafe: true, leaderParallelSafe: true }),
  find_tools: read('session', { core: true, parallelSafe: true, leaderParallelSafe: true }),
  tool_preflight: read('session', { core: true, parallelSafe: true, leaderParallelSafe: true }),
  parallel_read_batch: read('session', { core: true, parallelSafe: true, leaderParallelSafe: true }),
  send_message: read('communication', { core: true }),
  attempt_completion: read('completion', { core: true, resultShape: 'text' }),
  declare_assumption: read('communication', { core: true, resultShape: 'json' }),

  // Files / local search
  file_read: read('file', { core: true, parallelSafe: true, leaderParallelSafe: true, resultShape: 'text' }),
  list_dir: read('file', { core: true, parallelSafe: true, leaderParallelSafe: true }),
  glob: read('search', { core: true, parallelSafe: true, leaderParallelSafe: true, resultShape: 'text' }),
  code_search: read('search', { core: true, parallelSafe: true, leaderParallelSafe: true, resultShape: 'json' }),
  ast_query: read('search', { core: true, parallelSafe: true, leaderParallelSafe: true, resultShape: 'json' }),
  structured_patch: write('file', { core: true, requiresReadFirst: true, resultShape: 'json' }),
  file_create: write('file', { core: true, requiresReadFirst: true }),
  parse_file: read('office', { resultShape: 'text' }),

  // Execution / terminal
  shell: execute('execution', { core: true, resultShape: 'task_handle', nextToolHints: ['get_terminal_output'], privileged: true }),
  python_exec: execute('execution', { privileged: true }),
  get_terminal_output: read('execution', { resultShape: 'text' }),
  terminal_control: execute('execution', { resultShape: 'json', privileged: true }),

  // Network / browser
  http_request: execute('network', { requiresNetwork: true, privileged: true, resultShape: 'text' }),
  web_fetch: compute('network', { requiresNetwork: true, leaderParallelSafe: true, resultShape: 'text' }),
  web_search: compute('network', { requiresNetwork: true, leaderParallelSafe: true, resultShape: 'text' }),
  screenshot: compute('browser', { privileged: true, resultShape: 'file' }),
  visual_contact_sheet: compute('browser', { privileged: true, resultShape: 'file' }),
  browser_visual_verify: compute('browser', { privileged: true, resultShape: 'file' }),
  ocr: compute('browser', { privileged: true, resultShape: 'text' }),
  browser_action: execute('browser', { dangerous: false, privileged: true, resultShape: 'browser_snapshot' }),
  mcp: execute('network', { dangerous: false, requiresNetwork: true, privileged: true, resultShape: 'json' }),
  node_repl: execute('execution', { privileged: true, dangerous: true, resultShape: 'json' }),

  // Memory / work notes — memory_read/write split (P0-1c)
  memory: write('memory', { dangerous: false, privileged: true, resultShape: 'text' }),
  memory_read: read('memory', { dangerous: false, privileged: true, resultShape: 'text' }),
  memory_write: write('memory', { dangerous: false, privileged: true, resultShape: 'text' }),
  write_work_note: read('communication', { resultShape: 'text' }),
  read_work_notes: read('communication', { resultShape: 'text' }),
  request_work_note: read('communication', { resultShape: 'text' }),

  // Team
  team_manage: write('team', { dangerous: false, resultShape: 'json' }),
  team_message: read('team', { resultShape: 'json' }),
  team_inbox: read('team', { resultShape: 'json' }),

  // Workflow
  workflow: write('workflow', { dangerous: false, resultShape: 'json' }),

  // Blackboard
  blackboard: write('blackboard', { dangerous: false, resultShape: 'json' }),

  // Office / artifacts
  generate_xlsx: write('office', { resultShape: 'file' }),
  edit_xlsx: write('office', { requiresReadFirst: true, resultShape: 'file' }),
  generate_docx: write('office', { resultShape: 'file' }),
  edit_docx: write('office', { requiresReadFirst: true, resultShape: 'file' }),
  inspect_docx: read('office', { resultShape: 'json' }),
  generate_pptx: write('office', { resultShape: 'file' }),
  edit_pptx: write('office', { requiresReadFirst: true, resultShape: 'file' }),
  inspect_pptx: read('office', { resultShape: 'json' }),
  office_ops: write('office', { dangerous: false, resultShape: 'json' }),
  generate_canvas: write('office', { resultShape: 'file' }),
  generate_html_presentation: write('office', { resultShape: 'file' }),
  generate_html_document: write('office', { resultShape: 'file' }),
  generate_slidev: write('office', { resultShape: 'file' }),
  generate_pdf: write('office', { resultShape: 'file' }),

  // Design asset library
  design_asset: read('session', { core: true, parallelSafe: true, resultShape: 'json' }),

  // Security scans (consolidated: bughunt_full_scan covers all sub-scanners via skip* params)
  bughunt_full_scan: compute('security', { requiresNetwork: true, resultShape: 'json' }),

  // Git
  git: execute('git', { privileged: true, resultShape: 'text' }),

  // Leader-only meta tools (not ToolRegistry tools, but governed by same metadata map)
  create_task: write('workflow', { visibility: 'leader', leaderParallelSafe: true, dangerous: false, resultShape: 'json' }),
  define_project_blueprint: write('workflow', { visibility: 'leader', leaderParallelSafe: true, dangerous: false, resultShape: 'json' }),
  update_task: write('workflow', { visibility: 'leader', dangerous: false, resultShape: 'json' }),
  delete_task: write('workflow', { visibility: 'leader', dangerous: false, resultShape: 'json' }),
  define_agent_role: write('team', { visibility: 'leader', dangerous: false, resultShape: 'json' }),
  list_available_roles: read('team', { visibility: 'leader' }),
  dispatch_agent: write('team', { visibility: 'leader', dangerous: false, resultShape: 'json' }),
  dispatch_batch: write('team', { visibility: 'leader', dangerous: false, resultShape: 'json' }),
  explore: write('team', { visibility: 'leader', dangerous: false, resultShape: 'json' }),
  send_message_to_agent: read('communication', { visibility: 'leader', resultShape: 'json' }),
  update_task_status: write('workflow', { visibility: 'leader', dangerous: false, resultShape: 'json' }),
  force_complete_task: write('team', { visibility: 'leader', dangerous: true, resultShape: 'json' }),
  retry_agent_llm: write('team', { visibility: 'leader', dangerous: false, resultShape: 'json' }),

  nudge_agent: read('communication', { visibility: 'leader', resultShape: 'json' }),
  compact_agent_context: write('team', { visibility: 'leader', dangerous: false, resultShape: 'json' }),
  pause_agent: write('team', { visibility: 'leader', dangerous: false, resultShape: 'json' }),
  resume_agent: write('team', { visibility: 'leader', dangerous: false, resultShape: 'json' }),
  intervene_agent: read('communication', { visibility: 'leader', resultShape: 'json' }),
  terminate_agent: write('team', { visibility: 'leader', dangerous: true, resultShape: 'json' }),
  confirm_intervention: read('team', { visibility: 'leader' }),
  check_agent_progress: read('team', { visibility: 'leader' }),
  ask_user: read('communication', { visibility: 'leader', resultShape: 'json' }),
  submit_plan: read('communication', { visibility: 'leader', resultShape: 'json' }),
  plan_create: write('session', { visibility: 'leader', dangerous: false, resultShape: 'json' }),
  plan_update: write('session', { visibility: 'leader', dangerous: false, resultShape: 'json' }),
  plan_checkpoint: write('session', { visibility: 'leader', dangerous: false, resultShape: 'json' }),
  plan_finalize: write('session', { visibility: 'leader', dangerous: false, resultShape: 'json' }),
  finish_session: write('session', { visibility: 'leader', dangerous: false, resultShape: 'json' }),
  complete_eternal_goal: write('session', { visibility: 'leader', dangerous: false, resultShape: 'json' }),
  learn_soul: write('memory', { visibility: 'leader', dangerous: false, resultShape: 'json' }),
  request_permission_update: write('session', { visibility: 'leader', dangerous: false, resultShape: 'json' }),
  create_download_link: read('file', { visibility: 'leader', resultShape: 'json' }),
  set_bughunt_dag: write('security', { visibility: 'leader', dangerous: false, resultShape: 'json' }),
  upsert_bughunt_finding: write('security', { visibility: 'leader', dangerous: false, resultShape: 'json' }),
  get_bughunt_ledger: read('security', { visibility: 'leader' }),
  get_ready_dag_nodes: read('security', { visibility: 'leader' }),
  verify_finding: write('security', { visibility: 'leader', dangerous: true, resultShape: 'json' }),
});

export function getToolMetadata(name: string): ToolMetadata {
  return TOOL_METADATA[name] ?? {};
}

export function getToolCapabilityTier(name: string): ToolTier | null {
  return getToolMetadata(name).tier ?? null;
}

export function isParallelSafeTool(name: string, scope: 'base' | 'leader' = 'base'): boolean {
  const meta = getToolMetadata(name);
  return scope === 'leader' ? Boolean(meta.parallelSafe || meta.leaderParallelSafe) : Boolean(meta.parallelSafe);
}

export function isWorkspaceModifyingTool(name: string): boolean {
  return Boolean(getToolMetadata(name).modifiesWorkspace);
}

export function requiresReadFirst(name: string): boolean {
  return Boolean(getToolMetadata(name).requiresReadFirst);
}

export function isNetworkToolByMetadata(name: string): boolean {
  return Boolean(getToolMetadata(name).requiresNetwork);
}

export function isPrivilegedToolByMetadata(name: string): boolean {
  const meta = getToolMetadata(name);
  return Boolean(meta.privileged || meta.dangerous || meta.modifiesWorkspace || meta.requiresNetwork);
}

export function isAlwaysAllowedToolByMetadata(name: string): boolean {
  const meta = getToolMetadata(name);
  return Boolean(meta.readOnly && !meta.requiresNetwork && !meta.privileged && !meta.dangerous);
}

export function metadataSet(predicate: (meta: ToolMetadata, name: string) => boolean): ReadonlySet<string> {
  return new Set(Object.entries(TOOL_METADATA).filter(([name, meta]) => predicate(meta, name)).map(([name]) => name));
}

export const BASE_PARALLEL_SAFE_TOOLS: ReadonlySet<string> = metadataSet((meta) => Boolean(meta.parallelSafe));
export const LEADER_PARALLEL_SAFE_TOOLS: ReadonlySet<string> = metadataSet((meta) => Boolean(meta.parallelSafe || meta.leaderParallelSafe));
export const FILE_MODIFYING_TOOLS: ReadonlySet<string> = metadataSet((meta) => Boolean(meta.modifiesWorkspace));
