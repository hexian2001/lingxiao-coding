import { joinBlocks, section, bullets } from '../shared/prompt_builder.js';
import {
  buildCapabilitySurfaceProtocol,
  buildBrowserAcceptanceRule,
  buildCompleteDeliveryPrinciple,
  buildScratchpadSection,
  buildSessionScopeSection,
  buildWorkerWriteWorkNoteSection,
  buildIncrementalWriteRule,
} from '../shared/fragments.js';
import { getPromptCatalog, getPromptLanguageDirective, type PromptLocale } from '../i18n/catalog.js';
import {
  CONTEXT_MANIFEST_BLOCK_MARKER,
  renderContextManifest,
  type ContextManifestAgentArtifact,
  type ContextManifestMcpSurface,
  type ContextManifestModeSurface,
  type ContextManifestPluginSurface,
  type ContextManifestSection,
  type ContextManifestToolSurface,
} from '../../../core/ContextManifest.js';

interface InjectedSkills {
  names: string[];
  sections?: Array<{
    name: string;
    source: string;
    path: string;
    summary: string;
    includedChars: number;
    originalChars: number;
    truncated: boolean;
    body: string;
  }>;
  content: string;
}

function estimateTaskBudget(subject: string, description: string, locale?: PromptLocale): string {
  const textLength = `${subject} ${description}`.length;
  const text = getPromptCatalog(locale).workerTask;
  if (textLength < 100) return text.budgetFast;
  if (textLength > 400) return text.budgetLarge;
  return text.budgetMedium;
}

function normalizeManifestWithTitle(manifest: string, locale?: PromptLocale): string {
  let clean = manifest.trim();
  if (clean.startsWith(CONTEXT_MANIFEST_BLOCK_MARKER)) {
    clean = clean.slice(CONTEXT_MANIFEST_BLOCK_MARKER.length).trim();
  }
  if (clean.startsWith('### Context Manifest')) {
    return clean;
  }
  return `${getPromptCatalog(locale).workerTask.contextManifestTitle}\n${clean}`.trim();
}

function stripManifestForAppend(manifest: string): string {
  let clean = manifest.trim();
  if (!clean) return '';
  if (clean.startsWith(CONTEXT_MANIFEST_BLOCK_MARKER)) {
    clean = clean.slice(CONTEXT_MANIFEST_BLOCK_MARKER.length).trim();
  }
  if (clean.startsWith('### Context Manifest')) {
    clean = clean.split('\n').slice(1).join('\n').trim();
  }
  const lines = clean.split(/\r?\n/);
  if (lines[0]?.startsWith('scope=')) {
    lines.shift();
  }
  return lines.join('\n').trim();
}

function renderContextSections(context: string, capabilityManifest = '', locale?: PromptLocale): string[] {
  const text = getPromptCatalog(locale).workerTask;
  const sections: string[] = [];
  const markerIdx = context.indexOf(CONTEXT_MANIFEST_BLOCK_MARKER);
  const leaderPart = markerIdx >= 0 ? context.slice(0, markerIdx).trim() : context.trim();
  if (leaderPart) {
    sections.push(section(text.leaderContextHeading, [
      text.leaderContextIntro,
      '',
      leaderPart,
    ]));
  }
  const systemPart = markerIdx >= 0 ? context.slice(markerIdx).trim() : '';
  const hasSystemManifest = Boolean(systemPart.trim());
  const hasCapabilityManifest = Boolean(capabilityManifest.trim());
  if (hasSystemManifest || hasCapabilityManifest) {
    const baseManifest = hasSystemManifest
      ? normalizeManifestWithTitle(systemPart, locale)
      : normalizeManifestWithTitle(capabilityManifest, locale);
    const appendedManifest = hasSystemManifest ? stripManifestForAppend(capabilityManifest) : '';
    sections.push([
      CONTEXT_MANIFEST_BLOCK_MARKER,
      baseManifest,
      appendedManifest,
    ].filter(Boolean).join('\n'));
  }
  return sections;
}

function buildInjectedSkillManifest(input: {
  sessionId: string;
  injectedSkills: InjectedSkills;
  toolSurface?: ContextManifestToolSurface;
  pluginSurface?: ContextManifestPluginSurface;
  mcpSurface?: ContextManifestMcpSurface;
  modes?: ContextManifestModeSurface;
  agentArtifacts?: ContextManifestAgentArtifact[];
  sections?: ContextManifestSection[];
  locale?: PromptLocale;
}): string {
  const skillSections = input.injectedSkills.sections ?? [];
  const extraSections = input.sections ?? [];
  const hasToolSurface = Boolean(input.toolSurface?.tools?.length || input.toolSurface?.required?.length || input.toolSurface?.mode);
  const hasPluginSurface = Boolean(
    input.pluginSurface?.skills?.length ||
    input.pluginSurface?.runtime?.length ||
    input.pluginSurface?.nonRuntime?.length,
  );
  const hasMcpSurface = Boolean(
    input.mcpSurface?.servers?.length ||
    input.mcpSurface?.prompts?.length ||
    input.mcpSurface?.resources?.length ||
    input.mcpSurface?.resourceTemplates?.length,
  );
  const hasModeSurface = Boolean(input.modes?.active?.length || input.modes?.notes?.length);
  const hasAgentArtifacts = Boolean(input.agentArtifacts?.length);
  const hasSkillContent = Boolean(input.injectedSkills.content.trim());
  if (!hasToolSurface && !hasPluginSurface && !hasMcpSurface && !hasModeSurface && !hasAgentArtifacts && skillSections.length === 0 && extraSections.length === 0 && !hasSkillContent) {
    return '';
  }

  return renderContextManifest({
    scope: 'worker',
    sessionId: input.sessionId,
    toolSurface: input.toolSurface,
    plugins: {
      ...input.pluginSurface,
      skills: skillSections.map((skill) => ({
        name: skill.name,
        source: skill.source,
        path: skill.path,
        plugin: (skill as unknown as { plugin?: string }).plugin,
        truncated: skill.truncated,
      })) ?? [],
    },
    mcp: input.mcpSurface,
    modes: input.modes,
    agentArtifacts: input.agentArtifacts,
    sections: [
      ...extraSections,
      ...(hasSkillContent
        ? [{
            title: getPromptCatalog(input.locale).workerTask.injectedSkillBodiesTitle,
            content: input.injectedSkills.content,
          }]
        : []),
    ],
  });
}

export function buildWorkerTaskPrompt(input: {
  task: { id: string; subject: string; description: string; context?: string; working_directory?: string; write_scope?: string[] };
  workspace: string;
  sessionId: string;
  role: string;
  globalSkillsDir: string;
  projectSkillsDir: string;
  injectedSkills: InjectedSkills;
  toolSurface?: ContextManifestToolSurface;
  pluginSurface?: ContextManifestPluginSurface;
  mcpSurface?: ContextManifestMcpSurface;
  modes?: ContextManifestModeSurface;
  agentArtifacts?: ContextManifestAgentArtifact[];
  manifestSections?: ContextManifestSection[];
  blackboardEnabled?: boolean;
  locale?: PromptLocale;
}): string {
  const { task, workspace, sessionId, role, globalSkillsDir, projectSkillsDir, injectedSkills } = input;
  const locale = input.locale;
  const text = getPromptCatalog(locale).workerTask;
  const writeScope = task.write_scope && task.write_scope.length > 0 ? task.write_scope.join(', ') : workspace;
  const teamCommunicationEnabled = input.modes?.active?.includes('team') === true;
  const capabilityManifest = buildInjectedSkillManifest({
    sessionId,
    injectedSkills,
    toolSurface: input.toolSurface,
    pluginSurface: input.pluginSurface,
    mcpSurface: input.mcpSurface,
    modes: input.modes,
    agentArtifacts: input.agentArtifacts,
    sections: input.manifestSections,
    locale,
  });

  return joinBlocks([
    section(text.taskContextHeading, [
      `**ID**: ${task.id} | **${text.taskGoalLabel}**: ${task.subject}`,
      '',
      `**${text.taskDescriptionLabel}**:`, task.description,
      '',
      `**${text.workspaceLabel}**: ${workspace} | **${text.writeScopeLabel}**: ${writeScope} | **${text.sessionLabel}**: ${sessionId}`,
      '',
      estimateTaskBudget(task.subject, task.description, locale),
    ]),

    ...((task.context || capabilityManifest) ? renderContextSections(task.context ?? '', capabilityManifest, locale) : []),

    buildCapabilitySurfaceProtocol(locale),

    ...(input.blackboardEnabled ? [section(text.knowledgeGraphHeading, [
      text.knowledgeGraphIntro,
      text.knowledgeGraphAction,
      '```graph_fact {"title","content","tags","confidence","evidence"}```',
      '```graph_intent {"title","content","tags","priority"}```',
      '```graph_edge {"from","to","type"}```',
      '```graph_supersede {"old_node_id"}```',
    ])] : []),

    section(text.skillPathRulesHeading, [
      text.skillPriorityLine({ projectSkillsDir, globalSkillsDir }),
      text.skillPathLine,
      injectedSkills.names.length > 0 ? text.autoInjectedLine(injectedSkills.names) : '',
      injectedSkills.names.length > 0 ? text.skillBodiesLine : '',
    ].filter(Boolean)),

    buildSessionScopeSection({ workspace, sessionId }),
    buildScratchpadSection({ workspace, sessionId, taskId: task.id, role }),

    section(text.deliverySopHeading, [
      bullets([
        buildCompleteDeliveryPrinciple(locale),
        text.deliveryScopeRule,
        text.deliveryCompletenessRule,
        buildBrowserAcceptanceRule(locale),
        text.deliveryPageEvidenceRule,
      ]),
    ]),

    section(text.collaborationHeading, [
      bullets(text.collaborationRules({ taskId: task.id })),
    ]),

    ...(teamCommunicationEnabled
      ? [section(text.teamCommunicationHeading, [
          bullets(text.teamCommunicationRules),
        ])]
      : []),

    buildWorkerWriteWorkNoteSection(),
    buildIncrementalWriteRule(),

    text.startInstruction,
    getPromptLanguageDirective(locale),
  ]);
}
