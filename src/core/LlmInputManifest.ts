import { countTokens } from '../llm/token_counter.js';
import type { ChatMessage, ToolDefinition } from '../llm/types.js';

export interface LlmInputManifestMessage {
  index: number;
  role: ChatMessage['role'];
  chars: number;
  estimatedTokens: number;
  markers: string[];
  hasToolCalls: boolean;
  hasThinking: boolean;
}

export interface LlmInputManifest {
  actor: 'leader' | 'worker' | 'agent' | 'system';
  actorLabel: string;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
  model: string;
  messageCount: number;
  systemMessageCount: number;
  toolCount: number;
  toolNames: string[];
  estimatedMessageTokens: number;
  estimatedToolTokens: number;
  totalEstimatedTokens: number;
  contextManifestCount: number;
  dynamicMarkers: string[];
  messages: LlmInputManifestMessage[];
}

const MARKERS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'context_manifest', pattern: /Context Manifest（系统统一注入）|Context Manifest — 系统统一注入/ },
  { name: 'task_instruction', pattern: /任务指令:/ },
  { name: 'session_scope', pattern: /【会话空间】|--- 会话空间 ---/ },
  { name: 'scratchpad', pattern: /【Scratchpad】|Scratchpad:/ },
  { name: 'skill_injection', pattern: /Skills 技能目录|Skill 路径规则|Injected Skill Bodies|<skill\b/ },
  { name: 'capability_surface', pattern: /能力面协议（Plugin \/ Skill \/ MCP）|mcp\(action="list_servers\|list_tools\|call_tool\|list_resources\|read_resource"/ },
  { name: 'mcp_surface', pattern: /mcp_servers=|mcp_prompts=|mcp_resources=|mcp_resource_templates=/ },
  { name: 'plugin_surface', pattern: /plugin_sources=|plugin_runtime=|plugin_non_runtime=/ },
  { name: 'mode_surface', pattern: /modes=|mode_note=/ },
  { name: 'agent_artifacts', pattern: /agent_artifacts=|tool_trace_files_|evidence_refs=|verification=/ },
  { name: 'team_protocol', pattern: /Team 通信|Team 协作|team_inbox|team_message/ },
  { name: 'blackboard', pattern: /黑板|知识图谱|graph_contract|graph_fact|blackboard/ },
  { name: 'artifact_awareness', pattern: /Cross-Agent Artifact Awareness/ },
  { name: 'runtime_context', pattern: /context_tokens=|recent_files=|context_warning=/ },
  { name: 'memory_index', pattern: /Persistent Memory Index|memory_items=/ },
  { name: 'leader_guidance', pattern: /\[Leader 指导]|\[用户指导/ },
];

function contentText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {/* expected: fallback to default */
    return String(content);
  }
}

function detectMarkers(text: string): string[] {
  const markers: string[] = [];
  for (const marker of MARKERS) {
    if (marker.pattern.test(text)) markers.push(marker.name);
  }
  return markers;
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}

export function buildLlmInputManifest(input: {
  actor: LlmInputManifest['actor'];
  actorLabel: string;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
}): LlmInputManifest {
  const messages = input.messages.map((message, index) => {
    const text = contentText(message.content);
    return {
      index,
      role: message.role,
      chars: text.length,
      estimatedTokens: countTokens(text),
      markers: detectMarkers(text),
      hasToolCalls: Boolean(message.tool_calls?.length),
      hasThinking: Boolean(message.thinking?.length),
    };
  });
  const toolNames = (input.tools ?? []).map((tool) => tool.function.name);
  const estimatedMessageTokens = messages.reduce((sum, message) => sum + message.estimatedTokens, 0);
  const estimatedToolTokens = countTokens(JSON.stringify(input.tools ?? []));
  const dynamicMarkers = unique(messages.flatMap((message) => message.markers));

  return {
    actor: input.actor,
    actorLabel: input.actorLabel,
    sessionId: input.sessionId,
    agentId: input.agentId,
    taskId: input.taskId,
    model: input.model,
    messageCount: input.messages.length,
    systemMessageCount: input.messages.filter((message) => message.role === 'system').length,
    toolCount: toolNames.length,
    toolNames,
    estimatedMessageTokens,
    estimatedToolTokens,
    totalEstimatedTokens: estimatedMessageTokens + estimatedToolTokens,
    contextManifestCount: messages.filter((message) => message.markers.includes('context_manifest')).length,
    dynamicMarkers,
    messages,
  };
}

export function summarizeLlmInputManifest(manifest: LlmInputManifest): string {
  const markerText = manifest.dynamicMarkers.length > 0 ? manifest.dynamicMarkers.join(',') : 'none';
  const toolPreview = manifest.toolNames.slice(0, 12).join(',');
  const remainingTools = manifest.toolNames.length > 12 ? `,+${manifest.toolNames.length - 12}` : '';
  return [
    `actor=${manifest.actor}:${manifest.actorLabel}`,
    `model=${manifest.model}`,
    `messages=${manifest.messageCount}`,
    `system=${manifest.systemMessageCount}`,
    `tools=${manifest.toolCount}[${toolPreview}${remainingTools}]`,
    `tokens≈${manifest.totalEstimatedTokens}`,
    `context_manifests=${manifest.contextManifestCount}`,
    `markers=${markerText}`,
  ].join(' ');
}
