import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { QuestionDialogState } from '../QuestionDialog.js';
import { toggleConstrainHeight } from '../components/ConstrainedBox.js';
import { t } from '../../i18n.js';
import type {
  CommandItemsModalResult,
  CommandLogMessage,
  CommandReportModalResult,
  CommandResumeModalResult,
  CommandTaskData,
} from '../../commands/types.js';
import type { WorkerBackend } from '../../contracts/types/Agent.js';
import type { SuggestionItem } from '../utils.js';
import type { CommandArgPickerState } from './keyHandlers/useCommandArgPickerKeyHandler.js';
import type { RewindDialogState } from './keyHandlers/useRewindDialogKeyHandler.js';
import {
  handleCommandArgPickerKey,
  handleQuestionDialogKeyPress,
  handleRewindDialogKey,
  handleModalToggleKey,
  handleModalNavigationKey,
  acceptSuggestion,
  handleSuggestionUp,
  handleSuggestionDown,
  handleSuggestionEscape,
  handleBackspaceKey,
  handleDeleteKey,
  handleCtrlU,
  handleCtrlK,
  handleCtrlW,
  handleShiftEnter,
  handleCursorMovement,
  handleCharInput,
  handleTabKey,
  handleHistoryNavigation,
  handleAltShortcut,
  type CommandArgPickerKeyOptions,
  type QuestionDialogKeyOptions,
  type RewindDialogKeyOptions,
  type ModalKeyOptions,
  type SuggestionKeyOptions,
  type InputKeyOptions,
  type NavigationKeyOptions,
} from './keyHandlers/index.js';

const CTRL_C_EXIT_WINDOW_MS = 2000;

export interface KeyLike {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

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

export function isCtrlCKey(key: KeyLike): boolean {
  return (key?.name === 'c' && key?.ctrl === true) || key?.sequence === '\x03';
}

export type TuiModeShortcutAction = 'collaboration' | 'route' | 'permission';

export function resolveTuiModeShortcut(key: KeyLike, inputBuffer: string): TuiModeShortcutAction | null {
  if (!key?.meta || inputBuffer.length !== 0) return null;
  if (key.name === 'c') return 'collaboration';
  if (key.name === 'r') return 'route';
  if (key.name === 'p') return 'permission';
  return null;
}

interface UseTuiKeyControllerOptions {
  commandArgPickerStateRef: MutableRefObject<CommandArgPickerState | null>;
  setCommandArgPickerState: Dispatch<SetStateAction<CommandArgPickerState | null>>;
  agentQuestionStateRef: MutableRefObject<QuestionDialogState | null>;
  setAgentQuestionState: Dispatch<SetStateAction<QuestionDialogState | null>>;
  rewindDialogStateRef: MutableRefObject<RewindDialogState | null>;
  setRewindDialogState: Dispatch<SetStateAction<RewindDialogState | null>>;
  inputBufferRef: MutableRefObject<string>;
  setInputBuffer: Dispatch<SetStateAction<string>>;
  inputCursorRef: MutableRefObject<number>;
  setInputCursor: Dispatch<SetStateAction<number>>;
  handleSubmitRef: MutableRefObject<() => Promise<void>>;
  closeSuggestionsRef: MutableRefObject<() => void>;
  handleInterruptRef: MutableRefObject<() => Promise<boolean>>;
  /** 停止指定 Agent（按 name）。ESC 在某个 Agent 渠道时调用它只停这一个。 */
  onStopAgentRef: MutableRefObject<((agentName: string) => Promise<boolean>) | undefined>;
  /** 当前激活渠道：'main' 为 Leader，否则为某 Agent 的渠道名。 */
  currentTabRef: MutableRefObject<string>;
  requestProcessExit: (reason: string) => void;
  appendMessage: (channel: string, message: CommandLogMessage) => void;
  setSubmitting: Dispatch<SetStateAction<boolean>>;
  setModalType: Dispatch<SetStateAction<string | null>>;
  setModalCursor: Dispatch<SetStateAction<number>>;
  setModalData: TuiModalDataSetter;
  onOpenGit?: () => void;
  modalTypeRef: MutableRefObject<string | null>;
  modalCursorRef: MutableRefObject<number>;
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
  suggestionItemsRef: MutableRefObject<SuggestionItem[]>;
  suggestionIndexRef: MutableRefObject<number>;
  setSuggestionIndex: Dispatch<SetStateAction<number>>;
  setSuggestionItems: Dispatch<SetStateAction<SuggestionItem[]>>;
  maybeBuildSuggestions: (value: string) => { items: SuggestionItem[] };
  pendingPastesMapRef: MutableRefObject<Map<string, string>>;
  setPendingPastes: Dispatch<SetStateAction<Map<string, string>>>;
  parsePlaceholder: (placeholder: string) => { charCount: number; id: number } | null;
  freePlaceholderId: (charCount: number, id: number) => void;
  breakHistoryNavigation: () => void;
  navigateInputHistory: (direction: 'up' | 'down') => boolean;
  handleTabSwitchRef: MutableRefObject<(direction: 'next' | 'prev') => void>;
  onToggleCollaborationMode?: () => Promise<void> | void;
  onCycleExecutionRoute?: () => Promise<void> | void;
  onCyclePermissionMode?: () => Promise<void> | void;
  leaderRuntimeQueueLength: number;
  onClearPendingMessages?: () => Promise<void>;
  dagModalPageSize: number;
  settingsEditStateRef: MutableRefObject<import('../../tui/SettingsPanel.js').SettingsEditState>;
  setSettingsEditState: Dispatch<SetStateAction<import('../../tui/SettingsPanel.js').SettingsEditState>>;
  onSettingsFeedback?: (text: string, type: 'success' | 'error') => void;
  onLanguageChanged?: () => void;
  onCopyLastCode?: () => void;
  /** 有选中文本时返回 true 并复制+清除选择，用于 Ctrl+C 优先复制而非中断 */
  onCopySelection?: () => boolean;
  /** 切换鼠标追踪：关闭后终端恢复原生拖拽选中+复制 */
  onToggleMouseTracking?: () => void;
  /** 切换可见区最后一张 thinking/tool 卡片的展开/折叠(无鼠标降级,Ctrl+E) */
  onToggleLastCard?: () => void;
  /** Ctrl+O — 在系统浏览器中打开 Web UI（带 token） */
  onOpenWebUI?: () => void;
}

export function useTuiKeyController(opts: UseTuiKeyControllerOptions): (key: KeyLike) => void {
  const {
    commandArgPickerStateRef,
    setCommandArgPickerState,
    agentQuestionStateRef,
    setAgentQuestionState,
    rewindDialogStateRef,
    setRewindDialogState,
    inputBufferRef,
    setInputBuffer,
    inputCursorRef,
    setInputCursor,
    handleSubmitRef,
    closeSuggestionsRef,
    handleInterruptRef,
    onStopAgentRef,
    currentTabRef,
    requestProcessExit,
    appendMessage,
    setSubmitting,
    setModalType,
    setModalCursor,
    setModalData,
    onOpenGit,
    modalTypeRef,
    modalCursorRef,
    modalSync,
    sortedTasksRef,
    launchedAgentsRef,
    sortedTasks,
    launchedAgents,
    ensureChannelRef,
    switchTabRef,
    suggestionItemsRef,
    suggestionIndexRef,
    setSuggestionIndex,
    setSuggestionItems,
    maybeBuildSuggestions,
    pendingPastesMapRef,
    setPendingPastes,
    parsePlaceholder,
    freePlaceholderId,
    breakHistoryNavigation,
    navigateInputHistory,
    handleTabSwitchRef,
    onToggleCollaborationMode,
    onCycleExecutionRoute,
    onCyclePermissionMode,
    leaderRuntimeQueueLength,
    onClearPendingMessages,
    dagModalPageSize,
    settingsEditStateRef,
    setSettingsEditState,
    onSettingsFeedback,
    onLanguageChanged,
    onCopyLastCode,
    onCopySelection,
    onToggleMouseTracking,
    onToggleLastCard,
    onOpenWebUI,
  } = opts;

  const lastCtrlCAtRef = useRef(0);

  // Build domain-specific option objects
  const pickerOpts: CommandArgPickerKeyOptions = {
    commandArgPickerStateRef, setCommandArgPickerState,
    inputBufferRef, setInputBuffer, handleSubmitRef,
  };
  const questionOpts: QuestionDialogKeyOptions = {
    agentQuestionStateRef, setAgentQuestionState,
    inputBufferRef, setInputBuffer, handleSubmitRef,
  };
  const rewindOpts: RewindDialogKeyOptions = {
    rewindDialogStateRef, setRewindDialogState,
    inputBufferRef, setInputBuffer, handleSubmitRef,
  };
  const modalOpts: ModalKeyOptions = {
    modalTypeRef, modalCursorRef, setModalType, setModalCursor, setModalData,
    modalSync, sortedTasksRef, launchedAgentsRef, sortedTasks, launchedAgents,
    ensureChannelRef, switchTabRef, inputBufferRef, onOpenGit, dagModalPageSize,
    settingsEditStateRef, setSettingsEditState, onSettingsFeedback, onLanguageChanged,
  };
  const suggestionOpts: SuggestionKeyOptions = {
    suggestionItemsRef, suggestionIndexRef, setSuggestionIndex, setSuggestionItems,
    closeSuggestionsRef, inputBufferRef, setInputBuffer, inputCursorRef, setInputCursor,
    maybeBuildSuggestions,
  };
  const inputOpts: InputKeyOptions = {
    inputBufferRef, setInputBuffer, inputCursorRef, setInputCursor,
    pendingPastesMapRef, setPendingPastes, parsePlaceholder, freePlaceholderId,
    breakHistoryNavigation, suggestionOpts,
  };
  const navOpts: NavigationKeyOptions = {
    handleTabSwitchRef, navigateInputHistory, switchTabRef, inputBufferRef,
  };

  return useCallback((key: KeyLike) => {
    // 1. Command arg picker intercepts all keys when active
    if (handleCommandArgPickerKey(key, pickerOpts)) return;

    // 2. Question dialog intercepts all keys when active
    if (handleQuestionDialogKeyPress(key, questionOpts)) return;

    // 2b. Rewind dialog intercepts all keys when active
    if (handleRewindDialogKey(key, rewindOpts)) return;

    // 3. Ctrl+C — if text is selected, copy it; otherwise interrupt/exit
    if (isCtrlCKey(key)) {
      // Selection copy takes priority: copy + clear selection, no interrupt
      if (onCopySelection && onCopySelection()) return;

      const now = Date.now();
      const isSecondPress = now - lastCtrlCAtRef.current <= CTRL_C_EXIT_WINDOW_MS;
      lastCtrlCAtRef.current = now;

      if (isSecondPress) {
        appendMessage('main', { type: 'system', content: t('tui.exit.goodbye') });
        setSubmitting(true);
        setTimeout(() => requestProcessExit('ctrl_c_double'), 0);
        return;
      }

      if (inputBufferRef.current.length > 0) {
        inputBufferRef.current = '';
        setInputBuffer('');
        setInputCursor(0);
        inputCursorRef.current = 0;
        closeSuggestionsRef.current();
        appendMessage('main', { type: 'system', content: t('tui.exit.input_cleared') });
      } else {
        void handleInterruptRef.current().finally(() => {
          appendMessage('main', { type: 'system', content: t('tui.exit.ctrl_c_again') });
        });
      }
      return;
    }

    // 4. Ctrl+Q — immediate exit
    if (key.name === 'q' && key.ctrl) {
      appendMessage('main', { type: 'system', content: t('tui.exit.goodbye') });
      setSubmitting(true);
      setTimeout(() => requestProcessExit('ctrl_q'), 0);
      return;
    }

    // 5. Ctrl+L — clear screen
    if (key.name === 'l' && key.ctrl) {
      process.stdout.write('\x1b[2J\x1b[H');
      return;
    }

    // 6. Ctrl+S — toggle constrain height
    if (key.name === 's' && key.ctrl) { toggleConstrainHeight(); return; }

    // 6b. Ctrl+Y — copy last code block to clipboard
    if (key.name === 'y' && key.ctrl) {
      if (onCopyLastCode) onCopyLastCode();
      return;
    }

    // 6c. Ctrl+T — toggle mouse tracking (off = native terminal selection)
    if (key.name === 't' && key.ctrl) {
      if (onToggleMouseTracking) onToggleMouseTracking();
      return;
    }

    // 6d. Ctrl+E — toggle collapse of the last visible thinking/tool card (no-mouse fallback)
    if (key.name === 'e' && key.ctrl) {
      if (onToggleLastCard) onToggleLastCard();
      return;
    }

    // 6e. Ctrl+O — open Web UI in system browser (with token)
    if (key.name === 'o' && key.ctrl) {
      if (onOpenWebUI) onOpenWebUI();
      return;
    }

    // 7. Modal toggle shortcuts
    if (handleModalToggleKey(key, modalOpts)) return;

    // 8. Alt mode controls only fire from an empty composer.
    const modeShortcut = resolveTuiModeShortcut(key, inputBufferRef.current);
    if (modeShortcut) {
      if (modeShortcut === 'collaboration' && onToggleCollaborationMode) {
        void onToggleCollaborationMode();
        return;
      }
      if (modeShortcut === 'route' && onCycleExecutionRoute) {
        void onCycleExecutionRoute();
        return;
      }
      if (modeShortcut === 'permission' && onCyclePermissionMode) {
        void onCyclePermissionMode();
        return;
      }
    }

    // 9. Alt shortcuts for panel switch
    if (handleAltShortcut(key, navOpts)) return;

    // 10. Enter key — modal action / accept suggestion / submit
    if (key.name === 'return' && !key.ctrl && !key.meta) {
      if (handleModalNavigationKey(key, modalOpts)) return;
      if (acceptSuggestion(suggestionOpts)) return;
      handleSubmitRef.current();
      return;
    }

    // 11. Shift+Enter — insert newline
    if (handleShiftEnter(key, inputOpts)) return;

    // 12. Backspace
    if (handleBackspaceKey(key, inputOpts)) return;

    // 13. Escape — close modal / close suggestions / clear input / clear queue / interrupt
    if (key.name === 'escape') {
      if (handleModalNavigationKey(key, modalOpts)) return;
      if (handleSuggestionEscape(suggestionOpts)) return;
      if (inputBufferRef.current.length) {
        inputBufferRef.current = '';
        setInputBuffer('');
        setInputCursor(0);
        inputCursorRef.current = 0;
        return;
      }
      if (leaderRuntimeQueueLength > 0 && onClearPendingMessages) {
        const queueLen = leaderRuntimeQueueLength;
        void onClearPendingMessages().then(() => {
          appendMessage('main', { type: 'system', content: t('tui.event.queue_cleared', queueLen) });
        });
        return;
      }
      // 焦点在某个 Agent 渠道（非 main）时：ESC 只停这一个 Agent，而非全局中断。
      // 全局中断（Leader + 所有 Agent）仍可在 main 渠道按 ESC 触发。
      const focusedAgent = currentTabRef.current;
      if (focusedAgent !== 'main') {
        const stop = onStopAgentRef.current;
        if (stop) {
          void stop(focusedAgent).then((ok) => {
            if (ok) {
              appendMessage(focusedAgent, { type: 'system', content: t('tui.event.agent_stopped', focusedAgent) });
              appendMessage('main', { type: 'system', content: t('tui.event.agent_stopped', focusedAgent) });
            }
          });
          return;
        }
      }
      handleInterruptRef.current();
      return;
    }

    // 14. Up/Down — modal nav / suggestion nav / history nav
    if (key.name === 'up') {
      if (handleModalNavigationKey(key, modalOpts)) return;
      if (handleSuggestionUp(suggestionOpts)) return;
      handleHistoryNavigation(key, navOpts);
      return;
    }
    if (key.name === 'down') {
      if (handleModalNavigationKey(key, modalOpts)) return;
      if (handleSuggestionDown(suggestionOpts)) return;
      handleHistoryNavigation(key, navOpts);
      return;
    }

    // 15. Left/Right — modal page or cursor movement
    if (key.name === 'right' && !key.ctrl && !key.meta) {
      if (handleModalNavigationKey(key, modalOpts)) return;
      handleCursorMovement(key, inputOpts);
      return;
    }
    if (key.name === 'left' && !key.ctrl && !key.meta) {
      if (handleModalNavigationKey(key, modalOpts)) return;
      handleCursorMovement(key, inputOpts);
      return;
    }

    // 16. PageUp/PageDown — modal only
    if (key.name === 'pageup' || key.name === 'pagedown') {
      handleModalNavigationKey(key, modalOpts);
      return;
    }

    // 17. Home/End — cursor movement
    if (key.name === 'home' || key.name === 'end') {
      handleCursorMovement(key, inputOpts);
      return;
    }

    // 18. Delete
    if (handleDeleteKey(key, inputOpts)) return;

    // 19. Tab — switch or accept suggestion; Shift+Tab cycles permission mode.
    if (key.name === 'tab') {
      if (key.shift && onCyclePermissionMode) {
        void onCyclePermissionMode();
        return;
      }
      const result = handleTabKey(key, navOpts, suggestionItemsRef.current.length > 0);
      if (result === 'prev') { handleTabSwitchRef.current('prev'); }
      else if (result === 'suggestion') { acceptSuggestion(suggestionOpts); }
      else if (result === 'next') { handleTabSwitchRef.current('next'); }
      return;
    }

    // 20. Ctrl+U / Ctrl+K / Ctrl+W — line editing
    if (handleCtrlU(key, inputOpts)) return;
    if (handleCtrlK(key, inputOpts)) return;
    if (handleCtrlW(key, inputOpts)) return;

    // 21. Character input
    handleCharInput(key, inputOpts, lastCtrlCAtRef);
  }, [
    agentQuestionStateRef,
    appendMessage,
    breakHistoryNavigation,
    closeSuggestionsRef,
    commandArgPickerStateRef,
    dagModalPageSize,
    ensureChannelRef,
    freePlaceholderId,
    handleInterruptRef,
    handleSubmitRef,
    handleTabSwitchRef,
    inputBufferRef,
    inputCursorRef,
    launchedAgents,
    launchedAgentsRef,
    leaderRuntimeQueueLength,
    maybeBuildSuggestions,
    modalCursorRef,
    modalSync,
    modalTypeRef,
    navigateInputHistory,
    onClearPendingMessages,
    onCycleExecutionRoute,
    onCyclePermissionMode,
    onLanguageChanged,
    onOpenGit,
    onSettingsFeedback,
    onToggleCollaborationMode,
    onToggleLastCard,
    onToggleMouseTracking,
    onOpenWebUI,
    parsePlaceholder,
    pendingPastesMapRef,
    requestProcessExit,
    setAgentQuestionState,
    setCommandArgPickerState,
    setInputBuffer,
    setInputCursor,
    setModalCursor,
    setModalData,
    setModalType,
    setPendingPastes,
    setSettingsEditState,
    settingsEditStateRef,
    setSubmitting,
    setSuggestionIndex,
    setSuggestionItems,
    sortedTasks,
    sortedTasksRef,
    suggestionIndexRef,
    suggestionItemsRef,
    switchTabRef,
  ]);
}
