/**
 * AgentForm — create / edit a custom agent definition
 * (.lingxiao/agents/<name>.md) via /api/v1/roles/custom. Agent schema =
 * name + description + systemPrompt (markdown body) plus optional
 * baseRole / model / tools / skillNames.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { apiFetch } from './crud/api';
import { CrudModal } from './crud/CrudModal';
import { Field } from './crud/Field';

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{1,63}$/;

export interface AgentFormInitial {
  name: string;
  description: string;
  systemPrompt: string;
  baseRoleName?: string;
  model?: string;
  tools: string[];
  skillNames: string[];
}

interface Props {
  initial?: AgentFormInitial;
  onClose: () => void;
  onSaved: () => void;
}

function parseList(value: string): string[] {
  return Array.from(new Set(value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean)));
}

export default function AgentForm({ initial, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? '');
  const [baseRoleName, setBaseRoleName] = useState(initial?.baseRoleName ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [tools, setTools] = useState((initial?.tools ?? []).join(', '));
  const [skillNames, setSkillNames] = useState((initial?.skillNames ?? []).join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!NAME_RE.test(name.trim())) { setError(t('agents.error.nameInvalid')); return; }
    if (!description.trim()) { setError(t('agents.error.descriptionRequired')); return; }
    if (!systemPrompt.trim()) { setError(t('agents.error.systemPromptRequired')); return; }
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        scope: 'project',
        name: name.trim(),
        description: description.trim(),
        systemPrompt,
        tools: parseList(tools),
        skillNames: parseList(skillNames),
      };
      if (baseRoleName.trim()) payload.baseRoleName = baseRoleName.trim();
      if (model.trim()) payload.model = model.trim();
      const path = isEdit ? `/roles/custom/${encodeURIComponent(initial!.name)}` : '/roles/custom';
      await apiFetch(path, { method: isEdit ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <CrudModal
      title={isEdit ? t('agents.form.editTitle') : t('agents.form.createTitle')}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="px-3 py-1 text-xs text-text-secondary border border-border-default rounded hover:bg-bg-hover">
            {t('app.cancel')}
          </button>
          <button onClick={save} disabled={saving} className="px-3 py-1 text-xs text-white bg-accent-brand rounded hover:opacity-90 disabled:opacity-50 flex items-center gap-1">
            {saving && <Loader2 className="w-3 h-3 animate-spin" />}
            {isEdit ? t('agents.action.update') : t('agents.action.create')}
          </button>
        </>
      }
    >
      {error && <div className="px-3 py-2 bg-accent-red/10 text-accent-red text-xs rounded">{error}</div>}
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('agents.field.name')}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isEdit}
            placeholder="api-doctor"
            className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary disabled:opacity-50"
          />
          <p className="text-[10px] text-text-tertiary mt-1">{isEdit ? t('agents.hint.nameLocked') : t('agents.hint.nameFormat')}</p>
        </Field>
        <Field label={t('agents.field.baseRole')}>
          <input
            type="text"
            value={baseRoleName}
            onChange={(e) => setBaseRoleName(e.target.value)}
            placeholder={t('agents.hint.baseRole')}
            className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary"
          />
        </Field>
      </div>
      <Field label={t('agents.field.description')}>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('agents.hint.description')}
          className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary"
        />
      </Field>
      <Field label={t('agents.field.systemPrompt')}>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={8}
          placeholder={t('agents.hint.systemPrompt')}
          className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary font-mono"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('agents.field.model')}>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="agent-fast"
            className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary"
          />
        </Field>
        <Field label={t('agents.field.tools')}>
          <input
            type="text"
            value={tools}
            onChange={(e) => setTools(e.target.value)}
            placeholder={t('agents.hint.tools')}
            className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary font-mono"
          />
        </Field>
      </div>
      <Field label={t('agents.field.skillNames')}>
        <input
          type="text"
          value={skillNames}
          onChange={(e) => setSkillNames(e.target.value)}
          placeholder={t('agents.hint.skillNames')}
          className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary font-mono"
        />
      </Field>
    </CrudModal>
  );
}
