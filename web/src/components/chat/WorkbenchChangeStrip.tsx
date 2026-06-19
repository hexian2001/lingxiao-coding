import { useEffect, useMemo, useState } from 'react';
import { Check, Clipboard, FileEdit, GitBranch, GitCommit, MoreHorizontal, RefreshCw, Route, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useViewStore } from '../../stores/viewStore';
import type { WorkbenchContext } from './workbenchTypes';

interface WorkbenchChangeStripProps {
  context: WorkbenchContext | null;
  isLoading: boolean;
  onRefresh: () => void;
  onGuideChanges?: (prompt: string) => void;
  onCommitNudge?: (prompt: string) => Promise<void> | void;
}

function buildChangePrompt(input: {
  branch: string;
  changed: number;
  additions: number;
  deletions: number;
  workspace: string;
}): string {
  return [
    `请审查当前 Git 变更并给我一个可执行的收尾方案。`,
    `工作区: ${input.workspace}`,
    `分支: ${input.branch}`,
    `变更: ${input.changed} 个文件，+${input.additions} -${input.deletions}`,
    '',
    '要求:',
    '1. 先检查 diff，识别风险、遗漏和需要验证的点。',
    '2. 给出简洁的提交说明建议。',
    '3. 如果适合提交，说明应 stage 哪些文件和 commit message；不确定时先问我确认。',
  ].join('\n');
}

function buildCommitNudge(input: {
  branch: string;
  changed: number;
  additions: number;
  deletions: number;
  workspace: string;
}): string {
  return [
    '[NON_INTERRUPTING_GUIDANCE]',
    '等当前模型运行到安全点后，请处理当前 Git 变更收尾，但不要打断正在进行的推理/工具执行。',
    `工作区: ${input.workspace}`,
    `分支: ${input.branch}`,
    `变更: ${input.changed} 个文件，+${input.additions} -${input.deletions}`,
    '',
    '请先审查 diff 和未暂存/已暂存状态，生成高质量 commit message。',
    '如果变更范围清晰且无需用户确认，请完成 stage + commit；如果有风险或范围不清，请先向用户确认。',
  ].join('\n');
}

export default function WorkbenchChangeStrip({
  context,
  isLoading,
  onRefresh,
  onGuideChanges,
  onCommitNudge,
}: WorkbenchChangeStripProps) {
  const { t } = useTranslation();
  const setMainView = useViewStore((s) => s.setMainView);
  const changed = context?.git.counts.total ?? 0;
  const additions = context?.git.diff.additions ?? 0;
  const deletions = context?.git.diff.deletions ?? 0;
  const branch = context?.git.status?.branch || 'git';
  const workspace = context?.workspace.path || context?.workspace.name || 'workspace';
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<'commit' | 'copy' | null>(null);

  const signature = `${context?.git.isRepo ? 'repo' : 'no-repo'}:${branch}:${changed}:${additions}:${deletions}:${workspace}`;
  useEffect(() => {
    if (dismissedSignature && dismissedSignature !== signature) {
      setDismissedSignature(null);
    }
  }, [dismissedSignature, signature]);

  const promptInput = useMemo(() => ({
    branch,
    changed,
    additions,
    deletions,
    workspace,
  }), [additions, branch, changed, deletions, workspace]);

  const guidePrompt = useMemo(() => buildChangePrompt(promptInput), [promptInput]);
  const commitPrompt = useMemo(() => buildCommitNudge(promptInput), [promptInput]);

  if (dismissedSignature === signature) return null;

  if (!context?.git.isRepo) {
    return (
      <div className="composer-native-strip" role="status">
        <div className="composer-native-strip-main">
          <GitBranch size={14} />
          <span className="truncate">{context?.workspace.name || 'workspace'} {t('git.noGitDir', 'has no .git directory')}</span>
        </div>
        <button type="button" onClick={() => setMainView('git')} className="composer-native-action">
          {t('git.init', 'Init')}
        </button>
      </div>
    );
  }

  if (changed === 0) return null;

  const handleCommitNudge = async () => {
    if (!onCommitNudge || busyAction) return;
    setBusyAction('commit');
    try {
      await onCommitNudge(commitPrompt);
    } finally {
      setBusyAction(null);
    }
  };

  const handleCopyPrompt = async () => {
    setBusyAction('copy');
    try {
      await navigator.clipboard?.writeText(guidePrompt);
    } finally {
      window.setTimeout(() => setBusyAction(null), 650);
    }
  };

  return (
    <div className="composer-native-strip" role="status">
      <button
        type="button"
        onClick={() => setMainView('git')}
        className="composer-native-branch"
        title={branch}
      >
        <GitBranch size={14} className="shrink-0" />
        <span className="truncate">{branch}</span>
      </button>
      <button
        type="button"
        onClick={() => setMainView('changes')}
        className="composer-native-strip-main"
      >
        <FileEdit size={14} />
        <span>{t('composer.changedFiles', '{{count}} 个文件已更改', { count: changed })}</span>
        <span className="text-accent-green">+{additions}</span>
        <span className="text-accent-red">-{deletions}</span>
      </button>
      <button
        type="button"
        onClick={handleCommitNudge}
        disabled={!onCommitNudge || busyAction === 'commit'}
        className="composer-native-action is-primary"
        title={t('composer.commitNudgeTooltip', '提交，但不中断模型运行')}
      >
        {busyAction === 'commit' ? <RefreshCw size={13} className="animate-spin" /> : <GitCommit size={13} />}
        <span>{t('composer.commitWithoutInterrupt', '提交，但不中断模型运行')}</span>
      </button>
      <button
        type="button"
        onClick={() => onGuideChanges?.(guidePrompt)}
        className="composer-native-action"
      >
        <Route size={13} />
        <span>{t('composer.guide', '引导')}</span>
      </button>
      <button
        type="button"
        onClick={() => setDismissedSignature(signature)}
        className="composer-native-icon"
        title={t('composer.dismiss', '删除')}
      >
        <Trash2 size={13} />
      </button>
      <div className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="composer-native-icon"
          title={t('composer.more', '更多')}
        >
          <MoreHorizontal size={14} />
        </button>
        {menuOpen && (
          <div className="composer-native-menu">
            <button type="button" onClick={() => { setMainView('changes'); setMenuOpen(false); }}>
              <FileEdit size={13} />
              <span>{t('composer.openChanges', '打开变更')}</span>
            </button>
            <button type="button" onClick={() => { setMainView('git'); setMenuOpen(false); }}>
              <GitBranch size={13} />
              <span>{t('composer.openGit', '打开 Git')}</span>
            </button>
            <button type="button" onClick={() => { onRefresh(); setMenuOpen(false); }}>
              <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
              <span>{t('composer.refresh', '刷新')}</span>
            </button>
            <button type="button" onClick={() => void handleCopyPrompt()}>
              {busyAction === 'copy' ? <Check size={13} /> : <Clipboard size={13} />}
              <span>{t('composer.copyGuidePrompt', '复制引导提示')}</span>
            </button>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onRefresh}
        className="composer-native-icon"
        title={t('composer.refresh', '刷新')}
      >
        <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
      </button>
    </div>
  );
}
