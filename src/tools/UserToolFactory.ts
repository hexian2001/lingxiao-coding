/**
 * UserToolFactory — 把用户在 settings.json 里声明的 UserToolSpec
 * 包装成 ToolRegistry 可注册的 ToolContract。
 *
 * 三种 kind：
 *   - http   → 委托 HttpRequestTool（自带内网拦截）
 *   - shell  → 委托 ShellTool（自带 ExecutionSandbox + permission）
 *   - python → 委托 PythonExecTool（自带沙盒 + permission）
 *
 * 模板渲染：
 *   - 仅 `{{name}}` 字面替换，无 eval/Function/嵌套
 *   - 未提供值时使用 parameter.default
 *   - required 缺失时执行返回结构化错误
 */

import { normalizeJsonSchemaForOpenAI, type ToolContext, type ToolResult } from './Tool.js';
import { normalizeToolResult, type JsonSchema, type ToolContract } from '../contracts/types/Tool.js';
import type { UserToolSpec, UserToolParameter } from '../config.js';
import { ShellTool } from './implementations/Shell.js';
import { HttpRequestTool } from './implementations/HttpRequestTool.js';
import { PythonExecTool } from './implementations/PythonExecTool.js';

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** 把 spec.parameters 转成 OpenAI function 兼容的 JSON Schema */
export function userToolToJsonSchema(spec: UserToolSpec): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const p of spec.parameters) {
    const prop: Record<string, unknown> = { type: p.type };
    if (p.description) prop.description = p.description;
    if (p.default !== undefined) prop.default = p.default;
    properties[p.name] = prop;
    if (p.required) required.push(p.name);
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

/** 套用 spec.parameters 的默认值，并校验 required；失败返回 error */
function resolveArgs(
  spec: UserToolSpec,
  rawArgs: unknown,
): { ok: true; values: Record<string, unknown> } | { ok: false; error: string } {
  const args: Record<string, unknown> =
    rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? { ...(rawArgs as Record<string, unknown>) }
      : {};

  const merged: Record<string, unknown> = {};
  const missing: string[] = [];

  for (const p of spec.parameters) {
    if (p.name in args && args[p.name] !== undefined && args[p.name] !== null) {
      merged[p.name] = args[p.name];
    } else if (p.default !== undefined) {
      merged[p.name] = p.default;
    } else if (p.required) {
      missing.push(p.name);
    }
  }

  // 用户传入 spec 没声明的额外字段也保留（便于 LLM 补充）
  for (const [k, v] of Object.entries(args)) {
    if (!(k in merged)) merged[k] = v;
  }

  if (missing.length > 0) {
    return { ok: false, error: `缺少必填参数：${missing.join(', ')}` };
  }
  return { ok: true, values: merged };
}

/** 渲染 string 模板：把 {{name}} 替换为 vars[name] 的字面值 */
export function renderStringTemplate(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(PLACEHOLDER_RE, (match, key: string) => {
    if (!(key in vars)) return match; // 保留未知占位符，便于排错
    const value = vars[key];
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value);
    } catch {/* expected: fallback to default */
      return String(value);
    }
  });
}

/** 递归渲染 JSON 模板：仅对字符串叶子做 {{name}} 替换；纯字符串模板（"{{x}}"）解出原始类型 */
function renderJsonTemplate(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    // 整体匹配单一占位符 → 返回原始类型，不强制转字符串
    const whole = /^\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$/.exec(value);
    if (whole) {
      const key = whole[1];
      return key in vars ? vars[key] : value;
    }
    return renderStringTemplate(value, vars);
  }
  if (Array.isArray(value)) {
    return value.map((v) => renderJsonTemplate(v, vars));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = renderJsonTemplate(v, vars);
    }
    return out;
  }
  return value;
}

function renderHeaders(
  headers: Record<string, string> | undefined,
  vars: Record<string, unknown>,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = renderStringTemplate(v, vars);
  }
  return out;
}

export interface UserToolFactoryDeps {
  http?: HttpRequestTool;
  shell?: ShellTool;
  python?: PythonExecTool;
}

type UserToolSpecWithSchema = UserToolSpec & {
  input_schema?: JsonSchema;
  schema?: JsonSchema;
};

/**
 * 把一个 UserToolSpec 包装成可注册的 ToolContract。
 * deps 用于注入共享底座（默认每次构造工具时各自 lazy 单例）。
 */
export function buildUserTool(spec: UserToolSpec, deps?: UserToolFactoryDeps): ToolContract {
  const schemaSpec = spec as UserToolSpecWithSchema;
  const schema = normalizeJsonSchemaForOpenAI((schemaSpec.input_schema ?? schemaSpec.schema ?? userToolToJsonSchema(spec)) as Record<string, unknown>) as JsonSchema;

  let httpDelegate = deps?.http ?? null;
  let shellDelegate = deps?.shell ?? null;
  let pythonDelegate = deps?.python ?? null;

  return {
    name: spec.name,
    description: spec.description ?? '',
    scope: 'worker',
    getSchema: () => schema,
    getExecutionTimeoutMs(rawArgs: unknown): number | null | undefined {
      switch (spec.kind) {
        case 'shell': {
          if (!spec.shell) return undefined;
          shellDelegate ??= new ShellTool();
          const resolved = resolveArgs(spec, rawArgs);
          const vars = resolved.ok ? resolved.values : {};
          const shellArgs: Record<string, unknown> = {
            command: renderStringTemplate(spec.shell.command, vars),
            is_background: false,
          };
          if (spec.shell.cwd) {
            shellArgs.cwd = renderStringTemplate(spec.shell.cwd, vars);
          }
          if (typeof spec.shell.timeout_ms === 'number') {
            shellArgs.timeout = Math.max(1, Math.ceil(spec.shell.timeout_ms / 1000));
          }
          return shellDelegate.getExecutionTimeoutMs?.(shellArgs);
        }
        case 'http': {
          return typeof spec.http?.timeout_ms === 'number'
            ? Math.max(1_000, spec.http.timeout_ms + 5_000)
            : undefined;
        }
        case 'python': {
          return typeof spec.python?.timeout_ms === 'number'
            ? Math.max(1_000, spec.python.timeout_ms + 5_000)
            : undefined;
        }
        default:
          return undefined;
      }
    },
    async execute(rawArgs: unknown, context?: ToolContext): Promise<ToolResult> {
      const resolved = resolveArgs(spec, rawArgs);
      if (!resolved.ok) {
        return { success: false, data: null, error: resolved.error };
      }
      const vars = resolved.values;

      try {
        switch (spec.kind) {
          case 'http': {
            if (!spec.http) {
              return { success: false, data: null, error: 'http 工具缺少 http 配置' };
            }
            httpDelegate ??= new HttpRequestTool();
            const httpArgs: Record<string, unknown> = {
              method: spec.http.method,
              url: renderStringTemplate(spec.http.url, vars),
            };
            if (spec.http.headers) {
              httpArgs.headers = renderHeaders(spec.http.headers, vars);
            }
            if (spec.http.body_template) {
              httpArgs.body = renderStringTemplate(spec.http.body_template, vars);
            }
            if (spec.http.json_template) {
              httpArgs.body = renderJsonTemplate(spec.http.json_template, vars);
            }
            if (typeof spec.http.timeout_ms === 'number') {
              httpArgs.timeout = Math.max(1, Math.ceil(spec.http.timeout_ms / 1000));
            }
            return normalizeToolResult(await httpDelegate.execute(httpArgs, context));
          }
          case 'shell': {
            if (!spec.shell) {
              return { success: false, data: null, error: 'shell 工具缺少 shell 配置' };
            }
            shellDelegate ??= new ShellTool();
            const shellArgs: Record<string, unknown> = {
              command: renderStringTemplate(spec.shell.command, vars),
              is_background: false,
            };
            if (spec.shell.cwd) {
              shellArgs.cwd = renderStringTemplate(spec.shell.cwd, vars);
            }
            if (typeof spec.shell.timeout_ms === 'number') {
              shellArgs.timeout = Math.max(1, Math.ceil(spec.shell.timeout_ms / 1000));
            }
            return normalizeToolResult(await shellDelegate.execute(shellArgs, context));
          }
          case 'python': {
            if (!spec.python) {
              return { success: false, data: null, error: 'python 工具缺少 python 配置' };
            }
            pythonDelegate ??= new PythonExecTool();
            const pythonArgs: Record<string, unknown> = {
              code: renderStringTemplate(spec.python.code, vars),
            };
            if (typeof spec.python.timeout_ms === 'number') {
              pythonArgs.timeout = Math.max(1, Math.ceil(spec.python.timeout_ms / 1000));
            }
            return normalizeToolResult(await pythonDelegate.execute(pythonArgs, context));
          }
          default: {
            // 类型穷举保护
            const _exhaustive: never = spec.kind;
            return { success: false, data: null, error: `未知工具 kind: ${String(_exhaustive)}` };
          }
        }
      } catch (error) {
        return {
          success: false,
          data: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
