/**
 * UserToolForm — 新建/编辑用户自定义工具的模态表单
 * 三种 kind：http / shell / python
 * 模板渲染语法：{{paramName}}
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, X, Play, Loader2 } from 'lucide-react';
import { getServerToken } from '../../api/headers';

const USER_TOOL_KINDS = ['http', 'shell', 'python'] as const;
const USER_TOOL_PARAMETER_TYPES = ['string', 'number', 'boolean'] as const;
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'] as const;

export type UserToolKind = (typeof USER_TOOL_KINDS)[number];
type UserToolParameterType = (typeof USER_TOOL_PARAMETER_TYPES)[number];
type HttpMethod = (typeof HTTP_METHODS)[number];

export interface UserToolParameter {
  name: string;
  type: UserToolParameterType;
  description?: string;
  required?: boolean;
  default?: string | number | boolean;
}

export interface UserToolSpec {
  name: string;
  description: string;
  kind: UserToolKind;
  enabled?: boolean;
  parameters: UserToolParameter[];
  http?: {
    method: HttpMethod;
    url: string;
    headers?: Record<string, string>;
    body_template?: string;
    json_template?: Record<string, unknown>;
    timeout_ms?: number;
  };
  shell?: {
    command: string;
    cwd?: string;
    timeout_ms?: number;
  };
  python?: {
    code: string;
    timeout_ms?: number;
  };
}

interface Props {
  initial?: UserToolSpec;
  onClose: () => void;
  onSaved: (spec: UserToolSpec) => void;
}

const NAME_RE = /^[a-z][a-z0-9_]{1,49}$/;

function isUserToolKind(value: string): value is UserToolKind {
  return (USER_TOOL_KINDS as readonly string[]).includes(value);
}

function isUserToolParameterType(value: string): value is UserToolParameterType {
  return (USER_TOOL_PARAMETER_TYPES as readonly string[]).includes(value);
}

function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value);
}

function emptySpec(): UserToolSpec {
  return {
    name: '',
    description: '',
    kind: 'http',
    enabled: true,
    parameters: [],
    http: { method: 'GET', url: '' },
  };
}

export default function UserToolForm({ initial, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const isEdit = !!initial;
  const [spec, setSpec] = useState<UserToolSpec>(() => initial || emptySpec());
  const [headersList, setHeadersList] = useState<Array<{ k: string; v: string }>>(() =>
    initial?.http?.headers
      ? Object.entries(initial.http.headers).map(([k, v]) => ({ k, v }))
      : [],
  );
  const [jsonTemplate, setJsonTemplate] = useState<string>(() =>
    initial?.http?.json_template ? JSON.stringify(initial.http.json_template, null, 2) : '',
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testArgs, setTestArgs] = useState<string>('{}');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  // 切换 kind 时给对应 kind 字段补齐默认值
  useEffect(() => {
    setSpec((prev) => {
      const next = { ...prev };
      if (next.kind === 'http' && !next.http) next.http = { method: 'GET', url: '' };
      if (next.kind === 'shell' && !next.shell) next.shell = { command: '' };
      if (next.kind === 'python' && !next.python) next.python = { code: '' };
      return next;
    });
  }, [spec.kind]);

  const addParam = () => {
    setSpec((p) => ({
      ...p,
      parameters: [...p.parameters, { name: '', type: 'string', required: false }],
    }));
  };
  const updateParam = (idx: number, patch: Partial<UserToolParameter>) => {
    setSpec((p) => ({
      ...p,
      parameters: p.parameters.map((x, i) => (i === idx ? { ...x, ...patch } : x)),
    }));
  };
  const removeParam = (idx: number) => {
    setSpec((p) => ({ ...p, parameters: p.parameters.filter((_, i) => i !== idx) }));
  };

  const validate = (): string | null => {
    if (!NAME_RE.test(spec.name)) return t('tools.error.nameInvalid');
    if (!spec.description.trim()) return t('tools.error.descriptionRequired');
    if (spec.kind === 'http') {
      if (!spec.http?.url) return t('tools.error.urlRequired');
    }
    if (spec.kind === 'shell') {
      if (!spec.shell?.command) return t('tools.error.commandRequired');
    }
    if (spec.kind === 'python') {
      if (!spec.python?.code) return t('tools.error.codeRequired');
    }
    const names = new Set<string>();
    for (const p of spec.parameters) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,49}$/.test(p.name)) {
        return t('tools.error.paramNameInvalid', { name: p.name || '?' });
      }
      if (names.has(p.name)) {
        return t('tools.error.paramNameDuplicate', { name: p.name });
      }
      names.add(p.name);
    }
    for (const h of headersList) {
      if (!h.k.trim() && h.v.trim()) return t('tools.error.headerNameRequired');
    }
    return null;
  };

  const buildPayload = (): UserToolSpec => {
    const next: UserToolSpec = {
      name: spec.name,
      description: spec.description,
      kind: spec.kind,
      enabled: spec.enabled !== false,
      parameters: spec.parameters.map((p) => {
        const out: UserToolParameter = { name: p.name, type: p.type, required: !!p.required };
        if (p.description) out.description = p.description;
        if (p.default !== undefined && String(p.default) !== '') {
          if (p.type === 'number') out.default = Number(p.default);
          else if (p.type === 'boolean') out.default = p.default === true || p.default === 'true';
          else out.default = String(p.default);
        }
        return out;
      }),
    };
    if (spec.kind === 'http' && spec.http) {
      const headers: Record<string, string> = {};
      for (const { k, v } of headersList) {
        if (k.trim()) headers[k.trim()] = v;
      }
      let json_template: Record<string, unknown> | undefined;
      if (jsonTemplate.trim()) {
        try {
          const parsed: unknown = JSON.parse(jsonTemplate);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            json_template = parsed as Record<string, unknown>;
          }
        } catch {
          // 校验阶段已报错；这里忽略
        }
      }
      next.http = {
        method: spec.http.method,
        url: spec.http.url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(spec.http.body_template ? { body_template: spec.http.body_template } : {}),
        ...(json_template ? { json_template } : {}),
        ...(spec.http.timeout_ms ? { timeout_ms: spec.http.timeout_ms } : {}),
      };
    }
    if (spec.kind === 'shell' && spec.shell) {
      next.shell = {
        command: spec.shell.command,
        ...(spec.shell.cwd ? { cwd: spec.shell.cwd } : {}),
        ...(spec.shell.timeout_ms ? { timeout_ms: spec.shell.timeout_ms } : {}),
      };
    }
    if (spec.kind === 'python' && spec.python) {
      next.python = {
        code: spec.python.code,
        ...(spec.python.timeout_ms ? { timeout_ms: spec.python.timeout_ms } : {}),
      };
    }
    return next;
  };

  const save = async () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    if (jsonTemplate.trim()) {
      try {
        JSON.parse(jsonTemplate);
      } catch {
        setError(t('tools.error.jsonTemplateInvalid'));
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      const payload = buildPayload();
      const url = isEdit ? `/api/v1/tools/${encodeURIComponent(spec.name)}` : `/api/v1/tools`;
      const res = await fetch(url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-lingxiao-token': getServerToken(),
        },
        body: JSON.stringify(isEdit ? { spec: payload } : payload),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.message || body?.error || `HTTP ${res.status}`);
        return;
      }
      onSaved(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    if (!isEdit && !NAME_RE.test(spec.name)) {
      setTestResult(t('tools.error.testRequiresSave'));
      return;
    }
    let parsedArgs: unknown = {};
    if (testArgs.trim()) {
      try {
        parsedArgs = JSON.parse(testArgs);
      } catch {
        setTestResult(t('tools.error.argsInvalid'));
        return;
      }
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/v1/tools/${encodeURIComponent(spec.name)}/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-lingxiao-token': getServerToken(),
        },
        body: JSON.stringify({ args: parsedArgs }),
      });
      const body = await res.json();
      setTestResult(JSON.stringify(body, null, 2));
    } catch (e) {
      setTestResult(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-bg-primary border border-border-default rounded-lg w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="px-4 py-3 border-b border-border-default flex items-center justify-between">
          <h3 className="text-sm font-medium text-text-primary">
            {isEdit ? t('tools.form.editTitle') : t('tools.form.createTitle')}
          </h3>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {error && (
            <div className="px-3 py-2 bg-accent-red/10 text-accent-red text-xs rounded">{error}</div>
          )}

          {/* 基本信息 */}
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('tools.field.name')}>
              <input
                type="text"
                value={spec.name}
                onChange={(e) => setSpec({ ...spec, name: e.target.value })}
                disabled={isEdit}
                placeholder="my_custom_tool"
                className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary disabled:opacity-50"
              />
              <p className="text-[10px] text-text-tertiary mt-1">
                {isEdit ? t('tools.hint.nameLocked') : t('tools.hint.nameFormat')}
              </p>
            </Field>
            <Field label={t('tools.field.kind')}>
              <select
                value={spec.kind}
                onChange={(e) => {
                  if (isUserToolKind(e.target.value)) {
                    setSpec({ ...spec, kind: e.target.value });
                  }
                }}
                className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary"
              >
                {USER_TOOL_KINDS.map((kind) => (
                  <option key={kind} value={kind}>{t(`tools.kind.${kind}`)}</option>
                ))}
              </select>
            </Field>
          </div>

          <Field label={t('tools.field.description')}>
            <textarea
              value={spec.description}
              onChange={(e) => setSpec({ ...spec, description: e.target.value })}
              rows={2}
              placeholder={t('tools.hint.description')}
              className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary"
            />
          </Field>

          {/* 参数定义 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-text-secondary">{t('tools.field.parameters')}</span>
              <button onClick={addParam} className="text-xs text-accent-brand hover:underline flex items-center gap-1">
                <Plus className="w-3 h-3" /> {t('tools.action.addParam')}
              </button>
            </div>
            {spec.parameters.length === 0 ? (
              <p className="text-[11px] text-text-tertiary">{t('tools.hint.noParams')}</p>
            ) : (
              <div className="space-y-1">
                {spec.parameters.map((p, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={p.name}
                      onChange={(e) => updateParam(idx, { name: e.target.value })}
                      placeholder="name"
                      className="flex-1 bg-bg-input border border-border-input rounded px-2 py-1 text-xs"
                    />
                    <select
                      value={p.type}
                      onChange={(e) => {
                        if (isUserToolParameterType(e.target.value)) {
                          updateParam(idx, { type: e.target.value });
                        }
                      }}
                      className="bg-bg-input border border-border-input rounded px-2 py-1 text-xs"
                    >
                      {USER_TOOL_PARAMETER_TYPES.map((type) => (
                        <option key={type} value={type}>{type}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={p.description || ''}
                      onChange={(e) => updateParam(idx, { description: e.target.value })}
                      placeholder={t('tools.field.description')}
                      className="flex-1 bg-bg-input border border-border-input rounded px-2 py-1 text-xs"
                    />
                    <input
                      type="text"
                      value={p.default !== undefined ? String(p.default) : ''}
                      onChange={(e) => updateParam(idx, { default: e.target.value })}
                      placeholder="default"
                      className="w-20 bg-bg-input border border-border-input rounded px-2 py-1 text-xs"
                    />
                    <label className="text-xs text-text-secondary flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={!!p.required}
                        onChange={(e) => updateParam(idx, { required: e.target.checked })}
                      />
                      *
                    </label>
                    <button onClick={() => removeParam(idx)} className="text-text-tertiary hover:text-accent-red">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* kind 特定字段 */}
          {spec.kind === 'http' && spec.http && (
            <div className="space-y-3 border border-border-default rounded p-3">
              <div className="grid grid-cols-[120px_1fr] gap-2">
                <select
                  value={spec.http.method}
                  onChange={(e) => {
                    if (isHttpMethod(e.target.value)) {
                      setSpec({ ...spec, http: { ...spec.http!, method: e.target.value } });
                    }
                  }}
                  className="bg-bg-input border border-border-input rounded px-2 py-1 text-xs"
                >
                  {HTTP_METHODS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <input
                  type="text"
                  value={spec.http.url}
                  onChange={(e) => setSpec({ ...spec, http: { ...spec.http!, url: e.target.value } })}
                  placeholder="https://api.example.com/v1/endpoint?q={{query}}"
                  className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-text-secondary">{t('tools.field.headers')}</span>
                  <button
                    onClick={() => setHeadersList([...headersList, { k: '', v: '' }])}
                    className="text-xs text-accent-brand hover:underline flex items-center gap-1"
                  >
                    <Plus className="w-3 h-3" /> {t('tools.action.addHeader')}
                  </button>
                </div>
                {headersList.map((h, i) => (
                  <div key={i} className="flex items-center gap-2 mb-1">
                    <input
                      type="text"
                      value={h.k}
                      onChange={(e) =>
                        setHeadersList(headersList.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))
                      }
                      placeholder="Header-Name"
                      className="flex-1 bg-bg-input border border-border-input rounded px-2 py-1 text-xs"
                    />
                    <input
                      type="text"
                      value={h.v}
                      onChange={(e) =>
                        setHeadersList(headersList.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))
                      }
                      placeholder="value (supports {{var}})"
                      className="flex-1 bg-bg-input border border-border-input rounded px-2 py-1 text-xs"
                    />
                    <button
                      onClick={() => setHeadersList(headersList.filter((_, j) => j !== i))}
                      className="text-text-tertiary hover:text-accent-red"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>

              <Field label={t('tools.field.bodyTemplate')}>
                <textarea
                  value={spec.http.body_template || ''}
                  onChange={(e) =>
                    setSpec({ ...spec, http: { ...spec.http!, body_template: e.target.value || undefined } })
                  }
                  rows={2}
                  placeholder='hello={{name}}'
                  className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs font-mono"
                />
              </Field>
              <Field label={t('tools.field.jsonTemplate')}>
                <textarea
                  value={jsonTemplate}
                  onChange={(e) => setJsonTemplate(e.target.value)}
                  rows={3}
                  placeholder='{"q": "{{query}}", "limit": "{{limit}}"}'
                  className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs font-mono"
                />
              </Field>
              <Field label={t('tools.field.timeoutMs')}>
                <input
                  type="number"
                  value={spec.http.timeout_ms || ''}
                  onChange={(e) =>
                    setSpec({
                      ...spec,
                      http: { ...spec.http!, timeout_ms: e.target.value ? Number(e.target.value) : undefined },
                    })
                  }
                  placeholder="10000"
                  className="w-32 bg-bg-input border border-border-input rounded px-2 py-1 text-xs"
                />
              </Field>
            </div>
          )}

          {spec.kind === 'shell' && spec.shell && (
            <div className="space-y-3 border border-border-default rounded p-3">
              <Field label={t('tools.field.command')}>
                <textarea
                  value={spec.shell.command}
                  onChange={(e) => setSpec({ ...spec, shell: { ...spec.shell!, command: e.target.value } })}
                  rows={3}
                  placeholder="ls -la {{dir}}"
                  className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs font-mono"
                />
                <p className="text-[10px] text-accent-yellow mt-1">{t('tools.hint.shellSandbox')}</p>
              </Field>
              <Field label={t('tools.field.cwd')}>
                <input
                  type="text"
                  value={spec.shell.cwd || ''}
                  onChange={(e) =>
                    setSpec({ ...spec, shell: { ...spec.shell!, cwd: e.target.value || undefined } })
                  }
                  placeholder="/tmp"
                  className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs"
                />
              </Field>
              <Field label={t('tools.field.timeoutMs')}>
                <input
                  type="number"
                  value={spec.shell.timeout_ms || ''}
                  onChange={(e) =>
                    setSpec({
                      ...spec,
                      shell: { ...spec.shell!, timeout_ms: e.target.value ? Number(e.target.value) : undefined },
                    })
                  }
                  placeholder="30000"
                  className="w-32 bg-bg-input border border-border-input rounded px-2 py-1 text-xs"
                />
              </Field>
            </div>
          )}

          {spec.kind === 'python' && spec.python && (
            <div className="space-y-3 border border-border-default rounded p-3">
              <Field label={t('tools.field.code')}>
                <textarea
                  value={spec.python.code}
                  onChange={(e) => setSpec({ ...spec, python: { ...spec.python!, code: e.target.value } })}
                  rows={6}
                  placeholder="print({{a}} + {{b}})"
                  className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs font-mono"
                />
                <p className="text-[10px] text-accent-yellow mt-1">{t('tools.hint.pythonSandbox')}</p>
              </Field>
              <Field label={t('tools.field.timeoutMs')}>
                <input
                  type="number"
                  value={spec.python.timeout_ms || ''}
                  onChange={(e) =>
                    setSpec({
                      ...spec,
                      python: { ...spec.python!, timeout_ms: e.target.value ? Number(e.target.value) : undefined },
                    })
                  }
                  placeholder="30000"
                  className="w-32 bg-bg-input border border-border-input rounded px-2 py-1 text-xs"
                />
              </Field>
            </div>
          )}

          {/* 测试调用 */}
          {isEdit && (
            <div className="border-t border-border-default pt-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-text-secondary">{t('tools.test.title')}</span>
                <div className="flex items-center gap-3">
                  {testResult && (
                    <button
                      onClick={() => navigator.clipboard?.writeText(testResult)}
                      className="text-xs text-text-tertiary hover:text-accent-brand"
                    >
                      {t('tools.test.copy')}
                    </button>
                  )}
                  <button
                    onClick={runTest}
                    disabled={testing}
                    className="text-xs text-accent-brand hover:underline flex items-center gap-1 disabled:opacity-50"
                  >
                    {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                    {t('tools.test.run')}
                  </button>
                </div>
              </div>
              <textarea
                value={testArgs}
                onChange={(e) => setTestArgs(e.target.value)}
                rows={3}
                placeholder='{"key": "value"}'
                className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs font-mono"
              />
              {testResult && (
                <pre className="mt-2 px-2 py-2 bg-bg-secondary text-[11px] text-text-primary rounded max-h-48 overflow-auto whitespace-pre-wrap">
                  {testResult}
                </pre>
              )}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-border-default flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1 text-xs text-text-secondary border border-border-default rounded hover:bg-bg-hover"
          >
            {t('app.cancel')}
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-3 py-1 text-xs text-white bg-accent-brand rounded hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
          >
            {saving && <Loader2 className="w-3 h-3 animate-spin" />}
            {isEdit ? t('tools.action.update') : t('tools.action.create')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-text-secondary mb-1">{label}</span>
      {children}
    </label>
  );
}
