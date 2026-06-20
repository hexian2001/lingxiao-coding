import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Code2, Loader2, FormInput, Plus, Trash2, X } from 'lucide-react';
import { getServerToken } from '../../api/headers';

export type McpTransport = 'streamable-http' | 'stdio';

export interface McpHeader {
  name: string;
  value: string;
}

export interface McpServerConfig {
  id: string;
  name: string;
  title?: string;
  description?: string;
  enabled?: boolean;
  transport: McpTransport;
  url?: string;
  headers?: McpHeader[];
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  registry?: {
    source_id?: string;
    server_name?: string;
    version?: string;
  };
  origin?: {
    plugin_id?: string;
    plugin_version?: string;
    plugin_path?: string;
  };
  installed_at?: number;
  updated_at?: number;
}

interface Props {
  initial?: McpServerConfig;
  onClose: () => void;
  onSaved: (server: McpServerConfig) => void;
}

const ID_RE = /^[a-z][a-z0-9_]{1,79}$/;
/** Generate an empty JSON template for new servers */
function emptyJsonTemplate(): string {
  return JSON.stringify({
    id: '',
    name: '',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    env: {},
    enabled: true,
  }, null, 2);
}

/** Serialize current form state to JSON string */
function serverToJson(server: McpServerConfig, headers: McpHeader[], argsText: string, envList: Array<{ key: string; value: string }>): string {
  const obj: Record<string, unknown> = {
    id: server.id,
    name: server.name,
    ...(server.title?.trim() ? { title: server.title.trim() } : {}),
    ...(server.description?.trim() ? { description: server.description.trim() } : {}),
    transport: server.transport,
    enabled: server.enabled !== false,
  };
  if (server.transport === 'streamable-http') {
    if (server.url) obj.url = server.url;
    if (headers.length > 0) obj.headers = headers.filter((h) => h.name.trim()).map((h) => ({ name: h.name.trim(), value: h.value }));
  } else {
    if (server.command) obj.command = server.command;
    const args = argsText.split('\n').map((a) => a.trim()).filter(Boolean);
    if (args.length > 0) obj.args = args;
    const env: Record<string, string> = {};
    for (const item of envList) { if (item.key.trim()) env[item.key.trim()] = item.value; }
    if (Object.keys(env).length > 0) obj.env = env;
    if (server.cwd?.trim()) obj.cwd = server.cwd.trim();
  }
  if (server.registry) obj.registry = server.registry;
  return JSON.stringify(obj, null, 2);
}

/** Parse JSON text to McpServerConfig and validate required fields */
function parseJsonConfig(text: string): { ok: true; config: McpServerConfig } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Root must be a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !obj.id) return { ok: false, error: 'id' };
  if (typeof obj.name !== 'string' || !obj.name) return { ok: false, error: 'name' };
  if (typeof obj.transport !== 'string' || !['streamable-http', 'stdio'].includes(obj.transport)) {
    return { ok: false, error: 'transport' };
  }
  return { ok: true, config: obj as unknown as McpServerConfig };
}

function emptyServer(): McpServerConfig {
  return {
    id: '',
    name: '',
    enabled: true,
    transport: 'streamable-http',
    url: '',
    headers: [],
  };
}

async function saveServer(payload: McpServerConfig): Promise<McpServerConfig> {
  const res = await fetch('/api/v1/mcp/servers', {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'x-lingxiao-token': getServerToken(),
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
  }
  return body.data as McpServerConfig;
}

export default function McpServerForm({ initial, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const isEdit = Boolean(initial);
  const [server, setServer] = useState<McpServerConfig>(() => initial ? { ...initial } : emptyServer());
  const [headers, setHeaders] = useState<McpHeader[]>(() => initial?.headers ? [...initial.headers] : []);
  const [argsText, setArgsText] = useState(() => (initial?.args || []).join('\n'));
  const [envList, setEnvList] = useState<Array<{ key: string; value: string }>>(() =>
    initial?.env ? Object.entries(initial.env).map(([key, value]) => ({ key, value })) : [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [jsonText, setJsonText] = useState(() => initial ? serverToJson(initial, initial.headers || [], (initial.args || []).join('\n'), initial.env ? Object.entries(initial.env).map(([k, v]) => ({ key: k, value: v })) : []) : emptyJsonTemplate());

  const update = (patch: Partial<McpServerConfig>) => setServer((prev) => ({ ...prev, ...patch }));

  /** Switch from form mode to JSON: serialize current form data */
  const switchToJson = () => {
    setJsonText(serverToJson(server, headers, argsText, envList));
    setMode('json');
    setError(null);
  };

  /** Switch from JSON mode to form: try to parse JSON and populate form fields */
  const switchToForm = () => {
    const result = parseJsonConfig(jsonText);
    if (!result.ok) {
      // Show error but stay in JSON mode
      if (result.error === 'id' || result.error === 'name' || result.error === 'transport') {
        setError(t('mcp.error.jsonMissingField', { field: result.error }));
      } else {
        setError(t('mcp.error.jsonParse', { error: result.error }));
      }
      return;
    }
    const config = result.config;
    setServer({ ...config });
    setHeaders(config.headers ? [...config.headers] : []);
    setArgsText((config.args || []).join('\n'));
    setEnvList(config.env ? Object.entries(config.env).map(([k, v]) => ({ key: k, value: v })) : []);
    setMode('form');
    setError(null);
  };

  const validate = (): string | null => {
    if (!ID_RE.test(server.id)) return t('mcp.error.idInvalid');
    if (!server.name.trim()) return t('mcp.error.nameRequired');
    if (server.transport === 'streamable-http') {
      if (!server.url?.trim()) return t('mcp.error.urlRequired');
      try {
        const parsed = new URL(server.url);
        if (!['http:', 'https:'].includes(parsed.protocol)) return t('mcp.error.urlProtocol');
      } catch {
        return t('mcp.error.urlInvalid');
      }
      for (const header of headers) {
        if (!header.name.trim() && header.value.trim()) return t('mcp.error.headerNameRequired');
      }
    }
    if (server.transport === 'stdio' && !server.command?.trim()) return t('mcp.error.commandRequired');
    return null;
  };

  const buildPayload = (): McpServerConfig => {
    const base = {
      id: server.id.trim(),
      name: server.name.trim(),
      ...(server.title?.trim() ? { title: server.title.trim() } : {}),
      ...(server.description?.trim() ? { description: server.description.trim() } : {}),
      enabled: server.enabled !== false,
      ...(server.registry ? { registry: server.registry } : {}),
      ...(server.installed_at ? { installed_at: server.installed_at } : {}),
    };
    if (server.transport === 'stdio') {
      const env: Record<string, string> = {};
      for (const item of envList) {
        if (item.key.trim()) env[item.key.trim()] = item.value;
      }
      return {
        ...base,
        transport: 'stdio',
        command: server.command!.trim(),
        args: argsText.split('\n').map((item) => item.trim()).filter(Boolean),
        env,
        ...(server.cwd?.trim() ? { cwd: server.cwd.trim() } : {}),
      };
    }
    return {
      ...base,
      transport: server.transport,
      url: server.url!.trim(),
      headers: headers
        .filter((header) => header.name.trim())
        .map((header) => ({ name: header.name.trim(), value: header.value })),
    };
  };

  const save = async () => {
    setError(null);

    let payload: McpServerConfig;
    if (mode === 'json') {
      const result = parseJsonConfig(jsonText);
      if (!result.ok) {
        if (result.error === 'id' || result.error === 'name' || result.error === 'transport') {
          setError(t('mcp.error.jsonMissingField', { field: result.error }));
        } else {
          setError(t('mcp.error.jsonParse', { error: result.error }));
        }
        return;
      }
      payload = result.config;
      // Validate ID format for JSON mode
      if (!ID_RE.test(payload.id)) {
        setError(t('mcp.error.idInvalid'));
        return;
      }
      // Validate transport-specific fields
      if (payload.transport === 'streamable-http' && !payload.url?.trim()) {
        setError(t('mcp.error.urlRequired'));
        return;
      }
      if (payload.transport === 'stdio' && !payload.command?.trim()) {
        setError(t('mcp.error.commandRequired'));
        return;
      }
    } else {
      const validation = validate();
      if (validation) {
        setError(validation);
        return;
      }
      payload = buildPayload();
    }

    setSaving(true);
    try {
      const saved = await saveServer(payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="lx-overlay p-4">
      <div className="bg-bg-primary border border-border-default rounded-lg w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="px-4 py-3 border-b border-border-default flex items-center justify-between">
          <h3 className="text-sm font-medium text-text-primary">
            {isEdit ? t('mcp.form.editTitle') : t('mcp.form.addTitle')}
          </h3>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary" title={t('app.close')}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {error && <div className="px-3 py-2 bg-accent-red/10 text-accent-red text-xs rounded">{error}</div>}

          {/* Mode switcher */}
          <div className="flex items-center gap-1 border-b border-border-default pb-2">
            <button
              onClick={() => mode === 'json' && switchToForm()}
              className={`flex items-center gap-1.5 px-3 py-1 text-xs rounded-t transition-colors ${
                mode === 'form'
                  ? 'text-accent-brand border-b-2 border-accent-brand -mb-[9px] font-medium'
                  : 'text-text-tertiary hover:text-text-secondary'
              }`}
            >
              <FormInput className="w-3.5 h-3.5" />
              {t('mcp.mode.form')}
            </button>
            <button
              onClick={() => mode === 'form' && switchToJson()}
              className={`flex items-center gap-1.5 px-3 py-1 text-xs rounded-t transition-colors ${
                mode === 'json'
                  ? 'text-accent-brand border-b-2 border-accent-brand -mb-[9px] font-medium'
                  : 'text-text-tertiary hover:text-text-secondary'
              }`}
            >
              <Code2 className="w-3.5 h-3.5" />
              {t('mcp.mode.json')}
            </button>
          </div>

          {mode === 'json' ? (
            <div className="space-y-2">
              <p className="text-xs text-text-tertiary">{t('mcp.json.hint')}</p>
              <textarea
                value={jsonText}
                onChange={(event) => setJsonText(event.target.value)}
                rows={20}
                spellCheck={false}
                placeholder={t('mcp.json.placeholder')}
                className="w-full bg-bg-input border border-border-input rounded px-3 py-2 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-brand/30"
              />
            </div>
          ) : (
            <>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t('mcp.field.serverId')}>
              <input
                value={server.id}
                onChange={(event) => update({ id: event.target.value })}
                disabled={isEdit}
                placeholder="github_docs"
                className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary disabled:opacity-50"
              />
            </Field>
            <Field label={t('mcp.field.transport')}>
              <select
                value={server.transport}
                onChange={(event) => {
                  const transport = event.target.value as McpTransport;
                  update({
                    transport,
                    ...(transport === 'stdio'
                      ? { command: server.command || '', url: undefined }
                      : { url: server.url || '', command: undefined }),
                  });
                }}
                className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary"
              >
                <option value="streamable-http">streamable-http</option>
                <option value="stdio">stdio</option>
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t('mcp.field.registryName')}>
              <input
                value={server.name}
                onChange={(event) => update({ name: event.target.value })}
                placeholder="io.github.owner/server"
                className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary"
              />
            </Field>
            <Field label={t('mcp.field.title')}>
              <input
                value={server.title || ''}
                onChange={(event) => update({ title: event.target.value || undefined })}
                placeholder="Docs MCP"
                className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary"
              />
            </Field>
          </div>

          <Field label={t('mcp.field.description')}>
            <textarea
              value={server.description || ''}
              onChange={(event) => update({ description: event.target.value || undefined })}
              rows={2}
              className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary"
            />
          </Field>

          {server.transport === 'streamable-http' && (
            <div className="space-y-3 border border-border-default rounded p-3">
              <Field label={t('mcp.field.url')}>
                <input
                  value={server.url || ''}
                  onChange={(event) => update({ url: event.target.value })}
                  placeholder="https://example.com/mcp"
                  className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary"
                />
              </Field>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-text-secondary">{t('mcp.field.headers')}</span>
                  <button
                    onClick={() => setHeaders([...headers, { name: '', value: '' }])}
                    className="text-xs text-accent-brand hover:underline flex items-center gap-1"
                  >
                    <Plus className="w-3 h-3" /> {t('mcp.action.addHeader')}
                  </button>
                </div>
                {headers.map((header, index) => (
                  <div key={index} className="flex items-center gap-2 mb-1">
                    <input
                      value={header.name}
                      onChange={(event) => setHeaders(headers.map((item, i) => i === index ? { ...item, name: event.target.value } : item))}
                      placeholder="Authorization"
                      className="flex-1 bg-bg-input border border-border-input rounded px-2 py-1 text-xs"
                    />
                    <input
                      value={header.value}
                      onChange={(event) => setHeaders(headers.map((item, i) => i === index ? { ...item, value: event.target.value } : item))}
                      placeholder="Bearer ..."
                      className="flex-1 bg-bg-input border border-border-input rounded px-2 py-1 text-xs"
                    />
                    <button onClick={() => setHeaders(headers.filter((_, i) => i !== index))} className="text-text-tertiary hover:text-accent-red">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {server.transport === 'stdio' && (
            <div className="space-y-3 border border-border-default rounded p-3">
              <Field label={t('mcp.field.command')}>
                <input
                  value={server.command || ''}
                  onChange={(event) => update({ command: event.target.value })}
                  placeholder="npx"
                  className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs font-mono text-text-primary"
                />
              </Field>
              <Field label={t('mcp.field.arguments')}>
                <textarea
                  value={argsText}
                  onChange={(event) => setArgsText(event.target.value)}
                  rows={4}
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/tmp'}
                  className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs font-mono text-text-primary"
                />
              </Field>
              <Field label={t('mcp.field.cwd')}>
                <input
                  value={server.cwd || ''}
                  onChange={(event) => update({ cwd: event.target.value || undefined })}
                  placeholder="/workspace"
                  className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary"
                />
              </Field>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-text-secondary">{t('mcp.field.environment')}</span>
                  <button
                    onClick={() => setEnvList([...envList, { key: '', value: '' }])}
                    className="text-xs text-accent-brand hover:underline flex items-center gap-1"
                  >
                    <Plus className="w-3 h-3" /> {t('mcp.action.addEnv')}
                  </button>
                </div>
                {envList.map((env, index) => (
                  <div key={index} className="flex items-center gap-2 mb-1">
                    <input
                      value={env.key}
                      onChange={(event) => setEnvList(envList.map((item, i) => i === index ? { ...item, key: event.target.value } : item))}
                      placeholder="API_KEY"
                      className="flex-1 bg-bg-input border border-border-input rounded px-2 py-1 text-xs"
                    />
                    <input
	                      value={env.value}
	                      onChange={(event) => setEnvList(envList.map((item, i) => i === index ? { ...item, value: event.target.value } : item))}
	                      placeholder={t('mcp.placeholder.envValue')}
	                      className="flex-1 bg-bg-input border border-border-input rounded px-2 py-1 text-xs"
	                    />
                    <button onClick={() => setEnvList(envList.filter((_, i) => i !== index))} className="text-text-tertiary hover:text-accent-red">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
            </>
          )}
        </div>

        <div className="px-4 py-3 border-t border-border-default flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1 text-xs text-text-secondary border border-border-default rounded hover:bg-bg-hover">
            {t('app.cancel')}
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-3 py-1 text-xs text-white bg-accent-brand rounded hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
          >
            {saving && <Loader2 className="w-3 h-3 animate-spin" />}
            {t('settings.action.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-text-secondary mb-1">{label}</span>
      {children}
    </label>
  );
}
