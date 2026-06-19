/**
 * ArtifactsView — Scratchpad 制品展示面板
 *
 * 功能：
 * - 统计卡片：文件总数、任务数、角色数
 * - 文件列表：卡片式展示当前 session 的 scratchpad 文件
 * - 文件详情：展开查看 Markdown 内容
 */

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FileText, Loader2, XCircle, Calendar, Filter, Search, X,
  ChevronDown, ChevronRight, Target, User,
} from 'lucide-react';
import { useSessionStore } from '../../stores/sessionStore';
import { getServerToken } from '../../api/headers';
import SafeMarkdown from '../ui/SafeMarkdown';

// ─── Types ───

interface ScratchpadFile {
  name: string;
  taskId?: string;
  role?: string;
  size: number;
  updatedAt: number;
}

// ─── API helpers ───

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-lingxiao-token': getServerToken(),
      ...(opts?.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Utility functions ───

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function getFileTitle(file: ScratchpadFile): string {
  if (file.taskId && file.role) return `${file.taskId} · ${file.role}`;
  return file.role || file.taskId || file.name;
}

// ─── StatCard component ───

function StatCard({ icon, label, value, color }: {
  icon: React.ReactNode;
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border border-border-default bg-bg-secondary">
      <div className={`${color}`}>{icon}</div>
      <div className="flex flex-col">
        <span className="text-xs text-text-tertiary">{label}</span>
        <span className="text-lg font-semibold text-text-primary">{value}</span>
      </div>
    </div>
  );
}

// ─── FileCard component ───

function FileCard({ file, isSelected, onClick }: {
  file: ScratchpadFile;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className={`
        p-3 rounded-lg border transition-all duration-200 cursor-pointer
        ${isSelected
          ? 'border-accent-brand bg-accent-brand/5 shadow-sm'
          : 'border-border-default bg-bg-secondary hover:bg-bg-tertiary'
        }
      `}
      onClick={onClick}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <FileText size={14} className="text-accent-brand shrink-0"/>
        <span className="font-medium text-sm text-text-primary flex-1 truncate">
          {getFileTitle(file)}
        </span>
        {isSelected ? <ChevronDown size={14} className="text-text-tertiary"/> : <ChevronRight size={14} className="text-text-tertiary"/>}
      </div>

      {/* Metadata */}
      <div className="flex items-center gap-3 text-xs text-text-tertiary">
        {file.taskId && (
          <span className="flex items-center gap-1">
            <Target size={10}/>
            {file.taskId}
          </span>
        )}
        {file.role && (
          <span className="flex items-center gap-1">
            <User size={10}/>
            {file.role}
          </span>
        )}
        <span className="flex items-center gap-1">
          <Calendar size={10}/>
          {formatRelativeTime(file.updatedAt)}
        </span>
      </div>
    </div>
  );
}

// ─── FileDetail component ───

function FileDetail({ file, sessionId, onClose }: {
  file: string;
  sessionId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<{ content: string }>(`/scratchpad/${sessionId}/${encodeURIComponent(file)}`)
      .then((data) => {
        if (cancelled) return;
        setContent(data.content || '');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t('artifacts.error'));
        setContent('');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [file, sessionId, t]);

  return (
    <div className="mt-3 p-4 rounded-lg border border-border-default bg-bg-secondary">
      <div className="flex items-center mb-3 border-b border-border-default pb-2">
        <span className="text-sm font-medium text-text-primary truncate">{file}</span>
        <button
          onClick={onClose}
          className="ml-auto px-3 py-1.5 rounded-md text-sm text-text-tertiary hover:bg-bg-tertiary transition-all duration-200"
        >
          {t('artifacts.close')}
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-text-tertiary">
          <Loader2 size={16} className="animate-spin"/>
          {t('artifacts.loading')}
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 text-accent-red">
          <XCircle size={16}/>
          {error}
        </div>
      )}
      {!loading && !error && (
        <div className="prose prose-sm prose-invert max-w-none text-text-primary overflow-auto max-h-96">
          {content
            ? <SafeMarkdown>{content}</SafeMarkdown>
            : <span className="text-xs text-text-tertiary">{t('artifacts.empty.subtitle')}</span>}
        </div>
      )}
    </div>
  );
}

// ─── Main ArtifactsView component ───

export function ArtifactsView() {
  const { t } = useTranslation();
  const sessionId = useSessionStore(state => state.sessionId);
  const [files, setFiles] = useState<ScratchpadFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(sessionId);

  // 过滤状态
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const loadFiles = useCallback(async () => {
    const requestSessionId = sessionId;
    sessionRef.current = requestSessionId;
    if (!requestSessionId) {
      setFiles([]);
      setSelectedFile(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ files: ScratchpadFile[] }>(`/scratchpad/${requestSessionId}`);
      if (sessionRef.current !== requestSessionId) return;
      setFiles(data.files || []);
      setSelectedFile((current) => current && (data.files || []).some((file) => file.name === current) ? current : null);
    } catch (err) {
      if (sessionRef.current !== requestSessionId) return;
      setError(err instanceof Error ? err.message : t('artifacts.error'));
      setFiles([]);
    } finally {
      if (sessionRef.current === requestSessionId) setLoading(false);
    }
  }, [sessionId, t]);

  useEffect(() => {
    sessionRef.current = sessionId;
    setFiles([]);
    setSelectedFile(null);
    setError(null);
    setLoading(Boolean(sessionId));
    loadFiles();
  }, [loadFiles]);

  // 角色枚举（用于过滤）
  const roles = useMemo(() => {
    const set = new Set<string>();
    files.forEach(f => { if (f.role) set.add(f.role); });
    return Array.from(set).sort();
  }, [files]);

  // 过滤逻辑
  const filteredFiles = useMemo(() => {
    return files.filter(file => {
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const matchName = file.name.toLowerCase().includes(query);
        const matchTaskId = (file.taskId || '').toLowerCase().includes(query);
        if (!matchName && !matchTaskId) return false;
      }
      if (roleFilter !== 'all' && file.role !== roleFilter) return false;
      return true;
    });
  }, [files, searchQuery, roleFilter]);

  // Stats
  const stats = useMemo(() => ({
    total: filteredFiles.length,
    tasks: new Set(filteredFiles.map(f => f.taskId).filter(Boolean)).size,
    roles: new Set(filteredFiles.map(f => f.role).filter(Boolean)).size,
  }), [filteredFiles]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8 text-text-tertiary">
        <Loader2 size={24} className="animate-spin mr-2"/>
        {t('artifacts.loading')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center p-8 text-accent-red">
        <XCircle size={24} className="mr-2"/>
        {error}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-text-tertiary">
        <FileText size={48} className="mb-3 opacity-50"/>
        <p className="text-sm">{t('artifacts.empty.title')}</p>
        <p className="text-xs mt-1">{t('artifacts.empty.subtitle')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Stats cards */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard icon={<FileText size={16}/>} label={t('artifacts.stats.total')} value={stats.total} color="text-text-primary"/>
        <StatCard icon={<Target size={16}/>} label={t('artifacts.stats.tasks')} value={stats.tasks} color="text-accent-brand"/>
        <StatCard icon={<User size={16}/>} label={t('artifacts.stats.roles')} value={stats.roles} color="text-accent-green"/>
      </div>

      {/* Search bar */}
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"/>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('artifacts.search.placeholder')}
          className="w-full pl-10 pr-10 py-2 text-sm bg-bg-secondary border border-border-default rounded-lg text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-brand transition-colors"
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={16}/>
          </button>
        )}
      </div>

      {/* Filters */}
      {roles.length > 0 && (
        <div className="flex items-center gap-3 p-3 bg-bg-secondary rounded-lg border border-border-default">
          <Filter size={14} className="text-text-tertiary"/>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-text-tertiary">{t('artifacts.filter.role')}:</span>
            <div className="flex gap-1 flex-wrap">
              {['all', ...roles].map(role => (
                <button
                  key={role}
                  onClick={() => setRoleFilter(role)}
                  className={`
                    px-2 py-1 text-xs rounded transition-all duration-200
                    ${roleFilter === role
                      ? 'bg-accent-brand text-white'
                      : 'bg-bg-tertiary text-text-tertiary hover:bg-bg-hover'
                    }
                  `}
                >
                  {role === 'all' ? t('artifacts.filter.all') : role}
                </button>
              ))}
            </div>
          </div>

          {(roleFilter !== 'all' || searchQuery) && (
            <button
              onClick={() => {
                setRoleFilter('all');
                setSearchQuery('');
              }}
              className="ml-auto text-xs text-accent-brand hover:underline"
            >
              {t('artifacts.filter.reset')}
            </button>
          )}
        </div>
      )}

      {/* Files list */}
      <div className="flex flex-col gap-2">
        {filteredFiles.map(file => (
          <div key={file.name}>
            <FileCard
              file={file}
              isSelected={selectedFile === file.name}
              onClick={() => setSelectedFile(selectedFile === file.name ? null : file.name)}
            />
            {selectedFile === file.name && sessionId && (
              <FileDetail
                file={file.name}
                sessionId={sessionId}
                onClose={() => setSelectedFile(null)}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
