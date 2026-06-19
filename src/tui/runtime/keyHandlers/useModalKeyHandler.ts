import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { getDAGSelectableItems } from '../../DAGPanel.js';
import {
  getFlatSettingsEntries, getSettingsItemCount,
  EMPTY_SETTINGS_EDIT, type SettingsEditState,
} from '../../SettingsPanel.js';
import {
  config as runtimeConfig, setConfigValue, saveSettings, ConfigSchema,
} from '../../../config.js';
import { t, setLanguage, type Language } from '../../../i18n.js';
import type {
  CommandItemsModalResult,
  CommandReportModalResult,
  CommandResumeModalResult,
  CommandTaskData,
} from '../../../commands/types.js';
import type { WorkerBackend } from '../../../contracts/types/Agent.js';
import type { KeyLike } from '../useTuiKeyController.js';

interface ReportModalData {
  title?: string;
  report?: string;
}

type TuiModalData = CommandResumeModalResult | CommandItemsModalResult | CommandReportModalResult | ReportModalData | null;
type ExistingModalData = CommandResumeModalResult | CommandItemsModalResult | null;
type TuiModalDataSetterInput = TuiModalData | ((prev: ExistingModalData) => ExistingModalData);
type TuiModalDataSetter = (value: TuiModalDataSetterInput) => void;

interface LaunchedAgent {
  name: string;
  role: string;
  taskId: string;
  backend?: WorkerBackend;
  externalSessionId?: string;
  pid?: number;
}

export interface ModalKeyOptions {
  modalTypeRef: MutableRefObject<string | null>;
  modalCursorRef: MutableRefObject<number>;
  setModalType: Dispatch<SetStateAction<string | null>>;
  setModalCursor: Dispatch<SetStateAction<number>>;
  setModalData: TuiModalDataSetter;
  modalSync: {
    handleEnter: () => void;
    handleUp: () => boolean;
    handleDown: () => boolean;
    handlePageUp: (step: number) => boolean;
    handlePageDown: (step: number) => boolean;
  };
  sortedTasksRef: MutableRefObject<CommandTaskData[]>;
  launchedAgentsRef: MutableRefObject<LaunchedAgent[]>;
  sortedTasks: CommandTaskData[];
  launchedAgents: LaunchedAgent[];
  ensureChannelRef: MutableRefObject<(name: string, role?: string, taskId?: string) => void>;
  switchTabRef: MutableRefObject<(name: string) => void>;
  inputBufferRef: MutableRefObject<string>;
  onOpenGit?: () => void;
  dagModalPageSize: number;
  settingsEditStateRef?: MutableRefObject<SettingsEditState>;
  setSettingsEditState?: Dispatch<SetStateAction<SettingsEditState>>;
  onSettingsFeedback?: (text: string, type: 'success' | 'error') => void;
  onLanguageChanged?: () => void;
}

/** Toggle modal shortcuts (Ctrl+X, Ctrl+E, Ctrl+N, etc). Returns true if consumed. */
export function handleModalToggleKey(key: KeyLike, opts: ModalKeyOptions): boolean {
  const { setModalType, setModalCursor, inputBufferRef, onOpenGit, settingsEditStateRef, setSettingsEditState } = opts;

  // Helper: reset settings edit state when leaving settings modal
  const resetSettingsIfActive = () => {
    if (settingsEditStateRef?.current?.editing && setSettingsEditState) {
      setSettingsEditState(EMPTY_SETTINGS_EDIT);
    }
  };

  if (key.name === 'x' && key.ctrl) {
    resetSettingsIfActive();
    setModalType(prev => prev === 'dag' ? null : 'dag');
    setModalCursor(0);
    return true;
  }
  if (key.name === 'e' && key.ctrl && inputBufferRef.current.length === 0) {
    resetSettingsIfActive();
    setModalType(prev => prev === 'team' ? null : 'team');
    setModalCursor(0);
    return true;
  }
  if (key.name === 'n' && key.ctrl && inputBufferRef.current.length === 0) {
    resetSettingsIfActive();
    setModalType(prev => prev === 'notifications' ? null : 'notifications');
    setModalCursor(0);
    return true;
  }
  if (key.name === 'w' && key.ctrl && inputBufferRef.current.length === 0) {
    resetSettingsIfActive();
    setModalType(prev => prev === 'workNotes' ? null : 'workNotes');
    setModalCursor(0);
    return true;
  }
  if (key.name === 'g' && key.ctrl && inputBufferRef.current.length === 0) {
    resetSettingsIfActive();
    setModalCursor(0);
    setModalType(prev => {
      if (prev === 'git') return null;
      onOpenGit?.();
      return 'git';
    });
    return true;
  }
  return false;
}

/** Handle navigation keys when a modal is open. Returns true if consumed. */
export function handleModalNavigationKey(key: KeyLike, opts: ModalKeyOptions): boolean {
  const {
    modalTypeRef,
    modalCursorRef,
    setModalType,
    setModalCursor,
    setModalData,
    modalSync,
    sortedTasksRef,
    launchedAgentsRef,
    sortedTasks,
    launchedAgents,
    ensureChannelRef,
    switchTabRef,
    dagModalPageSize,
  } = opts;

  if (!modalTypeRef.current) return false;

  // ── Settings panel: intercept all keys when editing ──
  if (modalTypeRef.current === 'settings') {
    return handleSettingsKey(key, opts);
  }

  if (key.name === 'escape') {
    setModalType(null);
    return true;
  }

  if (key.name === 'return' && !key.ctrl && !key.meta) {
    if (modalTypeRef.current === 'dag') {
      const items = getDAGSelectableItems(
        sortedTasksRef.current,
        launchedAgentsRef.current.map(agent => ({ name: agent.name, role: agent.role || 'coding', taskId: agent.taskId })),
      );
      const item = items[modalCursorRef.current];
      if (item) {
        setModalType(null);
        setModalData(null);
        let agentName: string | undefined;
        if (item.kind === 'agent') {
          agentName = item.agent?.name;
        } else if (item.kind === 'task') {
          agentName = item.agentName;
        }
        if (agentName) {
          ensureChannelRef.current(agentName, 'agent', item.kind === 'task' ? item.task?.id : undefined);
          switchTabRef.current(agentName);
        }
      }
    } else {
      modalSync.handleEnter();
    }
    return true;
  }

  if (key.name === 'up') {
    if (modalSync.handleUp()) return true;
    setModalCursor(prev => Math.max(0, prev - 1));
    return true;
  }
  if (key.name === 'down') {
    if (modalSync.handleDown()) return true;
    // Default cursor movement when the active modal has no custom handler.
    setModalCursor(prev => prev + 1);
    return true;
  }

  if (key.name === 'right' && !key.ctrl && !key.meta) {
    if (modalTypeRef.current === 'dag') {
      const items = getDAGSelectableItems(
        sortedTasks,
        launchedAgents.map(agent => ({ name: agent.name, role: agent.role || 'coding', taskId: agent.taskId })),
      );
      const nextCursor = Math.min(modalCursorRef.current + dagModalPageSize, items.length - 1);
      setModalCursor(nextCursor);
      return true;
    }
    if (modalSync.handlePageDown(dagModalPageSize)) return true;
    return true;
  }
  if (key.name === 'left' && !key.ctrl && !key.meta) {
    if (modalTypeRef.current === 'dag') {
      const nextCursor = Math.max(0, modalCursorRef.current - dagModalPageSize);
      setModalCursor(nextCursor);
      return true;
    }
    if (modalSync.handlePageUp(dagModalPageSize)) return true;
    return true;
  }

  if (key.name === 'pageup') {
    if (modalSync.handlePageUp(dagModalPageSize)) return true;
    const nextCursor = Math.max(0, modalCursorRef.current - dagModalPageSize);
    setModalCursor(nextCursor);
    return true;
  }
  if (key.name === 'pagedown') {
    if (modalTypeRef.current === 'dag') {
      const items = getDAGSelectableItems(
        sortedTasks,
        launchedAgents.map(agent => ({ name: agent.name, role: agent.role || 'coding', taskId: agent.taskId })),
      );
      const nextCursor = Math.min(modalCursorRef.current + dagModalPageSize, items.length - 1);
      setModalCursor(nextCursor);
    } else {
      if (modalSync.handlePageDown(dagModalPageSize)) return true;
      setModalCursor(modalCursorRef.current + dagModalPageSize);
    }
    return true;
  }

  return false;
}

// ── Settings Panel Key Handler ──

function handleSettingsKey(key: KeyLike, opts: ModalKeyOptions): boolean {
  const {
    modalCursorRef,
    setModalType,
    setModalCursor,
    settingsEditStateRef,
    setSettingsEditState,
    onSettingsFeedback,
    onLanguageChanged,
  } = opts;

  if (!settingsEditStateRef || !setSettingsEditState) return false;

  const editState = settingsEditStateRef.current;
  const itemCount = getSettingsItemCount();

  // ─── Editing mode: intercept all keys ───
  if (editState.editing) {
    if (key.name === 'escape') {
      // Cancel editing
      setSettingsEditState(EMPTY_SETTINGS_EDIT);
      return true;
    }
    if (key.name === 'return' && !key.ctrl && !key.meta) {
      // Save
      settingsSave(modalCursorRef.current, editState.editText, onSettingsFeedback, onLanguageChanged);
      setSettingsEditState(EMPTY_SETTINGS_EDIT);
      return true;
    }
    if (key.name === 'backspace') {
      if (editState.editCursor > 0) {
        const text = editState.editText;
        const cur = editState.editCursor;
        setSettingsEditState({
          editing: true,
          editText: text.slice(0, cur - 1) + text.slice(cur),
          editCursor: cur - 1,
        });
      }
      return true;
    }
    if (key.name === 'delete') {
      const text = editState.editText;
      const cur = editState.editCursor;
      if (cur < text.length) {
        setSettingsEditState({
          editing: true,
          editText: text.slice(0, cur) + text.slice(cur + 1),
          editCursor: cur,
        });
      }
      return true;
    }
    if (key.name === 'left' && !key.ctrl && !key.meta) {
      setSettingsEditState({
        ...editState,
        editCursor: Math.max(0, editState.editCursor - 1),
      });
      return true;
    }
    if (key.name === 'right' && !key.ctrl && !key.meta) {
      setSettingsEditState({
        ...editState,
        editCursor: Math.min(editState.editText.length, editState.editCursor + 1),
      });
      return true;
    }
    if (key.name === 'home' || (key.name === 'a' && key.ctrl)) {
      setSettingsEditState({ ...editState, editCursor: 0 });
      return true;
    }
    if (key.name === 'end' || (key.name === 'e' && key.ctrl)) {
      setSettingsEditState({ ...editState, editCursor: editState.editText.length });
      return true;
    }
    // Printable character insert
    if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
      const text = editState.editText;
      const cur = editState.editCursor;
      setSettingsEditState({
        editing: true,
        editText: text.slice(0, cur) + key.sequence + text.slice(cur),
        editCursor: cur + 1,
      });
      return true;
    }
    return true; // eat all other keys in edit mode
  }

  // ─── Navigation mode ───
  if (key.name === 'escape') {
    setSettingsEditState(EMPTY_SETTINGS_EDIT);
    setModalType(null);
    return true;
  }
  if (key.name === 'up') {
    setModalCursor(prev => Math.max(0, prev - 1));
    return true;
  }
  if (key.name === 'down') {
    setModalCursor(prev => Math.min(itemCount - 1, prev + 1));
    return true;
  }
  if (key.name === 'return' && !key.ctrl && !key.meta) {
    settingsActivateEdit(modalCursorRef.current, settingsEditStateRef, setSettingsEditState, onSettingsFeedback, onLanguageChanged);
    return true;
  }
  // Space also toggles booleans directly
  if (key.sequence === ' ' && !key.ctrl && !key.meta) {
    const entries = getFlatSettingsEntries();
    const entry = entries[modalCursorRef.current];
    if (entry && entry.type === 'boolean') {
      settingsToggleBoolean(modalCursorRef.current, onSettingsFeedback, onLanguageChanged);
      setSettingsEditState({ ...EMPTY_SETTINGS_EDIT }); // trigger re-render
    }
    return true;
  }
  return true; // eat all keys when settings modal is open
}

function settingsActivateEdit(
  cursorIndex: number,
  editStateRef: MutableRefObject<SettingsEditState>,
  setEditState: Dispatch<SetStateAction<SettingsEditState>>,
  onFeedback?: (text: string, type: 'success' | 'error') => void,
  onLanguageChanged?: () => void,
): void {
  const entries = getFlatSettingsEntries();
  const entry = entries[cursorIndex];
  if (!entry) return;

  if (entry.type === 'boolean') {
    // Toggle directly
    settingsToggleBoolean(cursorIndex, onFeedback, onLanguageChanged);
    setEditState({ ...EMPTY_SETTINGS_EDIT }); // re-render
    return;
  }

  if (entry.type === 'enum' && entry.enumValues && entry.enumValues.length > 0) {
    // Cycle to next enum value
    const currentVal = String(getValueAtPath(entry.path) ?? '');
    const idx = entry.enumValues.indexOf(currentVal);
    const nextVal = entry.enumValues[(idx + 1) % entry.enumValues.length];
    settingsSave(cursorIndex, nextVal, onFeedback, onLanguageChanged);
    setEditState({ ...EMPTY_SETTINGS_EDIT });
    return;
  }

  // String/number: enter inline edit mode with current value
  const currentVal = String(getValueAtPath(entry.path) ?? '');
  setEditState({
    editing: true,
    editText: currentVal,
    editCursor: currentVal.length,
  });
}

function settingsToggleBoolean(cursorIndex: number, onFeedback?: (text: string, type: 'success' | 'error') => void, onLanguageChanged?: () => void): void {
  const entries = getFlatSettingsEntries();
  const entry = entries[cursorIndex];
  if (!entry) return;
  const current = getValueAtPath(entry.path);
  // Explicit boolean check — avoids corrupting falsy non-boolean values (0, '')
  settingsSave(cursorIndex, current === true ? 'false' : 'true', onFeedback, onLanguageChanged);
}

function settingsSave(cursorIndex: number, valueStr: string, onFeedback?: (text: string, type: 'success' | 'error') => void, onLanguageChanged?: () => void): void {
  const entries = getFlatSettingsEntries();
  const entry = entries[cursorIndex];
  if (!entry) return;

  const currentValue = getValueAtPath(entry.path);
  let parsedValue: unknown = valueStr;

  // Type coercion
  if (entry.type === 'boolean') {
    parsedValue = ['true', '1', 'yes', 'on'].includes(valueStr.toLowerCase());
  } else if (entry.type === 'number') {
    const num = Number(valueStr);
    if (!isNaN(num)) {
      parsedValue = num;
    } else {
      onFeedback?.(t('tui.settings.feedback.invalid_number'), 'error');
      return;
    }
  }
  // enum and string: keep as string

  setConfigValue(entry.path, parsedValue);

  try {
    // Validate before attempting to persist
    ConfigSchema.parse(runtimeConfig);
  } catch {
    // Validation failed: rollback in-memory and abort
    setConfigValue(entry.path, currentValue);
    onFeedback?.(t('tui.settings.feedback.validation_failed'), 'error');
    return;
  }

  try {
    saveSettings(runtimeConfig);
    onFeedback?.(t('tui.settings.feedback.saved', entry.label), 'success');
    // 语言切换即时生效：写盘成功后同步运行时语言状态并触发 UI 重渲染
    if (entry.path === 'ui.language') {
      setLanguage(String(parsedValue) as Language);
      onLanguageChanged?.();
    }
  } catch {
    // IO failure: rollback in-memory to stay consistent with disk
    setConfigValue(entry.path, currentValue);
    onFeedback?.(t('tui.settings.feedback.write_failed'), 'error');
  }
}

function getValueAtPath(path: string): unknown {
  const keys = path.split('.');
  let current: unknown = runtimeConfig;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
