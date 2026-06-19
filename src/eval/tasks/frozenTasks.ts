/**
 * 冻结漂移任务集 — 漂移 eval harness 的 ground truth。
 *
 * 每个任务有明确的 prompt + expectedFiles(golden end-state)+ allowedScope。
 * 同一任务跑 N 次,看 agent 每次改的文件集合是否一致(changedFileSetInstability)、
 * 是否触碰范围外(outOfScopeCount)、是否改了预期外文件(unexpectedChangedFiles)。
 *
 * 起步用小而确定的任务(漂移信号清晰、运行快);逐步加复杂度。
 * 这些是凌霄自身仓库友好的通用任务,workspace 由 runDriftEval 在隔离目录内准备。
 */

import type { DriftEvalTask } from '../DriftEvalRunner.js';

export const FROZEN_DRIFT_TASKS: DriftEvalTask[] = [
  {
    id: 'add-util-addfn',
    title: '创建 add 工具函数',
    source: 'internal_golden',
    prompt: '在 src/utils/calc.ts 中创建一个 add(a, b) 函数,返回两数之和,并用 CommonJS 或 ESM 导出。不要修改其他文件。',
    testCommands: ['node -e "require(\'./src/utils/calc.ts\')" || true'],
    expectedFiles: ['src/utils/calc.ts'],
    allowedScope: ['src/utils'],
  },
  {
    id: 'add-greeting-hello',
    title: '创建 hello 问候函数',
    source: 'internal_golden',
    prompt: '创建 src/utils/greet.ts,导出 hello() 函数,返回字符串 "hello"。仅此一个文件。',
    testCommands: ['node -e "require(\'./src/utils/greet.ts\')" || true'],
    expectedFiles: ['src/utils/greet.ts'],
    allowedScope: ['src/utils'],
  },
  {
    id: 'add-readme-section',
    title: '在 README 添加安装段落',
    source: 'internal_golden',
    prompt: '在 README.md 顶部添加一个 "## Installation" 段落,内容为 "npm install"。只改 README.md。',
    testCommands: ['grep -q "## Installation" README.md'],
    expectedFiles: ['README.md'],
    allowedScope: ['README.md'],
  },
];
