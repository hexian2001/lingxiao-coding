import { bullets, numbered } from '../shared/prompt_builder.js';

/**
 * 增强版思考指导：工作笔记 + 结构化思考 + 自我验证
 */
function buildEnhancedThinkingInstruction(): string {
  return [
    '每次行动前先写简短工作笔记：',
    '',
    '[工作笔记]',
    '- 状态: 当前掌握的关键信息',
    '- 判断: 对任务的理解与决策依据',
    '- 动作: 即将执行的具体步骤',
    '[/工作笔记]',
    '',
    bullets([
      '笔记简短具体、面向执行，写真实状态、判断依据和下一步动作',
      '拿到工具结果后更新判断再继续',
      '笔记写完立即调用与动作匹配的工具，或在无需工具时直接给出基于证据的结果',
    ]),
    '',
    '**思考流程**：',
    numbered([
      '理解 → 先读代码/文档，再下结论',
      '方案 → 选最小改动、最低风险路径',
      '实施 → 分步执行，每步确认结果',
      '验证 → 编译或测试确认无报错再收尾',
    ]),
    '',
    '**完成前自检**：',
    bullets([
      '改动是否符合任务要求？有无遗漏文件/接口？',
      '编译/测试是否通过？总结是否含具体证据？',
    ]),
  ].join('\n');
}

export const THINKING_INSTRUCTION = buildEnhancedThinkingInstruction();
