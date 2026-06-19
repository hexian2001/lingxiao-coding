/**
 * BughuntScanToolWrappers — 把 BughuntScanTools 的 runner 函数
 * 封装成可注册到 ToolRegistry 的普通 Tool。
 *
 * 之前这些工具走 LeaderTools 大 switch 内部 handler；改为统一通过
 * directToolsExecutor → ToolRegistry 调用，让 LeaderTools 仅承担带 Leader 状
 * 态副作用（setActiveTeam 等）的元工具，scan 类纯计算工具回归普通 tool。
 *
 * 合并说明：原文件暴露 4 个 Tool 类（full/semgrep/tsc/npm_audit），但其中
 * semgrep/tsc/npm_audit 三个子扫描器从未注册到 registry、无任何测试、且
 * bughunt_full_scan 已通过 skipSemgrep/skipTsc/skipNpmAudit 参数完整覆盖它们。
 * 真正语义重叠 → 已删除三个死代码子类，仅保留 full 统一入口。runner 函数
 * 仍由 BughuntScanTools.ts 导出供 runFullScan 内部调用。
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import {
  runFullScan,
  type ScanFinding,
  type ScanResult,
} from './BughuntScanTools.js';
import { ensureModeWorktree } from '../../core/ModeWorktreeService.js';
import { runTaintScan } from './BughuntTaintScanner.js';
import type { TaintFinding } from '../../core/TaintFlowEngine.js';
import { getRulePack } from './rules/RuleLoader.js';

type SuggestedFindingStatus = 'hypothesis' | 'likely';

interface SuggestedBughuntFinding {
  id: string;
  title: string;
  severity: ScanFinding['severity'];
  status: SuggestedFindingStatus;
  files: string[];
  cwe?: string;
  owasp?: string;
  source?: string;
  sink?: string;
  trigger?: string;
  exploitability: 'possible' | 'unknown';
  evidence: string[];
  evidence_gap: string[];
  whitebox_artifacts: string[];
  instrumentation_artifacts: string[];
  compile_commands: string[];
  compile_artifacts: string[];
  blackbox_commands: string[];
  blackbox_artifacts: string[];
  fix_files: string[];
  linked_tasks: string[];
  /** 自动推导的数据流路径（来自 TaintFlowEngine；纯 scan 候选为空）。 */
  taint_path?: string[];
}

interface BughuntScanPayload {
  kind: 'bughunt_scan_result';
  target: string;
  summary: string;
  totals: {
    tools: number;
    successful_tools: number;
    failed_tools: number;
    findings: number;
    high_or_critical: number;
    suggested_findings: number;
  };
  results: Array<{
    tool: string;
    success: boolean;
    summary: string;
    findings: ScanFinding[];
    error?: string;
    exitCode?: number | string;
  }>;
  suggested_findings: SuggestedBughuntFinding[];
  ledger_instruction: string;
  next_gates: string[];
}

function buildScanPayload(target: string, results: ScanResult[], title: string, taintFindings: readonly TaintFinding[] = []): BughuntScanPayload {
  const successful = results.filter((result) => result.success).length;
  const failed = results.length - successful;
  const findings = results.flatMap((result) => result.findings.map((finding) => ({ result, finding })));
  const highOrCritical = findings.filter(({ finding }) => finding.severity === 'HIGH' || finding.severity === 'CRITICAL').length;
  const scanSuggested = findings
    .filter(({ finding }) => finding.severity !== 'INFO')
    .slice(0, 50)
    .map(({ result, finding }, index) => toSuggestedFinding(result.tool, finding, index));
  const taintSuggested = taintFindings.slice(0, 50).map((f, index) => toTaintSuggestedFinding(f, index));
  const suggestedFindings = [...scanSuggested, ...taintSuggested];
  const summaries = [
    title,
    ...results.map((result) => result.summary),
    `总计: ${findings.length} 个扫描发现, ${highOrCritical} 个 HIGH/CRITICAL, ${taintFindings.length} 个污点流(TaintFlowEngine 自动 taint_path), ${suggestedFindings.length} 个 ledger 候选。`,
    '扫描只生成 hypothesis/likely；带 taint_path 的污点候选为 likely（已有 source→sink 数据流证据）；confirmed 需要 source+sink/taint/whitebox 证据，verified 需要编译/测试和黑盒输出。',
  ];

  return {
    kind: 'bughunt_scan_result',
    target,
    summary: summaries.join('\n'),
    totals: {
      tools: results.length,
      successful_tools: successful,
      failed_tools: failed,
      findings: findings.length,
      high_or_critical: highOrCritical,
      suggested_findings: suggestedFindings.length,
    },
    results: results.map((result) => ({
      tool: result.tool,
      success: result.success,
      summary: result.summary,
      findings: result.findings,
      error: result.error,
      exitCode: result.exitCode,
    })),
    suggested_findings: suggestedFindings,
    ledger_instruction: '用 upsert_bughunt_finding 记录扫描候选时设置 status=hypothesis 或 likely；confirmed 需要源码 source/sink/taint_path 或 whitebox/repro artifact；verified 需要 compile/test 信号和 blackbox_commands 输出证据。',
    next_gates: [
      '对 HIGH/CRITICAL 候选读取源码，补 source、sink、trust_boundary、taint_path。',
      '为可疑路径设计最小插桩、测试或 repro_artifact，记录 whitebox_artifacts/instrumentation_artifacts。',
      '运行编译/类型检查/测试并记录 compile_commands 或 compile_artifacts。',
      '启动可授权的本地目标后执行 HTTP/CLI 黑盒探测，记录 blackbox_commands 和输出证据。',
    ],
  };
}

function toSuggestedFinding(tool: string, finding: ScanFinding, index: number): SuggestedBughuntFinding {
  const status: SuggestedFindingStatus = finding.severity === 'CRITICAL' || finding.severity === 'HIGH' ? 'likely' : 'hypothesis';
  const location = `${finding.file}${finding.line ? `:${finding.line}` : ''}`;
  const ruleTitle = finding.rule.replace(/[._-]+/g, ' ').trim() || 'security finding';
  const title = `${ruleTitle}: ${finding.message}`.slice(0, 180);
  return {
    id: `SCAN-${sanitizeId(tool)}-${finding.id || index + 1}`,
    title,
    severity: finding.severity,
    status,
    files: finding.file ? [finding.file] : [],
    cwe: finding.cwe,
    owasp: finding.owasp,
    source: inferSource(finding),
    sink: inferSink(finding),
    trigger: `${tool}/${finding.rule} at ${location}`,
    exploitability: status === 'likely' ? 'possible' : 'unknown',
    evidence: [`scan_result ${tool}/${finding.rule}: ${finding.message} (${location})${finding.code ? ` code=${finding.code.slice(0, 160)}` : ''}`],
    evidence_gap: [
      'read source and identify trust boundary, source, sink, and taint path',
      'create minimal whitebox repro or instrumentation artifact',
      'run compile/test command and authorized blackbox verification before verified',
    ],
    whitebox_artifacts: [],
    instrumentation_artifacts: [],
    compile_commands: [],
    compile_artifacts: [],
    blackbox_commands: [],
    blackbox_artifacts: [],
    fix_files: [],
    linked_tasks: [],
  };
}

function inferSource(finding: ScanFinding): string | undefined {
  const text = `${finding.message} ${finding.code || ''}`;
  const source = text.match(/\b(req\.(?:body|query|params|headers)|params|args|input|user|query|body|argv|process\.env)\b/i)?.[0];
  return source;
}

function inferSink(finding: ScanFinding): string | undefined {
  const text = `${finding.rule} ${finding.message} ${finding.code || ''}`;
  const sink = text.match(/\b(execSync|exec|spawn|query|execute|raw|innerHTML|dangerouslySetInnerHTML|eval|Function|readFile|writeFile|createReadStream|fetch|axios|request)\b/i)?.[0];
  return sink;
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toUpperCase().slice(0, 40) || 'TOOL';
}

/** TaintFlowEngine 的污点流 → ledger 候选（带自动 taint_path，status=likely）。 */
function toTaintSuggestedFinding(f: TaintFinding, index: number): SuggestedBughuntFinding {
  const fileId = sanitizeId(f.file);
  return {
    id: `TAINT-${fileId}-${f.line}-${index + 1}`.slice(0, 80),
    title: `Taint flow: ${f.source} → ${f.sink}${f.cwe ? ` (${f.cwe})` : ''}`.slice(0, 180),
    severity: f.severity,
    status: 'likely',
    files: f.file ? [f.file] : [],
    cwe: f.cwe,
    source: f.source,
    sink: f.sink,
    trigger: `${f.sink} at ${f.file}:${f.line}`,
    exploitability: 'possible',
    evidence: [`taint_flow ${f.source} -> ${f.sink}: ${f.taint_path.join(' -> ')}`],
    evidence_gap: [
      '确认数据流可达性（读取源码核对路径节点）',
      '运行编译/测试记录 compile 信号',
      '授权后执行黑盒探测验证可利用性',
    ],
    whitebox_artifacts: [],
    instrumentation_artifacts: [],
    compile_commands: [],
    compile_artifacts: [],
    blackbox_commands: [],
    blackbox_artifacts: [],
    fix_files: [],
    linked_tasks: [],
    taint_path: f.taint_path,
  };
}

/** 合并 js+ts 语言配置的污点源（供 TaintFlowEngine）。 */
function collectJsTsSources(): string[] {
  const pack = getRulePack();
  return [...new Set([...pack.languages.javascript.sources, ...pack.languages.typescript.sources])];
}

export class BughuntFullScanTool extends Tool {
  readonly name = 'bughunt_full_scan';
  readonly description = 'BugHunt 模式专用：运行全套扫描（ast-grep + 正则 + js-x-ray + tsc + npm audit + semgrep），返回综合安全态势。';
  readonly parameters = z.object({
    target: z.string().optional().describe('项目路径，默认当前工作区'),
    skipSemgrep: z.boolean().optional(),
    skipTsc: z.boolean().optional(),
    skipNpmAudit: z.boolean().optional(),
  });

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = this.parameters.parse(args ?? {});
    // 执行卫生：bughunt 扫描默认在独立 worktree 跑，避免 tsc/npm audit/semgrep
    // 产物污染主工作树（非安全边界，仅工程卫生；见 ModeWorktreeService）。
    // 用户显式传 target 时尊重其选择；否则在模式 worktree（若可用）内执行。
    const requestedWorkspace = context?.workspace || process.cwd();
    const target = params.target
      || ensureModeWorktree('bughunt', requestedWorkspace)
      || requestedWorkspace;
    try {
      const results: ScanResult[] = await runFullScan(target, {
        skipSemgrep: params.skipSemgrep,
        skipTsc: params.skipTsc,
        skipNpmAudit: params.skipNpmAudit,
      });
      // Taint tier：JS/TS 过程内污点传播（自动 taint_path；确定性、无外部依赖）
      const taint = runTaintScan(target, collectJsTsSources());
      return { success: true, data: buildScanPayload(target, results, '=== BugHunt 全套扫描报告 ===', taint.findings) };
    } catch (err) {
      return { success: false, data: null, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
