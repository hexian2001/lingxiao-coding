import { isAgentActiveStatus, isToolCallOpenStatus, runtimeImpliesBusy } from '../stores/sessionStoreHelpers.ts';
import type { AgentConversation, AgentRuntime, Message, SessionPhase, SessionRuntimeSnapshot } from '../stores/sessionStoreTypes.ts';

export interface ChatRunStateInput {
  phase: SessionPhase;
  agents: AgentRuntime[];
  messages: Message[];
  agentConversations: Record<string, AgentConversation>;
  runtimeSnapshot: SessionRuntimeSnapshot | null;
}

export interface ChatRunStateViewModel {
  backendBusy: boolean;
  localActivity: boolean;
  active: boolean;
}

const ACTIVE_LOCAL_PHASES = new Set<SessionPhase>([
  'preparing',
  'model_requesting',
  'streaming',
  'thinking',
  'tool_executing',
  'observing',
  'waiting_for_permission',
  'waiting_for_user',
  'retrying',
  'compacting',
  'cancelling',
]);

const RUNTIME_IDLE_LOCAL_PHASES = new Set<SessionPhase>([
  'preparing',
  'model_requesting',
  'compacting',
  'cancelling',
]);

export function buildChatRunStateViewModel(input: ChatRunStateInput): ChatRunStateViewModel {
  const hasRuntimeSnapshot = Boolean(input.runtimeSnapshot);
  const backendBusy = input.runtimeSnapshot
    ? runtimeImpliesBusy({ runtimeState: input.runtimeSnapshot })
    : false;
  const allowLocalResidue = !hasRuntimeSnapshot || backendBusy;
  const activeAssistant = input.messages.some((message) =>
    message.role === 'assistant'
    && (message.isStreaming === true
      || message.retrying === true
      || message.toolCalls?.some((toolCall) => isToolCallOpenStatus(toolCall.status)))
  );
  const activeAgentConversation = Object.values(input.agentConversations).some((conversation) =>
    conversation.messages.some((message) =>
      message.isStreaming === true
      || isToolCallOpenStatus(message.toolStatus)
    )
  );
  const phaseActivity = hasRuntimeSnapshot && !backendBusy
    ? RUNTIME_IDLE_LOCAL_PHASES.has(input.phase)
    : ACTIVE_LOCAL_PHASES.has(input.phase);
  const localResidue = input.agents.some((agent) => isAgentActiveStatus(agent.status))
    || activeAssistant
    || activeAgentConversation;
  const localActivity = phaseActivity || (allowLocalResidue && localResidue);

  return {
    backendBusy,
    localActivity,
    active: backendBusy || localActivity,
  };
}
