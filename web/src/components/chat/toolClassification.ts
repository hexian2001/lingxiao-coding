import { TOOL_METADATA, type ToolMetadata } from '@contracts/types/ToolMetadata';

export type ToolUiKind = 'orchestration' | 'shell' | 'search' | 'read' | 'file_create' | 'file_edit' | 'generic';

export interface ToolClassificationContext {
  input?: unknown;
  result?: unknown;
  content?: unknown;
  metadata?: unknown;
}

export interface ToolClassification {
  name: string;
  kind: ToolUiKind;
}

const EXACT_TOOL_KINDS: ReadonlyMap<string, ToolUiKind> = new Map([
  ['create_task', 'orchestration'],
  ['update_task', 'orchestration'],
  ['delete_task', 'orchestration'],
  ['dispatch_agent', 'orchestration'],
  ['define_agent_role', 'orchestration'],
  ['list_available_roles', 'orchestration'],
  ['team_manage', 'orchestration'],
  ['team_message', 'orchestration'],
  ['team_inbox', 'orchestration'],
  ['send_message_to_agent', 'orchestration'],
  ['send_message', 'orchestration'],
  ['write_work_note', 'orchestration'],
  ['read_work_notes', 'orchestration'],
  ['request_work_note', 'orchestration'],
  ['update_task_status', 'orchestration'],
  ['force_complete_task', 'orchestration'],
  ['retry_agent_llm', 'orchestration'],
  ['nudge_agent', 'orchestration'],
  ['compact_agent_context', 'orchestration'],
  ['pause_agent', 'orchestration'],
  ['resume_agent', 'orchestration'],
  ['intervene_agent', 'orchestration'],
  ['terminate_agent', 'orchestration'],
  ['confirm_intervention', 'orchestration'],
  ['check_agent_progress', 'orchestration'],
  ['ask_user', 'orchestration'],
  ['submit_plan', 'orchestration'],
  ['finish_session', 'orchestration'],
  ['workflow', 'orchestration'],
  ['blackboard', 'orchestration'],
  ['set_bughunt_dag', 'orchestration'],
  ['upsert_bughunt_finding', 'orchestration'],
  ['request_permission_update', 'orchestration'],

  ['shell', 'shell'],
  ['bash', 'shell'],
  ['exec', 'shell'],
  ['exec_command', 'shell'],
  ['python_exec', 'shell'],
  ['node_repl', 'shell'],
  ['get_terminal_output', 'shell'],
  ['terminal_control', 'shell'],
  ['git', 'shell'],

  ['glob', 'search'],
  ['code_search', 'search'],
  ['ast_query', 'search'],
  ['file_search', 'search'],
  ['search', 'search'],
  ['rg', 'search'],
  ['grep', 'search'],
  ['find', 'search'],
  ['web_search', 'search'],
  ['web_fetch', 'search'],
  ['http_request', 'search'],
  ['screenshot', 'search'],
  ['visual_contact_sheet', 'search'],
  ['browser_visual_verify', 'search'],
  ['ocr', 'search'],
  ['browser_action', 'search'],
  ['mcp', 'search'],
  ['bughunt_full_scan', 'search'],
  ['bughunt_npm_audit', 'search'],

  ['file_read', 'read'],
  ['read_file', 'read'],
  ['read', 'read'],
  ['list_dir', 'read'],
  ['list_files', 'read'],
  ['ls', 'read'],
  ['parallel_read_batch', 'read'],
  ['session_artifacts', 'read'],
  ['find_tools', 'read'],
  ['tool_preflight', 'read'],
  ['parse_file', 'read'],
  ['inspect_docx', 'read'],
  ['inspect_pptx', 'read'],
  ['create_download_link', 'read'],
  ['get_bughunt_ledger', 'read'],
  ['design_asset', 'read'],

  ['file_create', 'file_create'],
  ['create_file', 'file_create'],
  ['file_write', 'file_create'],
  ['write_file', 'file_create'],
  ['writefile', 'file_create'],
  ['generate_xlsx', 'file_create'],
  ['generate_docx', 'file_create'],
  ['generate_pptx', 'file_create'],
  ['generate_canvas', 'file_create'],
  ['generate_html_presentation', 'file_create'],
  ['generate_slidev', 'file_create'],
  ['generate_pdf', 'file_create'],

  ['structured_patch', 'file_edit'],
  ['apply_patch', 'file_edit'],
  ['patch', 'file_edit'],
  ['patch_file', 'file_edit'],
  ['replace_in_file', 'file_edit'],
  ['edit_file', 'file_edit'],
  ['file_edit', 'file_edit'],
  ['edit_xlsx', 'file_edit'],
  ['edit_docx', 'file_edit'],
  ['edit_pptx', 'file_edit'],
  ['office_ops', 'file_edit'],
]);

const NAMESPACE_PREFIXES = ['functions.', 'tools.', 'web.', 'image_gen.', 'imagegen.'];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function normalizeToolName(tool: string | undefined): string {
  return (tool || '').trim().toLowerCase();
}

function exactKindForName(name: string): ToolUiKind | null {
  const direct = EXACT_TOOL_KINDS.get(name);
  if (direct) return direct;

  for (const prefix of NAMESPACE_PREFIXES) {
    if (name.startsWith(prefix)) {
      return EXACT_TOOL_KINDS.get(name.slice(prefix.length)) ?? null;
    }
  }

  return null;
}

function nestedMetadataRecord(source: unknown, allowDirect: boolean): Record<string, unknown> | null {
  const record = asRecord(source);
  if (!record) return null;
  if (allowDirect && looksLikeMetadata(record)) return record;

  for (const key of ['metadata', 'toolMetadata', 'tool_metadata', 'meta']) {
    const nested = asRecord(record[key]);
    if (nested && looksLikeMetadata(nested)) return nested;
  }

  return null;
}

function eventMetadata(context: ToolClassificationContext): Record<string, unknown> | null {
  return nestedMetadataRecord(context.metadata, true)
    ?? nestedMetadataRecord(context.input, false)
    ?? nestedMetadataRecord(context.result, false)
    ?? nestedMetadataRecord(context.content, false);
}

function looksLikeMetadata(record: Record<string, unknown>): boolean {
  for (const key of ['toolKind', 'tool_kind', 'uiKind', 'ui_kind', 'visualKind', 'visual_kind', 'category', 'toolCategory', 'tool_category', 'tier', 'requiresReadFirst', 'modifiesWorkspace']) {
    if (record[key] !== undefined) return true;
  }
  return false;
}

function stringField(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
  }
  return null;
}

function booleanField(record: Record<string, unknown> | null, keys: string[]): boolean {
  if (!record) return false;
  for (const key of keys) {
    if (record[key] === true) return true;
  }
  return false;
}

function explicitKind(value: string | null): ToolUiKind | null {
  switch (value) {
    case 'orchestration':
    case 'team':
    case 'workflow':
    case 'blackboard':
    case 'communication':
      return 'orchestration';
    case 'shell':
    case 'terminal':
    case 'execution':
    case 'execute':
      return 'shell';
    case 'search':
    case 'network':
    case 'browser':
    case 'security':
      return 'search';
    case 'read':
    case 'file_read':
      return 'read';
    case 'file_create':
    case 'create':
    case 'write':
      return 'file_create';
    case 'file_edit':
    case 'edit':
    case 'patch':
      return 'file_edit';
    case 'generic':
    case 'custom':
      return 'generic';
    default:
      return null;
  }
}

function kindFromToolMetadata(metadata: Record<string, unknown> | ToolMetadata | null | undefined): ToolUiKind | null {
  const record = metadata ? metadata as Record<string, unknown> : null;
  const direct = explicitKind(stringField(record, ['toolKind', 'tool_kind', 'uiKind', 'ui_kind', 'visualKind', 'visual_kind']));
  if (direct) return direct;

  const category = stringField(record, ['category', 'toolCategory', 'tool_category']);
  const tier = stringField(record, ['tier']);
  const requiresReadFirst = booleanField(record, ['requiresReadFirst', 'requires_read_first']);
  const modifiesWorkspace = booleanField(record, ['modifiesWorkspace', 'modifies_workspace']);

  switch (category) {
    case 'team':
    case 'workflow':
    case 'blackboard':
    case 'communication':
      return 'orchestration';
    case 'execution':
    case 'git':
      return 'shell';
    case 'search':
    case 'network':
    case 'browser':
    case 'security':
      return 'search';
    case 'file':
      if (tier === 'write' || modifiesWorkspace) return requiresReadFirst ? 'file_edit' : 'file_create';
      return 'read';
    case 'office':
      if (tier === 'write' || modifiesWorkspace) return requiresReadFirst ? 'file_edit' : 'file_create';
      return 'read';
    case 'session':
      return 'read';
    default:
      return null;
  }
}

function registryMetadata(name: string): ToolMetadata | null {
  const metadata = (TOOL_METADATA as Record<string, ToolMetadata | undefined>)[name];
  if (metadata) return metadata;

  for (const prefix of NAMESPACE_PREFIXES) {
    if (name.startsWith(prefix)) {
      return (TOOL_METADATA as Record<string, ToolMetadata | undefined>)[name.slice(prefix.length)] ?? null;
    }
  }

  return null;
}

export function classifyTool(tool: string | undefined, context: ToolClassificationContext = {}): ToolClassification {
  const name = normalizeToolName(tool);
  const metadata = eventMetadata(context);
  const metadataExplicitKind = kindFromToolMetadata(metadata);
  if (metadataExplicitKind) return { name, kind: metadataExplicitKind };

  const exactKind = exactKindForName(name);
  if (exactKind) return { name, kind: exactKind };

  const registeredKind = kindFromToolMetadata(registryMetadata(name));
  return { name, kind: registeredKind ?? 'generic' };
}
