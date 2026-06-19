import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import type { DatabaseManager } from './Database.js';
import type { EventEmitter } from './EventEmitter.js';
import { AstStructuralEngine } from './AstStructuralEngine.js';
import { TestRunnerAdapter } from './TestRunnerAdapter.js';

export type AssumptionStatus = 'unverified' | 'verified' | 'falsified';
export type AssumptionVerificationType = 'type_check' | 'file_content' | 'test_execution' | 'ast_query';

export interface Assumption {
  id: string;
  title: string;
  content: string;
  status: AssumptionStatus;
  verification: {
    type: AssumptionVerificationType;
    target: string;
    expected: string;
    actual?: string;
  };
  dependents: string[];
  createdBy: string;
  createdAt: number;
  verifiedAt?: number;
  falsifiedAt?: number;
  evidence?: string;
  sessionId?: string;
}

export interface DeclareAssumptionInput {
  title: string;
  content?: string;
  verificationType: AssumptionVerificationType;
  target: string;
  expected: string;
  dependentTaskIds?: string[];
  createdBy?: string;
  sessionId?: string;
}

export interface VerificationBatch {
  verified: Array<{ id: string; evidence: string }>;
  falsified: Array<{ id: string; evidence: string; dependents: string[] }>;
}

export interface AssumptionTrackerLogger {
  warn?: (message: string, ...args: unknown[]) => void;
  info?: (message: string, ...args: unknown[]) => void;
  debug?: (message: string, ...args: unknown[]) => void;
}

interface VerificationOutcome {
  passed: boolean;
  actual: string;
  evidence: string;
}

interface AssumptionRow {
  id: string;
  title: string;
  content: string | null;
  status: AssumptionStatus;
  verification_type: AssumptionVerificationType;
  verification_target: string;
  verification_expected: string;
  verification_actual: string | null;
  dependents: string | null;
  created_by: string | null;
  created_at: number;
  verified_at: number | null;
  falsified_at: number | null;
  evidence: string | null;
  session_id: string | null;
}

function uniqueStrings(values?: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {/* expected: data source unavailable */
    return [];
  }
}

function nowSeconds(): number {
  return Date.now() / 1000;
}

function summarize(value: string, max = 800): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function isFileTarget(target: string): boolean {
  const filePart = target.split('#')[0] || target;
  return Boolean(extname(filePart)) || filePart.includes('/') || filePart.includes('\\');
}

function splitAstTarget(target: string): { file?: string; symbol: string } {
  const [file, symbol] = target.split('#');
  if (symbol) return { file, symbol };
  return { symbol: target };
}

function collectDeclarationSnippets(sourceFile: ts.SourceFile): string[] {
  const snippets: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      snippets.push(summarize(node.getText(sourceFile).replace(/\s+/g, ' '), 240));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return snippets;
}

export class AssumptionTracker {
  private readonly db: DatabaseManager;
  private readonly astEngine: AstStructuralEngine;
  private readonly logger?: AssumptionTrackerLogger;
  private readonly emitter?: EventEmitter;
  private readonly sessionId?: string;
  private readonly projectRoot: string;
  private readonly testTimeoutMs: number;

  constructor(deps: {
    db: DatabaseManager;
    astEngine?: AstStructuralEngine;
    logger?: AssumptionTrackerLogger;
    emitter?: EventEmitter;
    sessionId?: string;
    projectRoot?: string;
    testTimeoutMs?: number;
  }) {
    this.db = deps.db;
    this.projectRoot = resolve(deps.projectRoot || process.cwd());
    this.astEngine = deps.astEngine ?? new AstStructuralEngine({ projectRoot: this.projectRoot });
    this.logger = deps.logger;
    this.emitter = deps.emitter;
    this.sessionId = deps.sessionId;
    this.testTimeoutMs = deps.testTimeoutMs ?? 30_000;
  }

  declare(input: DeclareAssumptionInput): Assumption {
    const title = input.title.trim();
    const target = input.target.trim();
    const expected = input.expected.trim();
    if (!title) throw new Error('assumption title is required');
    if (!target) throw new Error('assumption verification target is required');
    if (!expected) throw new Error('assumption expected fact is required');

    const assumption: Assumption = {
      id: randomUUID(),
      title,
      content: input.content?.trim() || '',
      status: 'unverified',
      verification: {
        type: input.verificationType,
        target: this.normalizeTarget(target),
        expected,
      },
      dependents: uniqueStrings(input.dependentTaskIds),
      createdBy: input.createdBy?.trim() || 'unknown',
      createdAt: nowSeconds(),
      sessionId: input.sessionId || this.sessionId,
    };

    this.db.getDb().prepare(
      `INSERT INTO assumptions (
        id, title, content, status, verification_type, verification_target,
        verification_expected, verification_actual, dependents, created_by,
        created_at, verified_at, falsified_at, evidence, session_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      assumption.id,
      assumption.title,
      assumption.content,
      assumption.status,
      assumption.verification.type,
      assumption.verification.target,
      assumption.verification.expected,
      null,
      JSON.stringify(assumption.dependents),
      assumption.createdBy,
      assumption.createdAt,
      null,
      null,
      null,
      assumption.sessionId ?? null,
    );
    this.emitter?.emit('assumption:declared', { assumption });
    return assumption;
  }

  async onFilesChanged(changedFiles: string[]): Promise<VerificationBatch> {
    const normalized = new Set(changedFiles.map((file) => this.normalizeTarget(file)));
    const assumptions = this.getUnverified().filter((assumption) => this.isRelevantToChangedFiles(assumption, normalized));
    return this.verifyAssumptions(assumptions);
  }

  async verifyAll(): Promise<VerificationBatch> {
    return this.verifyAssumptions(this.getUnverified());
  }

  getUnverified(): Assumption[] {
    return this.listByStatus('unverified');
  }

  getFalsified(): Assumption[] {
    return this.listByStatus('falsified');
  }

  getByTask(taskId: string): Assumption[] {
    return this.listAll().filter((assumption) => assumption.dependents.includes(taskId));
  }

  private listByStatus(status: AssumptionStatus): Assumption[] {
    const rows = this.db.getDb().prepare(
      `SELECT * FROM assumptions WHERE status = ? AND (? IS NULL OR session_id = ?) ORDER BY created_at ASC`,
    ).all(status, this.sessionId ?? null, this.sessionId ?? null) as unknown as AssumptionRow[];
    return rows.map((row) => this.mapRow(row));
  }

  private listAll(): Assumption[] {
    const rows = this.db.getDb().prepare(
      `SELECT * FROM assumptions WHERE (? IS NULL OR session_id = ?) ORDER BY created_at ASC`,
    ).all(this.sessionId ?? null, this.sessionId ?? null) as unknown as AssumptionRow[];
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: AssumptionRow): Assumption {
    return {
      id: row.id,
      title: row.title,
      content: row.content ?? '',
      status: row.status,
      verification: {
        type: row.verification_type,
        target: row.verification_target,
        expected: row.verification_expected,
        actual: row.verification_actual ?? undefined,
      },
      dependents: parseJsonArray(row.dependents),
      createdBy: row.created_by ?? 'unknown',
      createdAt: Number(row.created_at),
      verifiedAt: row.verified_at == null ? undefined : Number(row.verified_at),
      falsifiedAt: row.falsified_at == null ? undefined : Number(row.falsified_at),
      evidence: row.evidence ?? undefined,
      sessionId: row.session_id ?? undefined,
    };
  }

  private async verifyAssumptions(assumptions: Assumption[]): Promise<VerificationBatch> {
    const batch: VerificationBatch = { verified: [], falsified: [] };
    for (const assumption of assumptions) {
      try {
        const outcome = await this.verifyOne(assumption);
        const timestamp = nowSeconds();
        const status: AssumptionStatus = outcome.passed ? 'verified' : 'falsified';
        this.db.getDb().prepare(
          `UPDATE assumptions SET
             status = ?,
             verification_actual = ?,
             verified_at = ?,
             falsified_at = ?,
             evidence = ?
           WHERE id = ?`,
        ).run(
          status,
          outcome.actual,
          outcome.passed ? timestamp : null,
          outcome.passed ? null : timestamp,
          outcome.evidence,
          assumption.id,
        );
        if (outcome.passed) {
          batch.verified.push({ id: assumption.id, evidence: outcome.evidence });
          this.emitter?.emit('assumption:verified', { assumptionId: assumption.id, evidence: outcome.evidence });
        } else {
          const falsified = { id: assumption.id, evidence: outcome.evidence, dependents: assumption.dependents };
          batch.falsified.push(falsified);
          this.emitter?.emit('assumption:falsified', {
            assumptionId: assumption.id,
            evidence: outcome.evidence,
            dependents: assumption.dependents,
            assumption,
          });
        }
      } catch (error) {
        this.logger?.warn?.(`[AssumptionTracker] verification failed for ${assumption.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return batch;
  }

  private verifyOne(assumption: Assumption): Promise<VerificationOutcome> | VerificationOutcome {
    switch (assumption.verification.type) {
      case 'file_content':
        return this.verifyFileContent(assumption);
      case 'type_check':
        return this.verifyTypeCheck(assumption);
      case 'test_execution':
        return this.verifyTestExecution(assumption);
      case 'ast_query':
        return this.verifyAstQuery(assumption);
    }
  }

  private verifyFileContent(assumption: Assumption): VerificationOutcome {
    const file = this.resolveTargetFile(assumption.verification.target);
    if (!existsSync(file)) {
      return {
        passed: false,
        actual: 'file_missing',
        evidence: `file_content: ${assumption.verification.target} does not exist`,
      };
    }
    const content = readFileSync(file, 'utf8');
    const passed = content.includes(assumption.verification.expected);
    return {
      passed,
      actual: passed ? 'expected_text_present' : 'expected_text_absent',
      evidence: passed
        ? `file_content: ${assumption.verification.target} contains exact expected text`
        : `file_content: ${assumption.verification.target} does not contain exact expected text`,
    };
  }

  private verifyTypeCheck(assumption: Assumption): VerificationOutcome {
    const file = this.resolveTargetFile(assumption.verification.target);
    if (!existsSync(file)) {
      return {
        passed: false,
        actual: 'file_missing',
        evidence: `type_check: ${assumption.verification.target} does not exist`,
      };
    }
    const content = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.ES2022, true);
    const diagnostics = (sourceFile as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    if (diagnostics.length > 0) {
      const actual = diagnostics.map((diagnostic: ts.Diagnostic) => diagnostic.messageText).join('; ');
      return {
        passed: false,
        actual,
        evidence: `type_check: parse diagnostics for ${assumption.verification.target}: ${summarize(actual)}`,
      };
    }
    const declarations = collectDeclarationSnippets(sourceFile);
    const actual = declarations.join('\n');
    const passed = declarations.some((snippet) => snippet.includes(assumption.verification.expected)) ||
      content.includes(assumption.verification.expected);
    return {
      passed,
      actual: actual || 'syntax_ok_no_declarations',
      evidence: passed
        ? `type_check: ${assumption.verification.target} parsed and matched exact expected declaration/text`
        : `type_check: ${assumption.verification.target} parsed but no declaration/text matched exact expected value`,
    };
  }

  private async verifyTestExecution(assumption: Assumption): Promise<VerificationOutcome> {
    const runner = new TestRunnerAdapter({ projectRoot: this.projectRoot, timeoutMs: this.testTimeoutMs });
    const result = await runner.runTests([assumption.verification.target]);
    const actual = JSON.stringify({
      passed: result.passed,
      totalRun: result.totalRun,
      failedCount: result.failedCount,
      diagnostics: result.diagnostics,
      command: [result.command, ...result.args].join(' '),
    });
    const passed = result.passed && actual.includes(assumption.verification.expected);
    return {
      passed,
      actual,
      evidence: passed
        ? `test_execution: ${assumption.verification.target} passed and output matched expected text`
        : `test_execution: ${assumption.verification.target} failed or output did not match expected text: ${summarize(actual)}`,
    };
  }

  private verifyAstQuery(assumption: Assumption): VerificationOutcome {
    const target = splitAstTarget(assumption.verification.target);
    const definitions = this.astEngine.findDefinitions(target.symbol, { file: target.file, limit: 20 });
    const references = this.astEngine.findReferences(target.symbol, { file: target.file, limit: 20 });
    const actual = JSON.stringify({ definitions, references });
    const passed = actual.includes(assumption.verification.expected);
    return {
      passed,
      actual,
      evidence: passed
        ? `ast_query: ${assumption.verification.target} matched exact expected structural evidence`
        : `ast_query: ${assumption.verification.target} did not match exact expected structural evidence: ${summarize(actual)}`,
    };
  }

  private normalizeTarget(target: string): string {
    const [file, suffix] = target.split('#');
    const normalizedFile = isFileTarget(file)
      ? this.toProjectRelative(file)
      : file.trim();
    return suffix ? `${normalizedFile}#${suffix.trim()}` : normalizedFile;
  }

  private toProjectRelative(file: string): string {
    const resolved = isAbsolute(file) ? file : resolve(this.projectRoot, file);
    return relative(this.projectRoot, resolved).replace(/\\/g, '/');
  }

  private resolveTargetFile(target: string): string {
    const file = target.split('#')[0] || target;
    return isAbsolute(file) ? file : join(this.projectRoot, file);
  }

  private isRelevantToChangedFiles(assumption: Assumption, changedFiles: Set<string>): boolean {
    const target = assumption.verification.target.split('#')[0] || assumption.verification.target;
    if (!isFileTarget(target)) return false;
    const normalizedTarget = this.normalizeTarget(target);
    for (const changed of changedFiles) {
      if (changed === normalizedTarget || changed.startsWith(`${normalizedTarget.replace(/\/+$/, '')}/`)) {
        return true;
      }
    }
    return false;
  }
}
