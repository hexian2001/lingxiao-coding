import { useState } from 'react';
import { useWikiStore } from '../../stores/wikiStore';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import ConfirmationDialog from '../ui/ConfirmationDialog';

interface WikiHeaderProps {
  projectPath: string;
}

export default function WikiHeader({ projectPath }: WikiHeaderProps) {
  const { t } = useTranslation();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const status = useWikiStore((s) => s.status);
  const isGenerating = useWikiStore((s) => s.isGenerating);
  const lang = useWikiStore((s) => s.lang);
  const setLang = useWikiStore((s) => s.setLang);
  const generateWiki = useWikiStore((s) => s.generateWiki);
  const updateWiki = useWikiStore((s) => s.updateWiki);
  const deleteWiki = useWikiStore((s) => s.deleteWiki);

  const formatTime = (ts: number | null) => {
    if (!ts) return t('wiki.never', 'N/A');
    return new Date(ts * 1000).toLocaleString();
  };

  return (
    <>
    <div className="flex items-center gap-3 px-4 py-2 border-b border-border-default bg-bg-secondary shrink-0">
      {/* Language selector */}
      <div className="flex items-center gap-1 bg-bg-tertiary rounded px-1">
        <button
          className={`px-2 py-0.5 text-xs rounded transition-colors ${lang === 'zh' ? 'bg-accent-brand text-bg-primary' : 'text-text-secondary hover:text-text-primary'}`}
          onClick={() => setLang('zh')}
        >
          {t('wiki.lang.zh')}
        </button>
        <button
          className={`px-2 py-0.5 text-xs rounded transition-colors ${lang === 'en' ? 'bg-accent-brand text-bg-primary' : 'text-text-secondary hover:text-text-primary'}`}
          onClick={() => setLang('en')}
        >
          {t('wiki.lang.en')}
        </button>
      </div>

      {/* Generating — minimal badge (full progress is shown in WikiProgress) */}
      {isGenerating && (
        <div className="flex items-center gap-1.5 text-xs text-accent-brand">
          <Loader2 size={12} className="animate-spin" />
          <span>{t('wiki.generating', 'Generating...')}</span>
        </div>
      )}

      {/* Action buttons — hidden during generation since WikiProgress handles it */}
      {!isGenerating && (
        <>
          {!status?.exists ? (
            <button
              className="px-3 py-1 text-xs bg-accent-brand text-bg-primary rounded hover:opacity-90 transition-opacity disabled:opacity-50"
              onClick={() => generateWiki(projectPath)}
              disabled={!projectPath}
            >
              {t('wiki.generate', 'Generate')}
            </button>
          ) : (
            <>
              <button
                className="px-3 py-1 text-xs bg-accent-brand/20 text-accent-brand rounded hover:bg-accent-brand/30 transition-colors"
                onClick={() => updateWiki(projectPath)}
              >
                {t('wiki.update', 'Update')}
              </button>
              <button
                className="px-3 py-1 text-xs text-text-secondary hover:text-accent-red transition-colors"
                onClick={() => setShowDeleteConfirm(true)}
              >
                {t('wiki.delete', 'Delete')}
              </button>
            </>
          )}
        </>
      )}

      {/* Status info */}
      {status?.exists && !isGenerating && (
        <div className="flex items-center gap-2 text-xs text-text-secondary ml-auto">
          <span>{status.documentCount} {t('wiki.docs', 'docs')}</span>
          <span className="text-border-muted">|</span>
          <span>{formatTime(status.lastGeneratedAt)}</span>
          {status.changeCount > 0 && (
            <>
              <span className="text-border-muted">|</span>
              <span className="text-accent-yellow">{status.changeCount} {t('wiki.changes', 'changes')}</span>
            </>
          )}
        </div>
      )}

      {!status?.exists && !isGenerating && projectPath && (
        <span className="text-xs text-text-secondary ml-auto">
          {t('wiki.noWiki', 'No wiki yet. Click Generate to create one.')}
        </span>
      )}

      {!projectPath && (
        <span className="text-xs text-text-secondary ml-auto">
          {t('wiki.noProject', 'No active project')}
        </span>
      )}
    </div>

    <ConfirmationDialog
      open={showDeleteConfirm}
      title={t('wiki.delete', 'Delete')}
      message={t('wiki.confirmDelete', 'Delete wiki? This cannot be undone.')}
      confirmLabel={t('common.delete', 'Delete')}
      cancelLabel={t('common.cancel', 'Cancel')}
      variant="danger"
      onConfirm={() => { setShowDeleteConfirm(false); deleteWiki(projectPath); }}
      onCancel={() => setShowDeleteConfirm(false)}
    />
    </>
  );
}
