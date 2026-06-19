#!/usr/bin/env node
/**
 * organize-tests.mjs
 *
 * 将 src/ 根目录散落的 .test.ts 文件移动到对应的模块子目录，
 * 并将 import 路径从 './xxx' 修复为 '../xxx'。
 *
 * 移动规则：
 *   - agents/  — agent pool、leader、worker、role、harness、team、task 相关
 *   - commands/ — CLI 命令
 *   - config/  — 配置、provider 检测
 *   - core/    — session、project、permission、bootstrap、context、message bus 等
 *   - llm/     — LLM client、provider、model capabilities、token limits
 *   - tools/   — tool 实现相关
 *   - tui/     — 终端 UI
 *   (root)     — 留在 src/ 根目录（集成测试或跨模块）
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'src');

// ── 映射表：文件名 → 目标子目录（相对于 src/）─────────────────────────────
const MOVES = {
  // ── agents/ ──────────────────────────────────────────────────────────
  'agent_core.test.ts':                          'agents',
  'agent_pool_authority.test.ts':                'agents',
  'agent_pool_interactive_state.test.ts':        'agents',
  'agent_runtime_state.test.ts':                 'agents',
  'autonomous_fault_policy.test.ts':             'agents',
  'blocked_aging_policy.test.ts':                'agents',
  'completion_termination_policy.test.ts':       'agents',
  'content_loop_detector.test.ts':               'agents',
  'expert_matcher.test.ts':                      'agents',
  'handoff_coordinator.test.ts':                 'agents',
  'harness_eternal_protocol.test.ts':            'agents',
  'harness_manager.test.ts':                     'agents',
  'interaction_runtime_kernel.test.ts':          'agents',
  'interaction_runtime_state.test.ts':           'agents',
  'leader_core.test.ts':                         'agents',
  'leader_routing_policy.test.ts':               'agents',
  'leader_supervision_policy.test.ts':           'agents',
  'leader_tools_agent_name_normalization.test.ts': 'agents',
  'leader_tools_create_task_autorole.test.ts':   'agents',
  'leader_tools_dispatch_conflict_removal.test.ts': 'agents',
  'llm_round_executor.test.ts':                  'agents',
  'message_bus_priority.test.ts':                'agents',
  'next_speaker_policy.test.ts':                 'agents',
  'portfolio_scheduler.test.ts':                 'agents',
  'preset_role_enhancement.test.ts':             'agents',
  'project_health_policy.test.ts':               'agents',
  'prompt_architecture.test.ts':                 'agents',
  'prompt_proactivity.test.ts':                  'agents',
  'raw_tool_calls.test.ts':                      'agents',
  'reasoning_bounds.test.ts':                    'agents',
  'reasoning_loop_driver.test.ts':               'agents',
  'role_capability_model.test.ts':               'agents',
  'team_synchronizer.test.ts':                   'agents',
  'tool_response_processor.test.ts':             'agents',
  'tool_scheduler.test.ts':                      'agents',
  'worker_completion_policy.test.ts':            'agents',
  'worker_interactive_runtime.test.ts':          'agents',
  'session_user_input_intervention.test.ts':     'agents',

  // ── commands/ ────────────────────────────────────────────────────────
  'cli_snapshot.test.ts':                        'commands',
  'command_registry.test.ts':                    'commands',

  // ── config/ ──────────────────────────────────────────────────────────
  'config-env.test.ts':                          'config',
  'config_provider_detection.test.ts':           'config',

  // ── core/ ────────────────────────────────────────────────────────────
  'agent_protocol.test.ts':                      'core',
  'bootstrap_init.test.ts':                      'core',
  'bundled_skill_registry.test.ts':              'core',
  'cli_data.test.ts':                            'core',
  'cli_helpers.test.ts':                         'core',
  'context_manager.test.ts':                     'core',
  'context_runtime.test.ts':                     'core',
  'eternal_runtime_telemetry.test.ts':           'core',
  'integration_redesign.test.ts':                'core',
  'leader_recovery_dedup.test.ts':               'core',
  'multimodal_behavior.test.ts':                 'core',
  'permission_store.test.ts':                    'core',
  'permission_surface.test.ts':                  'core',
  'permission_system.test.ts':                   'core',
  'project_control_service.test.ts':             'core',
  'project_retention_policy.test.ts':            'core',
  'project_runtime_manager.test.ts':             'core',
  'project_runtime_reconciler.test.ts':          'core',
  'result_lineage_guard.test.ts':                'core',
  'runtime_diagnostics.test.ts':                 'core',
  'scoring_engine.test.ts':                      'core',
  'session_artifact_paths_consistency.test.ts':  'core',
  'session_artifacts.test.ts':                   'core',
  'session_interrupt_semantics.test.ts':         'core',
  'session_isolation.test.ts':                   'core',
  'session_manager_identity_guard.test.ts':      'core',
  'session_runtime.test.ts':                     'core',
  'task_board_cancel.test.ts':                   'core',
  'work_note_manager.test.ts':                   'core',

  // ── llm/ ─────────────────────────────────────────────────────────────
  'llm_client_config_fallback.test.ts':          'llm',
  'llm_error_classification.test.ts':            'llm',
  'local_vision_fallback.test.ts':               'llm',
  'model_capability_config.test.ts':             'llm',
  'provider_runtime.test.ts':                    'llm',
  'token_counter_precision.test.ts':             'llm',

  // ── tools/ ───────────────────────────────────────────────────────────
  'network_governance.test.ts':                  'tools',
  'python_exec.test.ts':                         'tools',
  'sandboxed_execution_runtime.test.ts':         'tools',
  'scratchpad_review.test.ts':                   'tools',
  'web_tools.test.ts':                           'tools',

  // ── tui/ ─────────────────────────────────────────────────────────────
  'mouse_wheel.test.ts':                         'tui',

  // ── root（集成测试 / 跨模块，保留原位）─────────────────────────────
  // harness_integration.test.ts
  // skill_injection.test.ts
  // sprint_contract.test.ts
  // task_collaboration_scope.test.ts
  // write_serialization.test.ts
  // xml_fallback_behavior.test.ts
  // spec_manager.test.ts
};

// ── 执行移动 ─────────────────────────────────────────────────────────────────

let moved = 0;
let skipped = 0;
let errors = 0;

for (const [filename, targetDir] of Object.entries(MOVES)) {
  const srcPath  = join(SRC, filename);
  const destDir  = join(SRC, targetDir);
  const destPath = join(destDir, filename);

  if (!existsSync(srcPath)) {
    console.log(`  skip  ${filename} (not found)`);
    skipped++;
    continue;
  }

  if (existsSync(destPath)) {
    console.log(`  skip  ${filename} (already exists in ${targetDir}/)`);
    skipped++;
    continue;
  }

  try {
    // 确保目标目录存在
    mkdirSync(destDir, { recursive: true });

    // 读取源文件，修复 import 路径
    let content = readFileSync(srcPath, 'utf-8');

    // 将 './xxx' 改为 '../xxx'（单层深度，不影响 'node:xxx' 或 外部包）
    // 只替换以 './' 开头的相对导入（不改 '../' 已是上层的）
    content = content.replace(
      /from '(\.[^']+)'/g,
      (match, importPath) => {
        if (importPath.startsWith('./')) {
          return `from '../${importPath.slice(2)}'`;
        }
        return match;
      }
    );
    // 同样处理 require('./xxx')
    content = content.replace(
      /require\('(\.[^']+)'\)/g,
      (match, importPath) => {
        if (importPath.startsWith('./')) {
          return `require('../${importPath.slice(2)}')`;
        }
        return match;
      }
    );

    // 写入目标位置
    writeFileSync(destPath, content, 'utf-8');

    // 删除原文件
    import('fs').then(({ unlinkSync }) => unlinkSync(srcPath));

    console.log(`  moved ${filename} → ${targetDir}/`);
    moved++;
  } catch (err) {
    console.error(`  ERROR ${filename}: ${err.message}`);
    errors++;
  }
}

console.log(`\nDone: ${moved} moved, ${skipped} skipped, ${errors} errors`);
