import type { BughuntEvidenceEvent, BughuntEvidenceKind } from './BughuntLedger.js';
import { DEFAULT_BUGHUNT_POLICY, type BughuntPolicy } from './BughuntPolicy.js';

export interface ExtractBughuntEvidenceInput {
  taskId: string;
  status: 'completed' | 'failed';
  result: string;
  agentName?: string;
}

const FINDING_RE = /\b(?:F|BH|BUG|VULN|Finding)[-_ ]?\d+\b/gi;
const EXIT_RE = /\b(?:exit(?:\s+code)?|退出码)\s*[:=]?\s*(-?\d+)\b/gi;

export function extractBughuntEvidenceEvent(
  input: ExtractBughuntEvidenceInput,
  policy: BughuntPolicy = DEFAULT_BUGHUNT_POLICY,
): Omit<BughuntEvidenceEvent, 'id' | 'created_at'> | null {
  if (policy.eventCapture === 'off') return null;

  const text = input.result || '';
  const findingIds = unique((text.match(FINDING_RE) || []).map(normalizeFindingId));
  const files = unique([...text.matchAll(buildFileRegex(policy))].map((match) => match[1]).filter(Boolean) as string[]);
  const commands = unique([...text.matchAll(buildCommandRegex(policy))].map((match) => cleanupCommand(match[1] || '')).filter(Boolean));
  const exitCodes = unique([...text.matchAll(EXIT_RE)].map((match) => match[1]).filter(Boolean) as string[]);
  const evidence = extractEvidenceLines(text, policy);

  if (findingIds.length === 0 && commands.length === 0 && evidence.length === 0) {
    return null;
  }

  return {
    kind: classifyEvidenceKind(text, commands),
    summary: buildSummary(input, findingIds, commands, evidence),
    finding_ids: findingIds,
    task_id: input.taskId,
    agent_name: input.agentName,
    files,
    commands,
    exit_codes: exitCodes,
    evidence,
  };
}

function classifyEvidenceKind(text: string, commands: string[]): BughuntEvidenceKind {
  if (/\b(?:scan_result|bughunt_scan_result|semgrep|npm audit|js-x-ray|ast-grep|sast)\b|扫描|审计扫描/i.test(text)) {
    return 'scan_result';
  }
  if (/\b(?:instrument|instrumentation|trace|probe|hook|repro_artifact|whitebox_artifact)\b|插桩|白盒|探针|复现产物/i.test(text)) {
    return 'instrumentation';
  }
  if (/\b(?:blackbox|curl|http request|response status|returned \d{3}|status \d{3})\b|黑盒|外部验证|响应状态/i.test(text) ||
      commands.some((command) => /^(?:curl|http|wget)\b/i.test(command))) {
    return 'blackbox_probe';
  }
  if (/\b(?:compile|build|test|tsc|vitest|jest|pytest|cargo test|go test|npm test|npm run build)\b|编译|构建|测试/i.test(text) ||
      commands.some((command) => /^(?:npm|pnpm|yarn|npx|tsc|vitest|jest|pytest|cargo|go test)\b/i.test(command))) {
    return 'compile';
  }
  return 'worker_result';
}

function extractEvidenceLines(text: string, policy: BughuntPolicy): string[] {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const selected = lines.filter((line) => policy.evidenceSignals.some((signal) => signal.pattern.test(line)));
  return unique(selected).slice(0, policy.maxEventItems);
}

function buildSummary(
  input: ExtractBughuntEvidenceInput,
  findingIds: string[],
  commands: string[],
  evidence: string[],
): string {
  const parts = [`Task ${input.taskId} ${input.status}`];
  if (input.agentName) parts.push(`by @${input.agentName}`);
  if (findingIds.length > 0) parts.push(`findings=${findingIds.join(',')}`);
  if (commands.length > 0) parts.push(`commands=${commands.slice(0, 2).join(' | ')}`);
  if (evidence.length > 0) parts.push(`evidence=${evidence[0]}`);
  return parts.join('; ');
}

function buildCommandRegex(policy: BughuntPolicy): RegExp {
  const alternatives = policy.commandPrefixes.map(escapeRegex).join('|');
  return new RegExp(`(?:^|\\n)\\s*(?:[$>]\\s*)?((${alternatives})\\b[^\\n]{0,${policy.maxCommandChars}})`, 'g');
}

function buildFileRegex(policy: BughuntPolicy): RegExp {
  const alternatives = policy.sourcePathPrefixes.map(escapeRegex).join('|');
  return new RegExp(`(?:^|[\\s\`'"(])((${alternatives})\\/[\\w./-]+\\.[\\w-]+)(?=$|[\\s\`'"),:])`, 'gm');
}

function cleanupCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim().replace(/[.;,]+$/, '');
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeFindingId(value: string): string {
  return value.trim().replace(/\s+/g, '-').replace(/_/g, '-');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
