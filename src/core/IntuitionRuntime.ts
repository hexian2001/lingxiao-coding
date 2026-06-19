import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { config as runtimeConfig } from '../config.js';
import type { MessageContent } from '../llm/types.js';
import { MemoryManager } from '../memory/MemoryManager.js';

export interface IntuitionSnapshot {
  enabled: boolean;
  tacitMode: boolean;
  profile: 'balanced' | 'low_interrupt' | 'autonomous_partner';
  tone: string;
  userSignals: string[];
  projectSignals: string[];
  prompt: string;
}

const DEFAULT_USER_SOUL = [
  '用户希望凌霄成为更强的单兵研发伙伴，而不是机械流程工具。',
  '用户讨厌外显、僵硬、强制的约束和审批，偏好低打扰、高自主、真正理解。',
  '用户偏好 evidence-backed intelligence：直接读上下文、代码和证据来形成判断。',
  '用户希望前端、后端、TUI、Agent 运行时整体理解，相关改动连起来看。',
  '默认要认真读代码、主动判断、自然推进，只在高风险或不可逆时简短确认。',
];

const SOURCE_DIRS = ['src', 'web/src', 'test', 'docs'];
const IMPORTANT_FILES = ['package.json', 'tsconfig.json', 'src/server.ts', 'src/core/SessionManager.ts', 'web/src/App.tsx'];

function safeRead(path: string, maxChars: number): string {
  try {
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf-8').slice(0, maxChars);
  } catch {/* expected: fallback to default */
    return '';
  }
}

function detectProjectSignals(workspacePath: string): string[] {
  const signals: string[] = [];
  const packageJson = safeRead(join(workspacePath, 'package.json'), 6000);
  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson) as { name?: string; description?: string; scripts?: Record<string, string>; dependencies?: Record<string, string> };
      if (pkg.name) signals.push(`项目: ${pkg.name}${pkg.description ? ` — ${pkg.description}` : ''}`);
      const scripts = Object.keys(pkg.scripts || {}).slice(0, 8);
      if (scripts.length) signals.push(`常用脚本: ${scripts.join(', ')}`);
      const deps = Object.keys(pkg.dependencies || {});
      const stack = ['fastify', 'react', 'ink', 'playwright', 'openai', '@anthropic-ai/sdk'].filter((name) => deps.includes(name));
      if (stack.length) signals.push(`技术栈信号: ${stack.join(', ')}`);
    } catch {/* swallowed: unhandled error */
      signals.push('存在 package.json，但解析失败');
    }
  }
  const presentDirs = SOURCE_DIRS.filter((dir) => existsSync(join(workspacePath, dir)));
  if (presentDirs.length) signals.push(`主要代码域: ${presentDirs.join(', ')}`);
  const important = IMPORTANT_FILES.filter((file) => existsSync(join(workspacePath, file)));
  if (important.length) signals.push(`关键入口: ${important.join(', ')}`);
  try {
    const rootEntries = readdirSync(workspacePath).filter((name) => !name.startsWith('.') && name !== 'node_modules').slice(0, 18);
    const dirs = rootEntries.filter((name) => {
      try { return statSync(join(workspacePath, name)).isDirectory(); } catch {/* swallowed: unhandled error */ return false; }
    });
    if (dirs.length) signals.push(`根目录模块: ${dirs.join(', ')}`);
  } catch {/* expected: best-effort cleanup */}
  return signals.slice(0, 8);
}

function loadLongTermMemorySignals(workspacePath: string): { user: string[]; project: string[] } {
  const user: string[] = [];
  const project: string[] = [];

  try {
    const manager = new MemoryManager(workspacePath);
    for (const entry of manager.listMemories('user').slice(0, 6)) {
      user.push(`${entry.name}: ${entry.description}`);
    }
    for (const entry of manager.listMemories('project').slice(0, 6)) {
      project.push(`${entry.name}: ${entry.description}`);
    }
  } catch {
    // Long-term memory is optional; intuition falls back to defaults and project signals.
  }

  return { user, project };
}

function buildPrompt(snapshot: Omit<IntuitionSnapshot, 'prompt'>): string {
  if (!snapshot.enabled) return '';
  return [
    '## 隐形理解层 (Lingxiao Intuition)',
    '',
    '这不是给用户看的流程约束，而是你的内在默契。你要像长期共事的单兵研发伙伴一样理解用户、项目和局势。',
    '',
    `- 默契模式: ${snapshot.tacitMode ? '开启，低打扰高自主' : '关闭，保持常规协作'}`,
    `- 伙伴画像: ${snapshot.profile}`,
    `- 沟通语气: ${snapshot.tone}`,
    '',
    '用户信号:',
    ...snapshot.userSignals.map((signal) => `- ${signal}`),
    '',
    '项目信号:',
    ...snapshot.projectSignals.map((signal) => `- ${signal}`),
    '',
    '行动原则:',
    '- 把这些内容转化为判断力，用户可见回复聚焦当前任务。',
    '- 直接阅读上下文、代码和证据，形成证据化判断。',
    '- 前端、后端、TUI、Agent 运行时相关改动连起来理解。',
    '- 默认低打扰自主推进；只有你真正判断存在高风险或不可逆动作时才简短确认。',
    '- 使用自然表达、成熟判断、可回滚行动和证据。',
  ].join('\n');
}

export function buildIntuitionSnapshot(message: MessageContent, workspacePath: string): IntuitionSnapshot {
  const memoryConfig = runtimeConfig.memory as typeof runtimeConfig.memory & {
    intuition_enabled?: boolean;
    tacit_mode_enabled?: boolean;
    intuition_profile?: IntuitionSnapshot['profile'];
  };
  const enabled = memoryConfig.intuition_enabled !== false;
  const tacitMode = memoryConfig.tacit_mode_enabled !== false;
  const profile = memoryConfig.intuition_profile || 'autonomous_partner';
  const tone = tacitMode ? '自然、直接、少流程感，像懂项目的伙伴' : '清晰、简洁、协作式';
  const memorySignals = loadLongTermMemorySignals(workspacePath);
  const userSignals = [
    ...DEFAULT_USER_SOUL,
    ...memorySignals.user,
  ].slice(0, 12);
  const projectSignals = [
    ...detectProjectSignals(workspacePath),
    ...memorySignals.project,
  ].slice(0, 12);
  const snapshotWithoutPrompt = {
    enabled,
    tacitMode,
    profile,
    tone,
    userSignals,
    projectSignals,
  } satisfies Omit<IntuitionSnapshot, 'prompt'>;
  return {
    ...snapshotWithoutPrompt,
    prompt: buildPrompt(snapshotWithoutPrompt),
  };
}
