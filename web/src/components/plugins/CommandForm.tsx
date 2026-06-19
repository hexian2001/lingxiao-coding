/**
 * CommandForm — create / edit a user-authored custom slash command
 * (.lingxiao/commands/<name>.md). Command schema = name + description + agent
 * (frontmatter) + body (may contain $ARGUMENTS).
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { apiFetch } from './crud/api';
import { CrudModal } from './crud/CrudModal';
import { Field } from './crud/Field';

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{1,63}$/;

export interface CommandFormInitial {
  name: string;
  description: string;
  agent: string;
  body: string;
  scope: 'project' | 'global';
}

interface Props {
  initial?: CommandFormInitial;
  availableAgents: string[];
  onClose: () => void;
  onSaved: () => void;
}

export default function CommandForm({ initial, availableAgents, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [agent, setAgent] = useState(initial?.agent ?? 'leader');
  const [body, setBody] = useState(initial?.body ?? '');
  const [scope] = useState<'project' | 'global'>(initial?.scope ?? 'project');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!NAME_RE.test(name.trim())) { setError(t('commands.error.nameInvalid')); return; }
    if (!description.trim()) { setError(t('commands.error.descriptionRequired')); return; }
    if (!agent.trim()) { setError(t('commands.error.agentRequired')); return; }
    if (!body.trim()) { setError(t('commands.error.bodyRequired')); return; }
    setSaving(true);
    setError(null);
    try {
      const path = isEdit ? `/commands/${encodeURIComponent(initial!.name)}` : '/commands';
      await apiFetch(path, {
        method: isEdit ? 'PUT' : 'POST',
        body: JSON.stringify({ scope, name: name.trim(), description: description.trim(), agent: agent.trim(), body }),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <CrudModal
      title={isEdit ? t('commands.form.editTitle') : t('commands.form.createTitle')}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="px-3 py-1 text-xs text-text-secondary border border-border-default rounded hover:bg-bg-hover">
            {t('app.cancel')}
          </button>
          <button onClick={save} disabled={saving} className="px-3 py-1 text-xs text-white bg-accent-brand rounded hover:opacity-90 disabled:opacity-50 flex items-center gap-1">
            {saving && <Loader2 className="w-3 h-3 animate-spin" />}
            {isEdit ? t('commands.action.update') : t('commands.action.create')}
          </button>
        </>
      }
    >
      {error && <div className="px-3 py-2 bg-accent-red/10 text-accent-red text-xs rounded">{error}</div>}
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('commands.field.name')}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isEdit}
            placeholder="fix-tests"
            className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary disabled:opacity-50"
          />
          <p className="text-[10px] text-text-tertiary mt-1">{isEdit ? t('commands.hint.nameLocked') : t('commands.hint.nameFormat')}</p>
        </Field>
        <Field label={t('commands.field.agent')}>
          <input
            type="text"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            placeholder="leader"
            list="command-agent-options"
            className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary"
          />
          <datalist id="command-agent-options">
            {availableAgents.map((a) => <option key={a} value={a} />)}
          </datalist>
        </Field>
      </div>
      <Field label={t('commands.field.description')}>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('commands.hint.description')}
          className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary"
        />
      </Field>
      <Field label={t('commands.field.body')}>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          placeholder={t('commands.hint.body')}
          className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary font-mono"
        />
      </Field>
    </CrudModal>
  );
}
