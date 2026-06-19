/**
 * SkillForm — create / edit a user-authored skill (markdown file under
 * .lingxiao/skills/). Mirrors UserToolForm: local validation, modal shell,
 * direct fetch. Skill schema = name + description (frontmatter) + body.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { useSessionStore } from '../../stores/sessionStore';
import { apiFetch } from './crud/api';
import { CrudModal } from './crud/CrudModal';
import { Field } from './crud/Field';

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{1,63}$/;

export interface SkillFormInitial {
  name: string;
  description: string;
  body: string;
  scope: 'project' | 'global';
}

interface Props {
  initial?: SkillFormInitial;
  onClose: () => void;
  onSaved: () => void;
}

export default function SkillForm({ initial, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const sessionId = useSessionStore((s) => s.sessionId || s.activeSessionId);
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [scope] = useState<'project' | 'global'>(initial?.scope ?? 'project');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!NAME_RE.test(name.trim())) { setError(t('skills.error.nameInvalid')); return; }
    if (!description.trim()) { setError(t('skills.error.descriptionRequired')); return; }
    if (!body.trim()) { setError(t('skills.error.bodyRequired')); return; }
    setSaving(true);
    setError(null);
    try {
      const path = isEdit ? `/skills/${encodeURIComponent(initial!.name)}` : '/skills';
      await apiFetch(path, {
        method: isEdit ? 'PUT' : 'POST',
        body: JSON.stringify({ sessionId, scope, name: name.trim(), description: description.trim(), body }),
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
      title={isEdit ? t('skills.form.editTitle') : t('skills.form.createTitle')}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="px-3 py-1 text-xs text-text-secondary border border-border-default rounded hover:bg-bg-hover">
            {t('app.cancel')}
          </button>
          <button onClick={save} disabled={saving} className="px-3 py-1 text-xs text-white bg-accent-brand rounded hover:opacity-90 disabled:opacity-50 flex items-center gap-1">
            {saving && <Loader2 className="w-3 h-3 animate-spin" />}
            {isEdit ? t('skills.action.update') : t('skills.action.create')}
          </button>
        </>
      }
    >
      {error && <div className="px-3 py-2 bg-accent-red/10 text-accent-red text-xs rounded">{error}</div>}
      <Field label={t('skills.field.name')}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={isEdit}
          placeholder="my-skill"
          className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary disabled:opacity-50"
        />
        <p className="text-[10px] text-text-tertiary mt-1">{isEdit ? t('skills.hint.nameLocked') : t('skills.hint.nameFormat')}</p>
      </Field>
      <Field label={t('skills.field.description')}>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('skills.hint.description')}
          className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary"
        />
      </Field>
      <Field label={t('skills.field.body')}>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={10}
          placeholder="# Steps&#10;&#10;1. ..."
          className="w-full bg-bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary font-mono"
        />
      </Field>
    </CrudModal>
  );
}
