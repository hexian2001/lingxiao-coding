import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { appendFile, mkdir, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
import type { ToolContext, ToolResult } from '../../Tool.js';
import { getSessionScopePaths } from '../utils.js';

const MAX_STRING_LENGTH = 160;
const MAX_ARRAY_ITEMS = 8;
const MAX_OBJECT_KEYS = 24;
const MAX_DEPTH = 4;

const REDACT_KEY_RE = /(password|passwd|secret|token|api[_-]?key|authorization|cookie|credential)/i;
const PATH_KEY_RE = /(^|_)(path|file|filename)$/i;

export interface OfficeAuditRecord {
  schema_version: 'office_audit.v1';
  timestamp: string;
  session_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  tool_call_id: string | null;
  tool: string;
  success: boolean;
  args_summary: unknown;
  input_path: string | null;
  output_path: string | null;
  output_hash_algorithm: 'sha256';
  output_hash: string | null;
  warnings: string[];
}

export interface OfficeAuditInput {
  tool: string;
  args: unknown;
  result: ToolResult;
  context?: ToolContext;
}

export function resolveOfficeAuditLogPath(context?: ToolContext): string {
  if (typeof context?.officeAuditLogPath === 'string' && context.officeAuditLogPath.trim()) {
    return resolve(context.officeAuditLogPath);
  }

  const scope = getSessionScopePaths(
    typeof context?.workspace === 'string' ? context.workspace : undefined,
    typeof context?.sessionId === 'string' ? context.sessionId : undefined,
  );

  if (scope.sessionDir) {
    return join(scope.sessionDir, 'logs', 'office-audit.jsonl');
  }

  return join(tmpdir(), 'office-audit', 'office-audit.jsonl');
}

export function summarizeOfficeArgs(args: unknown): unknown {
  return summarizeValue(args, 0);
}

export async function writeOfficeAuditRecord(input: OfficeAuditInput): Promise<OfficeAuditRecord> {
  const warnings: string[] = [];
  const inputPath = inferInputPath(input.tool, input.args, input.context);
  const outputPath = inferOutputPath(input.tool, input.args, input.result, input.context);
  const outputHash = outputPath ? await sha256File(outputPath, warnings) : null;

  const record: OfficeAuditRecord = {
    schema_version: 'office_audit.v1',
    timestamp: new Date().toISOString(),
    session_id: stringOrNull(input.context?.sessionId),
    agent_id: stringOrNull(input.context?.agentId),
    agent_name: stringOrNull(input.context?.agentName),
    tool_call_id: stringOrNull(input.context?.toolCallId),
    tool: input.tool,
    success: input.result.success,
    args_summary: summarizeOfficeArgs(input.args),
    input_path: inputPath,
    output_path: outputPath,
    output_hash_algorithm: 'sha256',
    output_hash: outputHash,
    warnings,
  };

  const logPath = resolveOfficeAuditLogPath(input.context);
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf-8');
  return record;
}

export async function auditOfficeToolExecution(input: OfficeAuditInput): Promise<void> {
  try {
    await writeOfficeAuditRecord(input);
  } catch {
    // Audit failures must never change the tool's user-visible result.
  }
}

function summarizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[buffer:${value.length}]`;

  if (depth >= MAX_DEPTH) {
    if (Array.isArray(value)) return `[array:${value.length}]`;
    if (typeof value === 'object') return '[object]';
    return String(value);
  }

  if (Array.isArray(value)) {
    const summary = value.slice(0, MAX_ARRAY_ITEMS).map((item) => summarizeValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) summary.push(`[truncated:${value.length - MAX_ARRAY_ITEMS}]`);
    return summary;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
    for (const [key, child] of entries) {
      if (REDACT_KEY_RE.test(key) && !PATH_KEY_RE.test(key)) {
        out[key] = '[redacted]';
      } else {
        out[key] = summarizeValue(child, depth + 1);
      }
    }
    const totalKeys = Object.keys(value as Record<string, unknown>).length;
    if (totalKeys > MAX_OBJECT_KEYS) out.__truncated_keys = totalKeys - MAX_OBJECT_KEYS;
    return out;
  }

  return String(value);
}

function truncateString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated:${value.length - MAX_STRING_LENGTH}]`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toolNameHasPrefix(tool: string, prefix: string): boolean {
  return tool.slice(0, prefix.length) === prefix;
}

function isEditOfficeTool(tool: string): boolean {
  return toolNameHasPrefix(tool, 'edit_');
}

function isGenerateOfficeTool(tool: string): boolean {
  return toolNameHasPrefix(tool, 'generate_');
}

function inferInputPath(tool: string, args: unknown, context?: ToolContext): string | null {
  const argObj = objectOrNull(args);
  const explicit = firstString(argObj, ['input_path', 'inputPath', 'source_path', 'sourcePath', 'file_path', 'filePath']);
  if (explicit) return resolveAuditPath(explicit, context);

  const path = firstString(argObj, ['path']);
  if (!path) return null;
  if (isEditOfficeTool(tool) || tool === 'parse_file' || tool === 'office_ops') {
    return resolveAuditPath(path, context);
  }
  return null;
}

function inferOutputPath(tool: string, args: unknown, result: ToolResult, context?: ToolContext): string | null {
  const resultPath = findPathInResult(result.data);
  if (resultPath) return resolveAuditPath(resultPath, context);

  const argObj = objectOrNull(args);
  const explicit = firstString(argObj, ['output_path', 'outputPath', 'out_path', 'outPath']);
  if (explicit) return resolveAuditPath(explicit, context);

  const path = firstString(argObj, ['path']);
  if (!path) return null;
  if (isGenerateOfficeTool(tool)) return resolveAuditPath(path, context);
  if (isEditOfficeTool(tool) && booleanValue(argObj?.overwrite)) return resolveAuditPath(path, context);
  return null;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(obj: Record<string, unknown> | null, keys: string[]): string | null {
  if (!obj) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 'true';
}

function resolveAuditPath(filePath: string, context?: ToolContext): string {
  if (isAbsolute(filePath)) return resolve(filePath);
  return resolve(typeof context?.workspace === 'string' ? context.workspace : process.cwd(), filePath);
}

function findPathInResult(value: unknown, depth = 0): string | null {
  if (!value || depth > 4) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPathInResult(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;

  const obj = value as Record<string, unknown>;
  for (const key of ['path', 'output_path', 'outputPath', 'filePath', 'artifact_path']) {
    const candidate = obj[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  for (const child of Object.values(obj)) {
    const found = findPathInResult(child, depth + 1);
    if (found) return found;
  }
  return null;
}

async function sha256File(filePath: string, warnings: string[]): Promise<string | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      warnings.push(`output_path is not a file: ${filePath}`);
      return null;
    }
  } catch {/* swallowed: unhandled error */
    warnings.push(`output_path does not exist: ${filePath}`);
    return null;
  }

  return new Promise((resolveHash) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (error) => {
      warnings.push(`failed to hash output_path: ${error instanceof Error ? error.message : String(error)}`);
      resolveHash(null);
    });
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}
