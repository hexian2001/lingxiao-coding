export const OFFICE_TOOL_NAMES = [
  // Office 模式对 agent 暴露的工具：验收/运维（office_ops）与文件解析（parse_file）。
  // 产物生成走 shell + pptxgenjs/docx/exceljs/pdfkit（见 OfficeModeProtocol）。
  // Web HTTP /api/v1/office/generate 另有独立后端实现，不经本列表。
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

