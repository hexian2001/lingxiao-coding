import { platform as getOsPlatform, arch as getOsArch } from 'os';
import type { ContextMemoryItem, ContextMemoryRecallResult } from './ContextMemoryIndex.js';
import type { ContextRuntimeState } from './ContextRuntimeState.js';
import type { WorkerContractComplianceProof } from './AgentProtocol.js';

export const CONTEXT_MANIFEST_BLOCK_MARKER = '[Context Manifest — 系统统一注入]';
export const CONTEXT_MANIFEST_TITLE = '### Context Manifest（系统统一注入）';

/**
 * 状态镜像类 manifest 的确定性槽位枚举（单一事实源）。
 * 每个 slot 对应一个「每轮刷新、最新值即权威」的 system 注入，由 SystemMessageSlot
 * 做单槽 in-place 更新，避免每轮 append 堆积占满上下文。
 */
export const CONTEXT_MANIFEST_SLOTS = [
  'leader_runtime',
  'leader_memory',
  'leader_init',
  'worker_runtime',
] as const;
export type ContextManifestSlot = (typeof CONTEXT_MANIFEST_SLOTS)[number];

/**
 * 判定一条 system 消息内容是否属于指定 slot 的状态镜像 manifest。
 * 确定性：TITLE 前缀 + 整行 `slot=<value>` 精确相等（非模糊/启发式匹配）。
 * 整行相等规避了 slot 行可能位于末尾无尾换行的边界。
 */
export function isManifestSlotContent(content: unknown, slot: string): boolean {
  if (typeof content !== 'string' || !slot) return false;
  if (!content.trimStart().startsWith(CONTEXT_MANIFEST_TITLE)) return false;
  const target = `slot=${slot}`;
  // 仅扫前若干行即可定位（slot 行恒在第 3 行附近），无需遍历整块。
  const lines = content.split('\n');
  const scanLimit = Math.min(lines.length, 8);
  for (let i = 0; i < scanLimit; i += 1) {
    if (lines[i] === target) return true;
  }
  return false;
}

export interface ContextManifestSection {
  title: string;
  content: string;
}

export interface ContextManifestInput {
  scope: 'leader' | 'worker' | 'reset';
  sessionId: string;
  /**
   * 确定性槽位标识。状态镜像类 manifest（每轮刷新、最新值即权威）必须带 slot，
   * 供 SystemMessageSlot 单槽 in-place 更新定位（避免每轮 append 堆积占满上下文）。
   * 渲染为 `scope=` 行之后的独立 `slot=<value>` 行。
   * 事件/一次性 manifest（如 scope='reset' 压缩产物）不传 slot，保持 append。
   */
  slot?: string;
  memory?: ContextMemoryRecallResult;
  runtime?: ContextRuntimeState;
  reset?: {
    originalMessages: number;
    retainedMessages: number;
    retainedRecentMessages: number;
    reason: string;
  };
  intuition?: string | null;
  persistentMemoryIndex?: string | null;
  toolSurface?: ContextManifestToolSurface;
  plugins?: ContextManifestPluginSurface;
  mcp?: ContextManifestMcpSurface;
  agentArtifacts?: ContextManifestAgentArtifact[];
  modes?: ContextManifestModeSurface;
  sections?: ContextManifestSection[];
  notes?: string[];
}

export interface ContextManifestToolSurface {
  tools: string[];
  required?: string[];
  mode?: string;
}

export interface ContextManifestPluginSurface {
  sources?: Array<{ id: string; version?: string; path?: string; manifestPath?: string; scope?: string; enabled?: boolean }>;
  skills?: Array<{ name: string; source?: string; path?: string; plugin?: string; truncated?: boolean }>;
  runtime?: string[];
  nonRuntime?: string[];
}

export interface ContextManifestMcpSurface {
  servers?: Array<{ id: string; name?: string; version?: string; schemaVersion?: string }>;
  resources?: Array<{ server: string; uri: string; name?: string }>;
  prompts?: Array<{ server: string; name: string; description?: string }>;
  resourceTemplates?: Array<{ server: string; uriTemplate: string; name?: string }>;
}

export interface ContextManifestAgentArtifact {
  source?: string;
  taskId?: string;
  agentId?: string;
  summary?: string;
  filesCreated?: string[];
  filesModified?: string[];
  commandsRun?: string[];
  evidenceRefs?: string[];
  contractCompliance?: WorkerContractComplianceProof;
  toolTrace?: {
    filesCreated?: string[];
    filesModified?: string[];
    commandsRun?: string[];
  };
  verification?: Array<{ kind: string; detail: string; passed?: boolean }>;
  nextSteps?: string[];
}

export interface ContextManifestModeSurface {
  active?: string[];
  notes?: string[];
}

function sourceCounts(items: ContextMemoryItem[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.source, (counts.get(item.source) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([source, count]) => `${source}=${count}`)
    .join(', ');
}

function artifactRefs(items: ContextMemoryItem[], maxItems = 12): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const ref = item.artifact || item.taskId;
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
    if (refs.length >= maxItems) break;
  }
  return refs;
}

function compactList(items: Array<string | undefined> | undefined, maxItems = 16): string {
  const values = Array.from(new Set((items ?? []).map((item) => String(item || '').trim()).filter(Boolean)));
  if (values.length <= maxItems) return values.join(', ');
  return `${values.slice(0, maxItems).join(', ')} (+${values.length - maxItems})`;
}

function normalizedSections(input: ContextManifestInput): ContextManifestSection[] {
  const sections: ContextManifestSection[] = [];
  if (input.intuition?.trim()) {
    sections.push({ title: 'Intuition Snapshot', content: input.intuition.trim() });
  }
  if (input.persistentMemoryIndex?.trim()) {
    sections.push({ title: 'Persistent Memory Index', content: input.persistentMemoryIndex.trim() });
  }
  for (const section of input.sections ?? []) {
    if (section.title.trim() && section.content.trim()) {
      sections.push({ title: section.title.trim(), content: section.content.trim() });
    }
  }
  return sections;
}

export function renderContextManifest(input: ContextManifestInput): string {
  const memory = input.memory;
  const items = memory?.items ?? [];
  const sections = normalizedSections(input);
  // OS 平台标识：静态值，直接在渲染层计算，所有调用点自动获得，无需逐个传参。
  // 上下文压缩后 session scope section 可能丢失，Manifest 是每轮刷新的确定性槽位，
  // platform= 行确保 Agent 跨压缩持久感知运行平台。
  const osPlatform = getOsPlatform();
  const osArch = getOsArch();
  const platformLabel = osPlatform === 'win32' ? `win32/${osArch}`
    : osPlatform === 'darwin' ? `darwin/${osArch}`
    : `${osPlatform}/${osArch}`;

  const lines: string[] = [
    CONTEXT_MANIFEST_TITLE,
    `scope=${input.scope} session=${input.sessionId}`,
    `platform=${platformLabel}`,
  ];
  // 确定性槽位标识：供 SystemMessageSlot 单槽 in-place 更新定位（状态镜像类注入必填）。
  // 用独立行而非并入 scope 行——scope 行含动态 sessionId，无法做稳定前缀匹配；
  // 单独 slot 行配 isManifestSlotMessage 的换行锚定匹配才是确定性的。
  if (input.slot?.trim()) {
    lines.push(`slot=${input.slot.trim()}`);
  }

  if (input.reset) {
    lines.push(
      `reset_reason=${input.reset.reason}`,
      `reset_messages=${input.reset.originalMessages}->${input.reset.retainedMessages}`,
      `reset_recent_messages=${input.reset.retainedRecentMessages}`,
    );
  }

  if (input.runtime) {
    lines.push(
      `context_tokens=${input.runtime.currentTokens}/${input.runtime.threshold}`,
      `context_warning=${input.runtime.warningLevel}`,
    );
    if (input.runtime.lastArchivePath) {
      lines.push(`last_archive=${input.runtime.lastArchivePath}`);
    }
    if (input.runtime.recentFiles.length > 0) {
      const files = input.runtime.recentFiles
        .slice(0, 8)
        .map((file) => `${file.path}(${file.tokenEstimate}t)`);
      lines.push(`recent_files=${files.join(', ')}`);
    }
  }

  if (memory) {
    lines.push(
      `memory_items=${items.length} estimated_tokens=${memory.estimatedTokens} dropped=${memory.dropped}`,
      `sources=${sourceCounts(items) || '(none)'}`,
    );
    const refs = artifactRefs(items);
    if (refs.length > 0) {
      lines.push(`artifact_refs=${refs.join(', ')}`);
    }
  }

  if (input.toolSurface) {
    const tools = compactList(input.toolSurface.tools, 24);
    if (tools) lines.push(`tools=${tools}`);
    const required = compactList(input.toolSurface.required, 16);
    if (required) lines.push(`required_tools=${required}`);
    if (input.toolSurface.mode?.trim()) lines.push(`tool_mode=${input.toolSurface.mode.trim()}`);
  }

  if (input.plugins) {
    if (input.plugins.sources?.length) {
      const sources = input.plugins.sources.map((plugin) => [
        plugin.id,
        plugin.version ? `version=${plugin.version}` : '',
        plugin.scope ? `scope=${plugin.scope}` : '',
        plugin.enabled === false ? 'enabled=false' : '',
        plugin.path ? `path=${plugin.path}` : '',
        plugin.manifestPath ? `manifest=${plugin.manifestPath}` : '',
      ].filter(Boolean).join(' '));
      lines.push(`plugin_sources=${compactList(sources, 10)}`);
    }
    if (input.plugins.skills?.length) {
      const skillRefs = input.plugins.skills.map((skill) => [
        skill.name,
        skill.source ? `source=${skill.source}` : '',
        skill.plugin ? `plugin=${skill.plugin}` : '',
        skill.truncated ? 'truncated=true' : '',
        skill.path ? `path=${skill.path}` : '',
      ].filter(Boolean).join(' '));
      lines.push(`skills=${compactList(skillRefs, 16)}`);
    }
    const runtime = compactList(input.plugins.runtime, 12);
    if (runtime) lines.push(`plugin_runtime=${runtime}`);
    const nonRuntime = compactList(input.plugins.nonRuntime, 12);
    if (nonRuntime) lines.push(`plugin_non_runtime=${nonRuntime}`);
  }

  if (input.mcp) {
    if (input.mcp.servers?.length) {
      const servers = input.mcp.servers.map((server) => [
        server.id,
        server.name ? `name=${server.name}` : '',
        server.version ? `version=${server.version}` : '',
        server.schemaVersion ? `schema=${server.schemaVersion}` : '',
      ].filter(Boolean).join(' '));
      lines.push(`mcp_servers=${compactList(servers, 12)}`);
    }
    if (input.mcp.prompts?.length) {
      lines.push(`mcp_prompts=${compactList(input.mcp.prompts.map((prompt) => `${prompt.server}:${prompt.name}`), 16)}`);
    }
    if (input.mcp.resources?.length) {
      lines.push(`mcp_resources=${compactList(input.mcp.resources.map((resource) => `${resource.server}:${resource.uri}`), 16)}`);
    }
    if (input.mcp.resourceTemplates?.length) {
      lines.push(`mcp_resource_templates=${compactList(input.mcp.resourceTemplates.map((template) => `${template.server}:${template.uriTemplate}`), 16)}`);
    }
  }

  if (input.modes) {
    const active = compactList(input.modes.active, 12);
    if (active) lines.push(`modes=${active}`);
    for (const note of input.modes.notes ?? []) {
      if (note.trim()) lines.push(`mode_note=${note.trim()}`);
    }
  }

  if (input.agentArtifacts?.length) {
    lines.push(`agent_artifacts=${input.agentArtifacts.length}`);
    for (const artifact of input.agentArtifacts.slice(0, 8)) {
      const prefix = [
        artifact.source || 'agent',
        artifact.taskId ? `task=${artifact.taskId}` : '',
        artifact.agentId ? `agent=${artifact.agentId}` : '',
      ].filter(Boolean).join(' ');
      lines.push(`artifact ${prefix}`.trim());
      if (artifact.summary?.trim()) lines.push(`summary=${artifact.summary.trim()}`);
      const created = compactList(artifact.filesCreated, 8);
      if (created) lines.push(`files_created=${created}`);
      const modified = compactList(artifact.filesModified, 8);
      if (modified) lines.push(`files_modified=${modified}`);
      const commands = compactList(artifact.commandsRun, 8);
      if (commands) lines.push(`commands_run=${commands}`);
      const evidenceRefs = compactList(artifact.evidenceRefs, 8);
      if (evidenceRefs) lines.push(`evidence_refs=${evidenceRefs}`);
      if (artifact.contractCompliance) {
        lines.push(`contract_surface=${artifact.contractCompliance.surface}`);
        lines.push(`contract_status=${artifact.contractCompliance.status}`);
        const contractEvidence = compactList(artifact.contractCompliance.evidence, 8);
        if (contractEvidence) lines.push(`contract_evidence=${contractEvidence}`);
        const deviations = compactList(artifact.contractCompliance.deviations, 8);
        if (deviations) lines.push(`contract_deviations=${deviations}`);
      }
      if (artifact.toolTrace) {
        const tracedCreated = compactList(artifact.toolTrace.filesCreated, 8);
        if (tracedCreated) lines.push(`tool_trace_files_created=${tracedCreated}`);
        const tracedModified = compactList(artifact.toolTrace.filesModified, 8);
        if (tracedModified) lines.push(`tool_trace_files_modified=${tracedModified}`);
        const tracedCommands = compactList(artifact.toolTrace.commandsRun, 8);
        if (tracedCommands) lines.push(`tool_trace_commands_run=${tracedCommands}`);
      }
      if (artifact.verification?.length) {
        const verification = artifact.verification.map((item) => {
          const status = item.passed === false ? 'failed' : item.passed === true ? 'passed' : 'unknown';
          return `[${status}] ${item.kind}: ${item.detail}`;
        });
        lines.push(`verification=${compactList(verification, 8)}`);
      }
      const nextSteps = compactList(artifact.nextSteps, 8);
      if (nextSteps) lines.push(`next_steps=${nextSteps}`);
    }
  }

  if (input.notes?.length) {
    for (const note of input.notes) {
      if (note.trim()) lines.push(`note=${note.trim()}`);
    }
  }

  if (sections.length > 0) {
    lines.push(`dynamic_sections=${sections.map((section) => section.title).join(', ')}`);
    for (const section of sections) {
      lines.push('', `#### ${section.title}`, section.content);
    }
  }

  if (memory?.rendered) {
    lines.push('', memory.rendered);
  }

  return lines.join('\n');
}
