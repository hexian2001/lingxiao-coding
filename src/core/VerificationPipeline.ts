import { isAbsolute, relative } from 'node:path';
import { BuildDiagnosticsCollector, type BuildResult, type Diagnostic } from './BuildDiagnosticsCollector.js';
import { ChangeImpactResolver } from './ChangeImpactResolver.js';
import { TestRunnerAdapter, type TestRunResult } from './TestRunnerAdapter.js';

type LoggerLike = {
  debug?: (msg: string, ...args: unknown[]) => void;
  warn?: (msg: string, ...args: unknown[]) => void;
};

export interface VerificationGateConfig {
  typeCheck: boolean;
  build: boolean;
  affectedTests: boolean;
  fullTests: boolean;
  selfRepairBudget: number;
  buildTimeoutMs: number;
  testTimeoutMs: number;
}

export type VerificationGateName = 'typeCheck' | 'build' | 'affectedTests' | 'fullTests';

export interface GateResult {
  gate: VerificationGateName;
  passed: boolean;
  durationMs: number;
  diagnostics: string[];
  totalRun?: number;
  failedTests?: string[];
}

export interface VerificationResult {
  allPassed: boolean;
  gates: GateResult[];
  totalDurationMs: number;
  affectedTests: string[];
}

export interface VerificationPipelineDeps {
  buildDiagnostics: BuildDiagnosticsCollector;
  changeImpactResolver: ChangeImpactResolver;
  testRunner: TestRunnerAdapter;
  logger?: LoggerLike;
}

const DEFAULT_CONFIG: VerificationGateConfig = {
  typeCheck: true,
  build: true,
  affectedTests: true,
  fullTests: false,
  selfRepairBudget: 3,
  buildTimeoutMs: 120_000,
  testTimeoutMs: 120_000,
};

function normalizeConfig(config?: Partial<VerificationGateConfig>): VerificationGateConfig {
  return { ...DEFAULT_CONFIG, ...(config ?? {}) };
}

function diagnosticToString(diagnostic: Diagnostic): string {
  const code = diagnostic.code ? ` [${diagnostic.code}]` : '';
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}${code} ${diagnostic.message}`;
}

function buildResultDiagnostics(results: BuildResult[]): string[] {
  return results.flatMap((result) => result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'))
    .map(diagnosticToString);
}

function failedGate(result: GateResult): VerificationResult {
  return {
    allPassed: false,
    gates: [result],
    totalDurationMs: result.durationMs,
    affectedTests: [],
  };
}

function normalizeChangedFiles(projectRoot: string, changedFiles: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of changedFiles) {
    const trimmed = file.trim();
    if (!trimmed) continue;
    const rel = (isAbsolute(trimmed) ? relative(projectRoot, trimmed) : trimmed).replaceAll('\\', '/');
    if (!rel || rel.startsWith('..') || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

function testRunToGate(gate: VerificationGateName, result: TestRunResult): GateResult {
  return {
    gate,
    passed: result.passed,
    durationMs: result.durationMs,
    diagnostics: result.diagnostics,
    totalRun: result.totalRun,
    failedTests: result.failedTests,
  };
}

export class VerificationPipeline {
  private readonly buildDiagnostics: BuildDiagnosticsCollector;
  private readonly changeImpactResolver: ChangeImpactResolver;
  private readonly testRunner: TestRunnerAdapter;
  private readonly logger?: LoggerLike;

  constructor(deps: VerificationPipelineDeps) {
    this.buildDiagnostics = deps.buildDiagnostics;
    this.changeImpactResolver = deps.changeImpactResolver;
    this.testRunner = deps.testRunner;
    this.logger = deps.logger;
  }

  async verify(
    workingDir: string,
    changedFiles: string[],
    config?: Partial<VerificationGateConfig>,
  ): Promise<VerificationResult> {
    const cfg = normalizeConfig(config);
    const start = Date.now();
    const gates: GateResult[] = [];
    const normalizedChangedFiles = normalizeChangedFiles(workingDir, changedFiles);
    let affectedTests: string[] = [];

    if (cfg.typeCheck) {
      const gateStart = Date.now();
      const quick = await this.buildDiagnostics.quickCheck(workingDir, cfg.buildTimeoutMs);
      const gate: GateResult = {
        gate: 'typeCheck',
        passed: quick.passed,
        durationMs: Date.now() - gateStart,
        diagnostics: quick.diagnostics.map(diagnosticToString),
      };
      gates.push(gate);
      if (!gate.passed) {
        return { ...failedGate(gate), gates, totalDurationMs: Date.now() - start };
      }
    }

    if (cfg.build) {
      const gateStart = Date.now();
      const results = await this.buildDiagnostics.collectAll(workingDir, cfg.buildTimeoutMs);
      const diagnostics = buildResultDiagnostics(results);
      const gate: GateResult = {
        gate: 'build',
        passed: diagnostics.length === 0,
        durationMs: Date.now() - gateStart,
        diagnostics,
      };
      gates.push(gate);
      if (!gate.passed) {
        return { ...failedGate(gate), gates, totalDurationMs: Date.now() - start };
      }
    }

    if (cfg.affectedTests && normalizedChangedFiles.length > 0) {
      try {
        const impact = await this.changeImpactResolver.resolve(normalizedChangedFiles);
        affectedTests = impact.affectedTests;
      } catch (error) {
        const gate: GateResult = {
          gate: 'affectedTests',
          passed: false,
          durationMs: Date.now() - start,
          diagnostics: [error instanceof Error ? error.message : String(error)],
        };
        gates.push(gate);
        return { ...failedGate(gate), gates, totalDurationMs: Date.now() - start, affectedTests };
      }
      if (affectedTests.length > 0) {
        const result = await this.testRunner.runTests(affectedTests);
        const gate = testRunToGate('affectedTests', result);
        gates.push(gate);
        if (!gate.passed) {
          return { ...failedGate(gate), gates, totalDurationMs: Date.now() - start, affectedTests };
        }
      } else {
        this.logger?.debug?.('[VerificationPipeline] no affected tests for changed files', normalizedChangedFiles);
      }
    }

    if (cfg.fullTests) {
      const result = await this.testRunner.runTests();
      const gate = testRunToGate('fullTests', result);
      gates.push(gate);
      if (!gate.passed) {
        return { ...failedGate(gate), gates, totalDurationMs: Date.now() - start, affectedTests };
      }
    }

    return {
      allPassed: true,
      gates,
      totalDurationMs: Date.now() - start,
      affectedTests,
    };
  }
}
