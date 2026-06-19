import { useWikiStore } from '../../stores/wikiStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useTranslation } from 'react-i18next';
import { FileText, FolderOpen } from 'lucide-react';
import { useMemo } from 'react';

export default function WikiSidebar() {
  const { t } = useTranslation();
  const documents = useWikiStore((s) => s.documents);
  const selectedDocument = useWikiStore((s) => s.selectedDocument);
  const fetchDocument = useWikiStore((s) => s.fetchDocument);
  const status = useWikiStore((s) => s.status);

  // 从 sessionStore 获取 projectPath 作为 fallback
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const serverCwd = useSessionStore((s) => s.serverCwd);
  const projectPath = useMemo(() => {
    if (status?.projectPath) return status.projectPath;
    if (!activeSessionId) return serverCwd || '';
    return sessions.find((s) => s.id === activeSessionId)?.workspace || serverCwd || '';
  }, [status?.projectPath, serverCwd, activeSessionId, sessions]);

  // Group documents by section prefix (e.g., "modules" → group)
  const grouped = useMemo(() => {
    const groups: Record<string, typeof documents> = {};
    for (const doc of documents) {
      const parts = doc.path.split('/');
      const group = parts.length > 1 ? parts[0] : '';
      if (!groups[group]) groups[group] = [];
      groups[group].push(doc);
    }
    return groups;
  }, [documents]);

  if (documents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-secondary text-xs px-4 text-center">
        <FolderOpen size={24} className="mb-2 opacity-40" />
        <span>{t('wiki.sidebar.noDocuments')}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Root-level docs */}
      {grouped['']?.map((doc) => (
        <button
          key={doc.path}
          className={`flex items-center gap-2 px-3 py-1.5 text-xs text-left w-full transition-colors ${
            selectedDocument === doc.path
              ? 'bg-accent-brand/10 text-accent-brand'
              : 'text-text-primary hover:bg-bg-hover'
          }`}
          onClick={() => fetchDocument(projectPath, doc.path)}
        >
          <FileText size={14} className="shrink-0 opacity-60" />
          <span className="truncate">{doc.title}</span>
        </button>
      ))}

      {/* Grouped docs (e.g., modules/) */}
      {Object.entries(grouped)
        .filter(([group]) => group !== '')
        .map(([group, docs]) => (
          <div key={group}>
            <div className="px-3 py-1 text-[10px] font-mono tracking-wider text-text-tertiary uppercase">
              {group}
            </div>
            {docs.map((doc) => (
              <button
                key={doc.path}
                className={`flex items-center gap-2 px-6 py-1.5 text-xs text-left w-full transition-colors ${
                  selectedDocument === doc.path
                    ? 'bg-accent-brand/10 text-accent-brand'
                    : 'text-text-primary hover:bg-bg-hover'
                }`}
                onClick={() => fetchDocument(projectPath, doc.path)}
              >
                <FileText size={14} className="shrink-0 opacity-60" />
                <span className="truncate">{doc.title}</span>
              </button>
            ))}
          </div>
        ))}
    </div>
  );
}
