/**
 * RewindDialog 键处理 + 纯展示辅助。
 *
 * 镜像 useCommandArgPickerKeyHandler：自包含对话框由 re-dispatch 驱动——
 * 选择 → 把 `/rewind <args>` 写入 inputBuffer → submit → handler 跑异步 → 返回 rewind_modal 下一阶段。
 *
 * 本文件不含 React，仅导出状态类型、阶段可选项计算、结果合并与键处理，
 * 供 RewindDialog.tsx（渲染）与 useTuiKeyController（分发）共享。
 */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type {
  CommandRewindModalResult,
  RewindCheckpointSummary,
  RewindPreview,
  RewindScope,
} from '../../../commands/types.js';
import type { KeyLike } from '../useTuiKeyController.js';

export interface RewindWorkingSummary {
  fileCount: number;
  additions: number;
  deletions: number;
}

export interface RewindDialogState {
  stage: 'pick' | 'scope' | 'confirm';
  /** pick 阶段全量检查点；scope/confirm 阶段为 [选中检查点] */
  checkpoints: RewindCheckpointSummary[];
  /** pick 阶段工作区未提交摘要（null 表示工作区干净） */
  workingChangesSummary: RewindWorkingSummary | null;
  /** 选中的检查点 id（scope/confirm 阶段；'working' 表丢弃未提交） */
  selectedCheckpointId?: string;
  /** 选中的范围（confirm 阶段） */
  selectedScope?: RewindScope;
  /** db-only 检查点：scope 仅允许 conversation */
  isDbOnly?: boolean;
  /** scope/confirm 阶段的影响预览 */
  preview?: RewindPreview;
  /** scope/confirm 阶段的跨会话冲突警告 */
  crossSession?: { hasOtherSessionChanges: boolean; otherSessionIds: string[] };
  /** live Leader 是否在运行 */
  leaderBusy?: boolean;
  /** 当前行（pick=检查点序，scope=范围序，confirm=[confirm,cancel]） */
  cursor: number;
  /** pick 阶段过滤串 */
  filter: string;
}

export interface RewindDialogKeyOptions {
  rewindDialogStateRef: MutableRefObject<RewindDialogState | null>;
  setRewindDialogState: Dispatch<SetStateAction<RewindDialogState | null>>;
  inputBufferRef: MutableRefObject<string>;
  setInputBuffer: Dispatch<SetStateAction<string>>;
  handleSubmitRef: MutableRefObject<() => Promise<void>>;
}

/** 单阶段可选行（pick=检查点, scope=范围, confirm=动作）。 */
export interface RewindStageRow {
  id: string;
  /** scope 阶段的固定范围名（'all'|'code'|'conversation'），其余为 undefined */
  scope?: RewindScope;
}

/**
 * 计算当前阶段的可选行（受 pick 阶段 filter 影响）。
 * 键处理用其长度做游标钳制、用其 id 组合命令；组件用其渲染高亮。
 */
export function getRewindStageRows(state: RewindDialogState): RewindStageRow[] {
  if (state.stage === 'pick') {
    const q = state.filter.trim().toLowerCase();
    const rows: RewindStageRow[] = [];
    if (state.workingChangesSummary && !q) {
      rows.push({ id: 'working' });
    }
    for (const cp of state.checkpoints) {
      if (!q || cp.label.toLowerCase().includes(q) || cp.id.toLowerCase().includes(q)) {
        rows.push({ id: cp.id });
      }
    }
    return rows;
  }
  if (state.stage === 'scope') {
    return state.isDbOnly
      ? [{ id: 'conversation', scope: 'conversation' }]
      : [
        { id: 'all', scope: 'all' },
        { id: 'code', scope: 'code' },
        { id: 'conversation', scope: 'conversation' },
      ];
  }
  // confirm
  return [{ id: 'confirm' }, { id: 'cancel' }];
}

function clampCursor(cursor: number, count: number): number {
  return Math.min(Math.max(0, cursor), Math.max(0, count - 1));
}

/**
 * 把 CommandRewindModalResult 合并进对话框状态（保留 pick 阶段 filter）。
 * 每次 handler 返回新阶段都重置游标。
 */
export function mergeRewindResult(
  prev: RewindDialogState | null,
  result: CommandRewindModalResult,
): RewindDialogState {
  const prevCheckpoints = prev?.checkpoints ?? [];
  const stage = result.stage;
  return {
    stage,
    checkpoints: result.checkpoints ?? prevCheckpoints,
    workingChangesSummary: result.workingChangesSummary ?? prev?.workingChangesSummary ?? null,
    selectedCheckpointId: result.checkpointId ?? prev?.selectedCheckpointId,
    selectedScope: result.scope ?? prev?.selectedScope,
    isDbOnly: result.isDbOnly ?? prev?.isDbOnly,
    preview: result.preview ?? prev?.preview,
    crossSession: result.crossSession ?? prev?.crossSession,
    leaderBusy: result.leaderBusy ?? prev?.leaderBusy,
    cursor: 0,
    // 仅 pick 阶段保留已输入的过滤串
    filter: stage === 'pick' ? (prev?.filter ?? '') : '',
  };
}

function dispatchCommand(cmd: string, opts: RewindDialogKeyOptions): void {
  opts.setRewindDialogState(null);
  opts.inputBufferRef.current = cmd;
  opts.setInputBuffer(cmd);
  opts.handleSubmitRef.current();
}

/**
 * Returns true if the key was consumed by the rewind dialog.
 */
export function handleRewindDialogKey(key: KeyLike, opts: RewindDialogKeyOptions): boolean {
  const { rewindDialogStateRef, setRewindDialogState, inputBufferRef, setInputBuffer, handleSubmitRef } = opts;
  const state = rewindDialogStateRef.current;
  if (!state) return false;

  const rows = getRewindStageRows(state);
  const cursor = clampCursor(state.cursor, rows.length);

  if (key.name === 'escape') {
    setRewindDialogState(null);
    return true;
  }

  if (key.name === 'return') {
    const row = rows[cursor];
    if (!row) {
      setRewindDialogState(null);
      return true;
    }
    const cpId = state.selectedCheckpointId;
    if (state.stage === 'pick') {
      dispatchCommand(`/rewind ${row.id}`, opts);
    } else if (state.stage === 'scope') {
      if (cpId && row.scope) dispatchCommand(`/rewind ${cpId} ${row.scope}`, opts);
      else setRewindDialogState(null);
    } else {
      // confirm
      if (row.id === 'confirm' && cpId && state.selectedScope) {
        dispatchCommand(`/rewind ${cpId} ${state.selectedScope} confirm`, opts);
      } else {
        setRewindDialogState(null); // cancel
      }
    }
    return true;
  }

  if (key.name === 'up') {
    setRewindDialogState((prev) => prev ? { ...prev, cursor: Math.max(0, prev.cursor - 1) } : null);
    return true;
  }
  if (key.name === 'down') {
    setRewindDialogState((prev) => {
      if (!prev) return null;
      const count = getRewindStageRows(prev).length;
      return { ...prev, cursor: clampCursor(prev.cursor + 1, count) };
    });
    return true;
  }

  // pick 阶段才支持过滤 / 退格 / 数字直达
  if (state.stage === 'pick') {
    if (key.name === 'backspace' || key.sequence === '\x7f') {
      setRewindDialogState((prev) => prev ? { ...prev, filter: prev.filter.slice(0, -1), cursor: 0 } : null);
      return true;
    }
    if (!key.ctrl && !key.meta && key.sequence && key.sequence.length === 1) {
      const num = parseInt(key.sequence, 10);
      if (!Number.isNaN(num) && num >= 1 && num <= 9) {
        const row = rows[num - 1];
        if (row) dispatchCommand(`/rewind ${row.id}`, opts);
        return true;
      }
      if (/^[a-zA-Z0-9_\-./]$/.test(key.sequence)) {
        const sequence = key.sequence;
        setRewindDialogState((prev) => prev ? { ...prev, filter: prev.filter + sequence, cursor: 0 } : null);
        return true;
      }
    }
  }

  return true;
}
