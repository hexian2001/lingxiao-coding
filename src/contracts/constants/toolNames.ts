export const OFFICE_TOOL_NAMES = [
  'generate_html_presentation',
  'generate_html_document',
  'generate_slidev',
  'generate_pptx',
  'edit_pptx',
  'inspect_pptx',
  'generate_docx',
  'edit_docx',
  'inspect_docx',
  'generate_xlsx',
  'edit_xlsx',
  'generate_pdf',
  'generate_canvas',
  'office_ops',
  'parse_file',
] as const;

export type OfficeToolName = typeof OFFICE_TOOL_NAMES[number];

export const BUGHUNT_TOOL_NAMES = [
  'set_bughunt_dag',
  'upsert_bughunt_finding',
  'get_bughunt_ledger',
  'get_ready_dag_nodes',
  'verify_finding',
] as const;

export const BUGHUNT_SCAN_TOOL_NAMES = ['bughunt_full_scan'] as const;

export const BUGHUNT_MODE_TOOL_NAMES = [
  ...BUGHUNT_TOOL_NAMES,
  ...BUGHUNT_SCAN_TOOL_NAMES,
] as const;

export const WORKFLOW_TOOL_NAMES = ['workflow'] as const;

const OFFICE_TOOL_NAME_SET: ReadonlySet<string> = new Set(OFFICE_TOOL_NAMES);

export function isOfficeToolName(name: string): name is OfficeToolName {
  return OFFICE_TOOL_NAME_SET.has(name);
}

