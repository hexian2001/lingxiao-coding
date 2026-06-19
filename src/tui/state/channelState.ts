import type {
  CommandInitialChannelSeed,
  CommandLogMessage,
} from '../../commands/types.js';
import { isAgentRunStatus, type AgentRunStatus } from '../../contracts/types/Status.js';
import type { ChannelState, UiStreamingState } from './types.js';
import { t } from '../../i18n.js';

export type ChannelStatusInput = AgentRunStatus | string;

export function normalizeChannelStatusInput(status?: ChannelStatusInput): Pick<ChannelState, 'status' | 'statusText'> {
  if (status === undefined) {
    return { status: 'idle' };
  }
  const raw = String(status);
  if (isAgentRunStatus(raw)) {
    return { status: raw };
  }
  return { status: 'unknown' };
}

export function getChannelDisplayStatus(channel?: Pick<ChannelState, 'status' | 'statusText'>): string {
  return channel?.statusText || channel?.status || 'idle';
}

type ChannelStateUpdates = Omit<Partial<ChannelState>, 'status'> & {
  status?: ChannelStatusInput;
};

export function createChannelState(input: {
  name: string;
  role?: string;
  taskId?: string;
  status?: ChannelStatusInput;
  statusText?: string;
  messages?: CommandLogMessage[];
  currentNext?: string;
  currentStream?: string;
  currentThinkingStream?: string;
  streamingState?: UiStreamingState;
}): ChannelState {
  const status = normalizeChannelStatusInput(input.status);
  return {
    name: input.name,
    role: input.role,
    taskId: input.taskId,
    status: status.status,
    statusText: input.statusText,
    streamingState: input.streamingState || 'idle',
    currentNext: input.currentNext,
    currentStream: input.currentStream,
    currentThinkingStream: input.currentThinkingStream,
    messages: [...(input.messages || [])],
  };
}

export function createInitialChannelMap(
  initialMessages: CommandLogMessage[],
  seeds: CommandInitialChannelSeed[] = [],
): Record<string, ChannelState> {
  const channels: Record<string, ChannelState> = {
    main: createChannelState({
      name: 'main',
      status: 'idle',
      messages: initialMessages,
    }),
  };

  for (const seed of seeds) {
    channels[seed.name] = createChannelState({
      name: seed.name,
      role: seed.role,
      taskId: seed.taskId,
      status: seed.status,
      messages: seed.messages,
    });
  }

  return channels;
}

export function ensureChannelState(
  channels: Record<string, ChannelState>,
  name: string,
  role?: string,
  taskId?: string,
): Record<string, ChannelState> {
  if (channels[name]) {
    return channels;
  }

  return {
    ...channels,
    [name]: createChannelState({
      name,
      role,
      taskId,
      status: 'idle',
    }),
  };
}

/** 单通道最大消息数（超过则自动清理旧消息） */
const MAX_MESSAGES_PER_CHANNEL = 5000;

/** 清理后保留的消息数（保留最近的消息） */
const KEEP_MESSAGES_AFTER_TRIM = 4500;

export function appendChannelMessage(
  channels: Record<string, ChannelState>,
  name: string,
  message: CommandLogMessage,
): Record<string, ChannelState> {
  const channel = channels[name];
  if (!channel) {
    return channels;
  }

  // 添加新消息
  const newMessages = [...channel.messages, message];
  
  // 内存优化：基于 Claude Code 设计
  // 当消息数超过阈值时，自动清理旧消息（保留最近的消息）
  let trimmedMessages = newMessages;
  if (newMessages.length > MAX_MESSAGES_PER_CHANNEL) {
    // 保留最近的消息，清理旧的，并插入 sentinel 标记
    const trimmed = newMessages.slice(-KEEP_MESSAGES_AFTER_TRIM);
    const sentinel: CommandLogMessage = {
      type: 'system',
      content: t('tui.channel.trimmed', newMessages.length - KEEP_MESSAGES_AFTER_TRIM),
      timestamp: Date.now(),
    };
    trimmedMessages = [sentinel, ...trimmed];
  }

  return {
    ...channels,
    [name]: {
      ...channel,
      messages: trimmedMessages,
    },
  };
}

export function updateChannelState(
  channels: Record<string, ChannelState>,
  name: string,
  updates: ChannelStateUpdates,
): Record<string, ChannelState> {
  const channel = channels[name];
  if (!channel) {
    return channels;
  }

  const { status: rawStatus, ...restUpdates } = updates;
  const normalizedStatus = rawStatus === undefined ? undefined : normalizeChannelStatusInput(rawStatus);
  const next: ChannelState = {
    ...channel,
    ...restUpdates,
    ...(normalizedStatus ?? {}),
    ...(rawStatus !== undefined && normalizedStatus?.statusText === undefined && updates.statusText === undefined ? { statusText: undefined } : {}),
  };
  return {
    ...channels,
    [name]: next,
  };
}

export function resetChannelTransients(
  channels: Record<string, ChannelState>,
  options?: {
    mainStatus?: string;
    defaultStatus?: string;
    clearStats?: boolean;
  },
): Record<string, ChannelState> {
  const mainStatus = options?.mainStatus ?? channels.main?.status ?? 'idle';
  const defaultStatus = options?.defaultStatus ?? 'idle';
  const clearStats = options?.clearStats ?? false;
  const next: Record<string, ChannelState> = {};
  for (const [name, channel] of Object.entries(channels)) {
    const status = normalizeChannelStatusInput(name === 'main' ? mainStatus : defaultStatus);
    next[name] = {
      ...channel,
      status: status.status,
      statusText: status.statusText,
      streamingState: 'idle',
      currentNext: '',
      currentStream: '',
      currentThinkingStream: '',
      ...(clearStats ? { stats: undefined } : null),
    };
  }
  return next;
}

export function appendChannelStreamChunk(
  channels: Record<string, ChannelState>,
  name: string,
  field: 'currentStream' | 'currentThinkingStream',
  chunk: string,
): Record<string, ChannelState> {
  const channel = channels[name];
  if (!channel) {
    return channels;
  }

  const currentValue = channel[field] || '';
  const streamingState = chunk ? 'responding' : channel.streamingState;
  return updateChannelState(channels, name, {
    [field]: `${currentValue}${chunk}`,
    streamingState,
  } as Partial<ChannelState>);
}

export function clearChannelStreams(
  channels: Record<string, ChannelState>,
  name: string,
): Record<string, ChannelState> {
  return updateChannelState(channels, name, {
    currentStream: '',
    currentThinkingStream: '',
    streamingState: 'idle',
  });
}
