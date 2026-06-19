import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import {
  basename,
  dirname,
  extname,
  join,
  delimiter,
} from 'node:path';
import { z } from 'zod';
import { Tool, createToolError, type ToolContext, type ToolResult } from '../Tool.js';
import { resolveWorkspacePath } from './utils.js';
import { resolveOfficeRuntimePaths } from './office/OfficeRuntime.js';
import { withToolProxyEnv } from '../../core/ProxyConfig.js';
import { getPythonExecutable } from '../../utils/platform.js';

const ACTIONS = [
  'list',
  'unpack_ooxml',
  'pack_ooxml',
  'strict_validate_ooxml',
  'pptx_thumbnail',
  'xlsx_recalc',
  'pdf_to_images',
] as const;

const OfficeRuntimeSchema = z.object({
  action: z.enum(ACTIONS).describe('Runtime action to execute.'),
  input_path: z.string().optional().describe('Input Office/PDF file path. Relative paths resolve against the workspace.'),
  input_dir: z.string().optional().describe('Input unpacked OOXML directory for pack_ooxml. Relative paths resolve against the workspace.'),
  output_path: z.string().optional().describe('Output Office file path for pack_ooxml. Relative paths resolve against the workspace.'),
  output_dir: z.string().optional().describe('Output directory for unpack_ooxml or pdf_to_images. Relative paths resolve against the workspace.'),
  output_prefix: z.string().optional().describe('Output image prefix for pptx_thumbnail, without .jpg. Relative paths resolve against the workspace.'),
  original_path: z.string().optional().describe('Original Office file path for validation-aware pack/strict validation.'),
  validate: z.boolean().default(true).describe('pack_ooxml: run bundled validation before packing when original_path is supplied.'),
  merge_runs: z.boolean().default(true).describe('unpack_ooxml: merge adjacent DOCX runs with identical formatting.'),
  simplify_redlines: z.boolean().default(true).describe('unpack_ooxml: simplify adjacent DOCX tracked changes from the same author.'),
  auto_repair: z.boolean().default(false).describe('strict_validate_ooxml: repair common OOXML issues before validating.'),
  verbose: z.boolean().default(false).describe('strict_validate_ooxml: print verbose validator output.'),
  author: z.string().default('LingXiao').describe('strict_validate_ooxml: author name for DOCX redline validation.'),
  cols: z.number().int().min(1).max(6).default(3).describe('pptx_thumbnail: thumbnail grid columns.'),
  timeout_seconds: z.number().int().min(1).max(600).default(60).describe('Subprocess timeout in seconds.'),
});

type OfficeRuntimeInput = z.infer<typeof OfficeRuntimeSchema>;

interface CommandSummary {
  command: string[];
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutSummary: string;
  stderrSummary: string;
  elapsedMs: number;
  timedOut: boolean;
  error?: string;
}

const SUMMARY_LIMIT = 3000;

export class OfficeRuntimeTool extends Tool {
  readonly name = '__office_delegate_runtime';
  readonly description = 'Office 模式共享运行时：调用随包内置 Python/LibreOffice/OOXML helper，支持 unpack/pack/strict validate、PPTX 缩略图、XLSX 公式重算、PDF 转图。用于原生 Office 深度编辑和验收闭环。';
  readonly parameters = OfficeRuntimeSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const parsed = OfficeRuntimeSchema.safeParse(args);
    if (!parsed.success) {
      return { success: false, data: null, error: `ERROR: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    }

    const input = parsed.data;
    const runtime = resolveOfficeRuntimePaths();
    if (input.action === 'list') {
      return {
        success: true,
        data: {
          runtime,
          capabilities: [...ACTIONS],
          references: [
            join(runtime.references, 'pptx-editing.md'),
            join(runtime.references, 'pptxgenjs.md'),
            join(runtime.references, 'pdf-advanced.md'),
            join(runtime.references, 'pdf-forms.md'),
            join(runtime.references, 'commercial-pptx.md'),
          ],
        },
      };
    }

    if (!runtime.exists) {
      return createToolError({
        code: 'OFFICE_RUNTIME_NOT_FOUND',
        message: 'Office runtime scripts are not available.',
        retryable: false,
        cause: `Expected runtime at ${runtime.root}`,
        fix: 'Ensure skills/bundled/office-suite/scripts is packaged or set LINGXIAO_OFFICE_RUNTIME_DIR.',
      });
    }

    try {
      switch (input.action) {
        case 'unpack_ooxml':
          return this.unpackOoxml(input, context);
        case 'pack_ooxml':
          return this.packOoxml(input, context);
        case 'strict_validate_ooxml':
          return this.strictValidate(input, context);
        case 'pptx_thumbnail':
          return this.pptxThumbnail(input, context);
        case 'xlsx_recalc':
          return this.xlsxRecalc(input, context);
        case 'pdf_to_images':
          return this.pdfToImages(input, context);
        default:
          return { success: false, data: null, error: `Unsupported action: ${(input as { action: string }).action}` };
      }
    } catch (error) {
      return { success: false, data: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private unpackOoxml(input: OfficeRuntimeInput, context?: ToolContext): ToolResult {
    const inputPath = requireExistingFile(input.input_path, 'input_path', context);
    const outputDir = requirePath(input.output_dir, 'output_dir', context);
    mkdirSync(outputDir, { recursive: true });
    const runtime = resolveOfficeRuntimePaths();
    const command = runPython(
      [
        join(runtime.officeScripts, 'unpack.py'),
        inputPath,
        outputDir,
        '--merge-runs',
        String(input.merge_runs),
        '--simplify-redlines',
        String(input.simplify_redlines),
      ],
      input.timeout_seconds,
    );
    return commandResult(command, { inputPath, outputDir });
  }

  private packOoxml(input: OfficeRuntimeInput, context?: ToolContext): ToolResult {
    const inputDir = requireExistingDir(input.input_dir, 'input_dir', context);
    const outputPath = requirePath(input.output_path, 'output_path', context);
    mkdirSync(dirname(outputPath), { recursive: true });
    const args = [
      join(resolveOfficeRuntimePaths().officeScripts, 'pack.py'),
      inputDir,
      outputPath,
      '--validate',
      String(input.validate),
    ];
    const originalPath = input.original_path ? requireExistingFile(input.original_path, 'original_path', context) : null;
    if (originalPath) {
      args.push('--original', originalPath);
    }
    const command = runPython(args, input.timeout_seconds);
    return commandResult(command, { inputDir, outputPath, originalPath, outputExists: existsSync(outputPath) });
  }

  private strictValidate(input: OfficeRuntimeInput, context?: ToolContext): ToolResult {
    const targetPath = requireExistingPath(input.input_path, 'input_path', context);
    const args = [join(resolveOfficeRuntimePaths().officeScripts, 'validate.py'), targetPath, '--author', input.author];
    if (input.original_path) {
      args.push('--original', requireExistingFile(input.original_path, 'original_path', context));
    }
    if (input.auto_repair) args.push('--auto-repair');
    if (input.verbose) args.push('--verbose');
    const command = runPython(args, input.timeout_seconds);
    return commandResult(command, { inputPath: targetPath });
  }

  private pptxThumbnail(input: OfficeRuntimeInput, context?: ToolContext): ToolResult {
    const inputPath = requireExistingFile(input.input_path, 'input_path', context);
    const defaultPrefix = defaultOutputPrefix(inputPath, context, 'thumbnails');
    const outputPrefix = input.output_prefix ? requirePath(input.output_prefix, 'output_prefix', context) : defaultPrefix;
    mkdirSync(dirname(outputPrefix), { recursive: true });
    const command = runPython(
      [join(resolveOfficeRuntimePaths().pptxScripts, 'thumbnail.py'), inputPath, outputPrefix, '--cols', String(input.cols)],
      input.timeout_seconds,
    );
    const outputFiles = collectPrefixedFiles(outputPrefix, '.jpg');
    return commandResult(command, { inputPath, outputPrefix, outputFiles });
  }

  private xlsxRecalc(input: OfficeRuntimeInput, context?: ToolContext): ToolResult {
    const inputPath = requireExistingFile(input.input_path, 'input_path', context);
    const command = runPython(
      [join(resolveOfficeRuntimePaths().xlsxScripts, 'recalc.py'), inputPath, String(input.timeout_seconds)],
      input.timeout_seconds + 10,
    );
    return commandResult(command, { inputPath, json: parseJsonMaybe(command.stdout) });
  }

  private pdfToImages(input: OfficeRuntimeInput, context?: ToolContext): ToolResult {
    const inputPath = requireExistingFile(input.input_path, 'input_path', context);
    const outputDir = input.output_dir ? requirePath(input.output_dir, 'output_dir', context) : defaultOutputDir(inputPath, context, 'pdf-pages');
    mkdirSync(outputDir, { recursive: true });
    const command = runPython(
      [join(resolveOfficeRuntimePaths().pdfScripts, 'convert_pdf_to_images.py'), inputPath, outputDir],
      input.timeout_seconds,
    );
    const outputFiles = existsSync(outputDir)
      ? readdirSync(outputDir).filter((name) => /^page_\d+\.png$/i.test(name)).sort().map((name) => join(outputDir, name))
      : [];
    return commandResult(command, { inputPath, outputDir, outputFiles });
  }
}

function requirePath(value: string | undefined, field: string, context?: ToolContext): string {
  if (!value) throw new Error(`${field} is required for this office_ops runtime action.`);
  return resolveWorkspacePath(context?.workspace, value, context?.sessionId);
}

function requireExistingPath(value: string | undefined, field: string, context?: ToolContext): string {
  const path = requirePath(value, field, context);
  if (!existsSync(path)) throw new Error(`${field} does not exist: ${path}`);
  return path;
}

function requireExistingFile(value: string | undefined, field: string, context?: ToolContext): string {
  const path = requireExistingPath(value, field, context);
  if (!statSync(path).isFile()) throw new Error(`${field} is not a file: ${path}`);
  return path;
}

function requireExistingDir(value: string | undefined, field: string, context?: ToolContext): string {
  const path = requireExistingPath(value, field, context);
  if (!statSync(path).isDirectory()) throw new Error(`${field} is not a directory: ${path}`);
  return path;
}

function defaultOutputDir(inputPath: string, context: ToolContext | undefined, suffix: string): string {
  const stem = basename(inputPath, extname(inputPath));
  return resolveWorkspacePath(context?.workspace, join('.lingxiao', 'office-runtime', `${stem}-${suffix}`), context?.sessionId);
}

function defaultOutputPrefix(inputPath: string, context: ToolContext | undefined, suffix: string): string {
  return join(defaultOutputDir(inputPath, context, suffix), basename(inputPath, extname(inputPath)));
}

function collectPrefixedFiles(prefix: string, extension: string): string[] {
  const dir = dirname(prefix);
  const stem = basename(prefix);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name === `${stem}${extension}` || (name.startsWith(`${stem}-`) && name.endsWith(extension)))
    .sort()
    .map((name) => join(dir, name));
}

function runPython(args: string[], timeoutSeconds: number): CommandSummary {
  const runtime = resolveOfficeRuntimePaths();
  const env = withToolProxyEnv({
    ...process.env,
    PYTHONPATH: [runtime.scriptsRoot, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
  });
  const command = getPythonExecutable();
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: runtime.scriptsRoot,
    env,
    encoding: 'utf-8',
    timeout: timeoutSeconds * 1000,
  });
  const elapsedMs = Date.now() - started;
  return {
    command: [command, ...args],
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    stdoutSummary: summarize(result.stdout || ''),
    stderrSummary: summarize(result.stderr || ''),
    elapsedMs,
    timedOut: Boolean(result.error && /timed out/i.test(result.error.message)),
    error: result.error?.message,
  };
}

function commandResult(command: CommandSummary, extra: Record<string, unknown>): ToolResult {
  const success = command.status === 0 && !command.error;
  return {
    success,
    data: {
      ...extra,
      command: command.command,
      status: command.status,
      signal: command.signal,
      elapsedMs: command.elapsedMs,
      timedOut: command.timedOut,
      stdout: command.stdout,
      stderr: command.stderr,
      stdoutSummary: command.stdoutSummary,
      stderrSummary: command.stderrSummary,
    },
    error: success ? undefined : (command.error || command.stderrSummary || command.stdoutSummary || `Command exited with status ${command.status}`),
  };
}

function summarize(text: string): string {
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}...` : text;
}

function parseJsonMaybe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {/* expected: operation may fail gracefully */
    return null;
  }
}

export default OfficeRuntimeTool;
