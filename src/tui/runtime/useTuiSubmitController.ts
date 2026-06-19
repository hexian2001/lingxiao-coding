import { useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import {
  buildSlashHelpText,
  findSlashCommand,
  isCallbackSlashCommand,
  type SlashCommandDefinition,
} from '../../commands/slash_registry.js';
import type {
  CommandInitialChannelSeed,
  CommandItemsModalResult,
  CommandLogMessage,
  CommandReportModalResult,
  CommandResult,
  CommandResumeModalResult,
  CommandSessionStatusData,
  CommandTaskData,
} from '../../commands/types.js';
import { mergeRewindResult, type RewindDialogState } from './keyHandlers/useRewindDialogKeyHandler.js';
import { setLanguage, setSessionLanguage, t } from '../../i18n.js';
import type { WorkerBackend } from '../../contracts/types/Agent.js';
import { createInitialChannelMap } from '../state/channelState.js';
import type { ChannelState } from '../state/types.js';
import {
  expandSubmittedPasteInput,
  parseInterveneCommand,
} from '../utils.js';

type TuiCommandResult = CommandResult | string | void;
type CommandArgItem = ReturnType<NonNullable<SlashCommandDefinition['argCompleter']>>[number];

interface CommandArgPickerState {
  commandName: string;
  items: CommandArgItem[];
  cursor: number;
  filter: string;
}

interface LaunchedAgent {
  name: string;
  role: string;
  taskId: string;
  backend?: WorkerBackend;
  externalSessionId?: string;
  pid?: number;
}

interface ReportModalData {
  title: string;
  report: string;
}

type ExistingModalData = CommandResumeModalResult | CommandItemsModalResult | null;
type SubmitModalData = ExistingModalData | CommandReportModalResult | ReportModalData;
type ModalDataSetterInput = SubmitModalData | ((prev: ExistingModalData) => ExistingModalData);
type ModalDataSetter = { bivarianceHack(value: ModalDataSetterInput): void }['bivarianceHack'];

/** Extended seed with runtime-only fields that the TUI tracks for diagnostics */
interface HydrateChannelSeed extends CommandInitialChannelSeed {
  backend?: WorkerBackend;
  externalSessionId?: string;
  pid?: number;
}

interface UseTuiSubmitControllerOptions {
  inputBufferRef: MutableRefObject<string>;
  submittingRef: MutableRefObject<boolean>;
  currentTabRef: MutableRefObject<string>;
  sessionStatusRef: MutableRefObject<{ status?: string } | null | undefined>;
  pendingPastesMapRef: MutableRefObject<Map<string, string>>;
  activePlaceholderIds: MutableRefObject<Map<number, Set<number>>>;
  setPendingPastes: Dispatch<SetStateAction<Map<string, string>>>;
  setInputBuffer: Dispatch<SetStateAction<string>>;
  setInputCursor: Dispatch<SetStateAction<number>>;
  inputCursorRef: MutableRefObject<number>;
  appendMessage: (channel: string, message: CommandLogMessage) => void;
  flushStreamBuffer: (channel: string) => void;
  updateChannelStreams: (channel: string, streams: { currentStream?: string; currentThinkingStream?: string }) => void;
  onNudge?: (message: string) => Promise<void>;
  setSubmitting: Dispatch<SetStateAction<boolean>>;
  closeSuggestionsRef: MutableRefObject<() => void>;
  resetHistoryNavigation: () => void;
  setInputHistory: Dispatch<SetStateAction<string[]>>;
  inputHistoryRef: MutableRefObject<string[]>;
  setInFlightMessage: Dispatch<SetStateAction<string>>;
  inFlightMessageRef: MutableRefObject<string>;
  setCommandArgPickerState: Dispatch<SetStateAction<CommandArgPickerState | null>>;
  setRewindDialogState: Dispatch<SetStateAction<RewindDialogState | null>>;
  onCommandRef: MutableRefObject<(input: string) => Promise<TuiCommandResult>>;
  onCommand: (input: string) => Promise<TuiCommandResult>;
  onSubmitRef: MutableRefObject<(input: string, target: string) => Promise<void>>;
  setSessionStatus: Dispatch<SetStateAction<CommandSessionStatusData>>;
  setTasks: Dispatch<SetStateAction<CommandTaskData[]>>;
  setChannels: Dispatch<SetStateAction<Record<string, ChannelState>>>;
  setTokenUsage: Dispatch<SetStateAction<{ total: number }>>;
  setAgentTokens: Dispatch<SetStateAction<Record<string, number>>>;
  setLeaderStatus: Dispatch<SetStateAction<string>>;
  setLeaderMode: Dispatch<SetStateAction<'direct' | 'delegate' | 'hybrid' | undefined>>;
  setLeaderModeReason: Dispatch<SetStateAction<string>>;
  setTabOrder: Dispatch<SetStateAction<string[]>>;
  setLaunchedAgents: Dispatch<SetStateAction<LaunchedAgent[]>>;
  setCurrentTab: Dispatch<SetStateAction<string>>;
  setModalType: Dispatch<SetStateAction<string | null>>;
  setModalData: ModalDataSetter;
  setModalCursor: Dispatch<SetStateAction<number>>;
  /** /git —— 异步加载工作区状态后开 git 模态 */
  onLoadGitData?: () => Promise<void>;
  onLanguageChanged?: (lang: 'zh' | 'en') => void;
  requestProcessExit: (reason: string) => void;
  /** Current workspace, used to discover custom slash commands (.lingxiao/commands). */
  workspace?: string;
}

const WORKER_BACKENDS: readonly WorkerBackend[] = ['worker_process', 'claude', 'codex', 'remote'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function readWorkerBackend(value: unknown): WorkerBackend | undefined {
  if (typeof value !== 'string') return undefined;
  return WORKER_BACKENDS.find((backend) => backend === value);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readOptionalPid(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function withHydrateChannelMetadata(seed: CommandInitialChannelSeed): HydrateChannelSeed {
  const backend = readWorkerBackend(recordValue(seed, 'backend'));
  const externalSessionId = readOptionalString(recordValue(seed, 'externalSessionId'));
  const pid = readOptionalPid(recordValue(seed, 'pid'));
  return {
    ...seed,
    ...(backend === undefined ? {} : { backend }),
    ...(externalSessionId === undefined ? {} : { externalSessionId }),
    ...(pid === undefined ? {} : { pid }),
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasCommandContent(result: TuiCommandResult): result is CommandResult {
  return typeof result === 'object'
    && result !== null
    && typeof result.content === 'string'
    && result.content.length > 0;
}

export function useTuiSubmitController(options: UseTuiSubmitControllerOptions): MutableRefObject<() => Promise<void>> {
  const handleSubmitRef = useRef<() => Promise<void>>(async () => {});

  handleSubmitRef.current = async () => {
    let input = options.inputBufferRef.current.trim();
    if (!input) return;

    const submitTarget = options.currentTabRef.current === 'main' ? 'main' : options.currentTabRef.current;

    const isSlashInput = input.startsWith('/');
    if (options.submittingRef.current && isSlashInput) return;

    const hadPendingPastes = options.pendingPastesMapRef.current.size > 0;
    const pasteExpansion = expandSubmittedPasteInput(input, options.pendingPastesMapRef.current);
    input = pasteExpansion.input;

    if (pasteExpansion.unresolvedMarkers.length > 0) {
      options.appendMessage('main', {
        type: 'system',
        content: t('tui.paste.unresolved'),
      });
      return;
    }

    if (hadPendingPastes) {
      options.pendingPastesMapRef.current.clear();
      options.setPendingPastes(new Map());
      options.activePlaceholderIds.current.clear();
    }

    if (isSlashInput) {
      options.setSubmitting(true);
      options.submittingRef.current = true;
    }
    options.closeSuggestionsRef.current();
    options.resetHistoryNavigation();
    if (!input.startsWith('/')) {
      options.setInputHistory((prev) => {
        if (prev[prev.length - 1] === input) return prev;
        const next = [...prev.slice(-99), input];
        options.inputHistoryRef.current = next;
        return next;
      });
    }
    if (pasteExpansion.expandedPlaceholderCount > 0) {
      options.appendMessage('main', {
        type: 'system',
        content: t('tui.paste.expanded', pasteExpansion.expandedPlaceholderCount, pasteExpansion.expandedCharCount),
      });
    }
    const displayChannel = input.startsWith('/') ? 'main' : submitTarget;
    options.flushStreamBuffer(displayChannel);
    options.updateChannelStreams(displayChannel, { currentStream: '', currentThinkingStream: '' });
    options.appendMessage(displayChannel, { type: 'user', content: input });
    options.setInFlightMessage(input);
    options.inFlightMessageRef.current = input;
    options.setInputBuffer('');
    options.setInputCursor(0);
    options.inputCursorRef.current = 0;

    try {
      if (input.startsWith('/')) {
        const cmdToken = input.split(/\s/)[0].toLowerCase();
        const inputArgs = input.slice(cmdToken.length).trim();

        const cmdDef = findSlashCommand(cmdToken, options.workspace);
        if (cmdDef && !inputArgs && cmdDef.argCompleter) {
          const pickerItems = cmdDef.argCompleter('');
          if (pickerItems.length > 0) {
            options.setCommandArgPickerState({ commandName: cmdToken, items: pickerItems, cursor: 0, filter: '' });
            options.setSubmitting(false);
            options.submittingRef.current = false;
            options.setInFlightMessage('');
            options.inFlightMessageRef.current = '';
            return;
          }
        }

        const isCallback = isCallbackSlashCommand(cmdToken, options.workspace);
        if (isCallback) {
          const result = await options.onCommandRef.current(input);
          handleCommandResult(result, options);
        } else {
          await handleBuiltInCommand(input, cmdToken, options);
        }
        options.setInFlightMessage('');
        options.inFlightMessageRef.current = '';
      } else {
        const delivery = options.onSubmitRef.current(input, submitTarget);
        delivery.catch((error: unknown) => {
          options.appendMessage('main', { type: 'system', content: t('tui.command.error', getErrorMessage(error)) });
          options.setInFlightMessage('');
          options.inFlightMessageRef.current = '';
        });
      }
    } catch (error: unknown) {
      options.appendMessage('main', { type: 'system', content: t('tui.command.error', getErrorMessage(error)) });
      options.setInFlightMessage('');
      options.inFlightMessageRef.current = '';
    }
    options.setSubmitting(false);
    options.submittingRef.current = false;
  };

  return handleSubmitRef;
}

function handleCommandResult(result: TuiCommandResult, options: UseTuiSubmitControllerOptions): void {
  if (typeof result === 'string') {
    options.appendMessage('main', { type: 'system', content: result });
  } else if (result && typeof result === 'object') {
    if (result.type === 'system' && result.content) {
      options.appendMessage('main', { type: 'system', content: result.content });
    } else if (result.type === 'code') {
      options.appendMessage('main', { type: 'leader', content: result.content });
    } else if (result.type === 'table') {
      options.appendMessage('main', { type: 'system', content: result.content });
    }
    hydrateIfNeeded(result, options);
    if (result.action === 'resume_modal' || result.action === 'history_modal') {
      options.setModalType(result.action.replace('_modal', ''));
      options.setModalData(result);
      options.setModalCursor(0);
    } else if (result.action === 'report_modal') {
      options.setModalData({ title: result.title, report: result.report });
      options.setModalCursor(0);
      options.setModalType('report');
    } else if (result.action === 'rewind_modal') {
      // 三阶段自包含对话框：合并 handler 返回的异步负载，每阶段重置游标。
      options.setRewindDialogState((prev) => mergeRewindResult(prev, result));
    }
  }
}

async function handleBuiltInCommand(input: string, normalizedCmd: string, options: UseTuiSubmitControllerOptions): Promise<void> {
  switch (normalizedCmd) {
    case '/help':
      options.appendMessage('main', { type: 'system', content: buildSlashHelpText() });
      break;
    case '/quit':
    case '/exit':
      options.appendMessage('main', { type: 'system', content: t('tui.exit.goodbye') });
      options.setSubmitting(true);
      setTimeout(() => options.requestProcessExit('slash_exit'), 0);
      break;
    case '/clear':
      options.setChannels((prev) => ({ ...prev, main: { ...prev.main, messages: [] } }));
      try {
        const result = await options.onCommand(input);
        if (hasCommandContent(result)) {
          options.appendMessage('main', { type: 'system', content: result.content });
        }
      } catch (error) {
        options.appendMessage('main', { type: 'system', content: t('tui.command.clear_failed', getErrorMessage(error)) });
      }
      break;
    case '/reset':
      options.setChannels((prev) => ({ ...prev, main: { ...prev.main, messages: [] } }));
      try {
        const result = await options.onCommand(input);
        if (typeof result === 'string') {
          options.appendMessage('main', { type: 'system', content: result });
        }
      } catch {/* expected: best-effort cleanup */}
      break;
    case '/compact':
      try {
        const result = await options.onCommand(input);
        if (hasCommandContent(result)) {
          options.appendMessage('main', { type: 'system', content: result.content });
        } else {
          options.appendMessage('main', { type: 'system', content: t('tui.command.compact_requested') });
        }
      } catch (error) {
        options.appendMessage('main', { type: 'system', content: t('tui.command.compact_failed', getErrorMessage(error)) });
      }
      break;
    case '/language': {
      const lang = input.split(/\s/)[1]?.toLowerCase();
      if (lang === 'zh' || lang === 'en') {
        setLanguage(lang);
        setSessionLanguage(lang);
        options.onLanguageChanged?.(lang);
        options.appendMessage('main', { type: 'system', content: t('tui.command.language_changed', lang) });
      } else {
        options.appendMessage('main', { type: 'system', content: t('tui.command.language_usage') });
      }
      break;
    }
    case '/intervene': {
      const parsed = parseInterveneCommand(input);
      if (!parsed) {
        options.appendMessage('main', { type: 'system', content: t('tui.command.intervene_usage') });
        break;
      }
      try {
        const result = await options.onCommand(input);
        if (hasCommandContent(result)) {
          options.appendMessage('main', { type: 'system', content: result.content });
        } else {
          options.appendMessage('main', { type: 'system', content: t('tui.command.intervene_sent', parsed.agentName) });
        }
      } catch (error) {
        options.appendMessage('main', { type: 'system', content: t('tui.command.intervene_failed', getErrorMessage(error)) });
      }
      break;
    }
    case '/tasks':
      options.setModalType('dag');
      options.setModalCursor(0);
      break;
    case '/graph':
      options.setModalType('graph');
      options.setModalCursor(0);
      break;
    case '/notes':
      options.setModalType('workNotes');
      options.setModalCursor(0);
      break;
    case '/git': {
      options.setModalCursor(0);
      options.setModalType('git');
      // 异步加载，加载态由 GitPanel 在 data=null 时呈现
      if (options.onLoadGitData) {
        options.onLoadGitData().catch((error: unknown) => {
          options.appendMessage('main', { type: 'error', content: t('tui.command.git_load_failed', getErrorMessage(error)) });
        });
      }
      break;
    }
    case '/agents':
      options.setModalType('dag');
      options.setModalCursor(0);
      break;
    case '/main':
      options.setCurrentTab('main');
      break;
    case '/config': {
      const rest = input.slice('/config'.length).trim();
      const { handleConfigSet, handleConfigReset, handleConfigInit, handleConfigResetAll, formatConfigDisplay } = await import('../../commands/configCommand.js');
      if (rest.startsWith('set ') || rest === 'set') {
        options.appendMessage('main', { type: 'system', content: handleConfigSet(rest.slice(3).trim()) });
      } else if (rest.startsWith('reset-all')) {
        options.appendMessage('main', { type: 'system', content: handleConfigResetAll(rest.slice(9).trim()) });
      } else if (rest.startsWith('reset ')) {
        options.appendMessage('main', { type: 'system', content: handleConfigReset(rest.slice(6).trim()) });
      } else if (rest.startsWith('init')) {
        options.appendMessage('main', { type: 'system', content: handleConfigInit(rest.slice(4).trim()) });
      } else if (rest === '') {
        options.appendMessage('main', { type: 'system', content: formatConfigDisplay() });
      } else {
        options.appendMessage('main', { type: 'system', content: t('tui.command.config_usage') });
      }
      break;
    }
    default: {
      const result = await options.onCommandRef.current(input);
      if (typeof result === 'string') {
        options.appendMessage('main', { type: 'system', content: result });
      } else if (result && typeof result === 'object') {
        if (result.type === 'system' && result.content) {
          options.appendMessage('main', { type: 'system', content: result.content });
        } else if (result.type === 'table' || result.type === 'code') {
          options.appendMessage('main', { type: 'system', content: result.content });
        }
        hydrateIfNeeded(result, options);
      }
    }
  }
}

function hydrateIfNeeded(result: CommandResult, options: UseTuiSubmitControllerOptions): void {
  if (result.action !== 'hydrate') return;
  if (result.sessionStatus) options.setSessionStatus({ ...result.sessionStatus });
  if (result.tasks) options.setTasks(result.tasks);
  const agentChannels = (result.channels || []).map(withHydrateChannelMetadata);
  const newChannelMap = createInitialChannelMap(result.messages || [], agentChannels);
  options.setChannels(newChannelMap);
  if (result.tokenUsage !== undefined) options.setTokenUsage({ total: result.tokenUsage });
  if (result.agentTokens) options.setAgentTokens(result.agentTokens);
  if (result.leaderStatus) options.setLeaderStatus(result.leaderStatus);
  if (result.leaderMode) options.setLeaderMode(result.leaderMode);
  if (result.leaderReason) options.setLeaderModeReason(result.leaderReason);
  const agentTabs = agentChannels.filter((channel) => channel.name !== 'main');
  options.setTabOrder(['main', ...agentTabs.map((channel) => channel.name)]);
  options.setLaunchedAgents(agentTabs.map((channel) => ({ name: channel.name, role: channel.role || 'worker', taskId: channel.taskId || '', backend: channel.backend, externalSessionId: channel.externalSessionId, pid: channel.pid })));
  options.setCurrentTab('main');
}
