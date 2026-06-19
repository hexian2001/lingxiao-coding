/**
 * BootstrapDoctor - 确定性安装与初始化检查
 *
 * 5.1: 暴露明确的 ready/not-ready 结果
 * 5.2: 验证 config, database latest-schema init, bundled skills sync, CLI availability
 */

import { existsSync, accessSync, constants, readFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { CONFIG_DIR, SETTINGS_FILE, config } from '../config.js';
import { commandExists } from '../utils/platform.js';
import {
  getBundledSkillsDir,
  getGlobalSkillsDir,
  syncBundledSkillsToGlobalDir,
} from './BundledSkillRegistry.js';

const INIT_HINT = 'Run: lingxiao init';
const SKILLS_HINT = 'Run: lingxiao init to sync bundled skills';
const REQUIRED_NODE_MAJOR = 24;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export interface BootstrapCheck {
  name: string;
  status: 'ok' | 'warning' | 'error';
  message: string;
  remediation?: string;
}

export interface BootstrapReport {
  ready: boolean;
  checks: BootstrapCheck[];
  summary: string;
}

export interface BootstrapOptions {
  workspace?: string;
  verbose?: boolean;
  repair?: boolean;
}

function resolveWorkspacePath(options: BootstrapOptions = {}): string {
  return resolve(options.workspace || process.cwd());
}

/**
 * 检查 Node.js 版本
 */
function checkNodeVersion(): BootstrapCheck {
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split('.')[0], 10);

  if (major < REQUIRED_NODE_MAJOR) {
    return {
      name: 'node_version',
      status: 'error',
      message: `Node.js ${nodeVersion} is too old (requires >= ${REQUIRED_NODE_MAJOR})`,
      remediation: `Upgrade Node.js to version ${REQUIRED_NODE_MAJOR} or higher`,
    };
  }

  return {
    name: 'node_version',
    status: 'ok',
    message: `Node.js ${nodeVersion}`,
  };
}

/**
 * 检查配置文件
 */
function checkConfig(): BootstrapCheck {
  if (!existsSync(CONFIG_DIR)) {
    return {
      name: 'config',
      status: 'error',
      message: `Config directory does not exist: ${CONFIG_DIR}`,
      remediation: INIT_HINT,
    };
  }

  if (!existsSync(SETTINGS_FILE)) {
    return {
      name: 'config',
      status: 'error',
      message: `Settings file does not exist: ${SETTINGS_FILE}`,
      remediation: INIT_HINT,
    };
  }

  try {
    const settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
    if (!settings.initialized) {
      return {
        name: 'config',
        status: 'error',
        message: 'Settings file exists but not marked as initialized',
        remediation: 'Run lingxiao init to complete initialization',
      };
    }

    // v3: 检查 model_providers 中是否有可用模型
    const llm = settings.llm || {};
    const modelProviders = llm.model_providers || {};
    const totalModels = Object.values(modelProviders as Record<string, unknown[]>)
      .reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
    const leaderModel = llm.leader_model || '';
    if (totalModels === 0 || !leaderModel) {
      return {
        name: 'config',
        status: 'error',
        message: 'No models configured in model_providers',
        remediation: 'Add at least one model entry to llm.model_providers in settings.json',
      };
    }

    return {
      name: 'config',
      status: 'ok',
      message: 'Configuration is valid',
    };
  } catch (error) {
    return {
      name: 'config',
      status: 'error',
      message: `Failed to parse settings file: ${error}`,
      remediation: 'Delete settings file and run lingxiao init again',
    };
  }
}

/**
 * 检查数据库
 */
function checkDatabase(options: BootstrapOptions = {}): BootstrapCheck {
  // 实际 DB 路径来自全局 config（~/.lingxiao/data.db），不是 workspace/.lingxiao/
  const dbPath = config.paths?.db_path || join(CONFIG_DIR, 'data.db');

  if (!existsSync(dbPath)) {
    return {
      name: 'database',
      status: 'warning',
      message: `Database file does not exist: ${dbPath}`,
      remediation: 'Database will be created automatically on first run',
    };
  }

  try {
    accessSync(dbPath, constants.R_OK | constants.W_OK);
    return {
      name: 'database',
      status: 'ok',
      message: `Database is accessible: ${dbPath}`,
    };
  } catch (error) {
    return {
      name: 'database',
      status: 'error',
      message: `Database file not accessible: ${error}`,
      remediation: 'Check file permissions or delete the database file to recreate',
    };
  }
}

/**
 * 检查 bundled skills
 */
function checkBundledSkills(options: BootstrapOptions = {}): BootstrapCheck {
  if (options.repair) {
    try {
      const result = syncBundledSkillsToGlobalDir({ workspace: resolveWorkspacePath(options) });
      return {
        name: 'bundled_skills',
        status: 'ok',
        message: `Bundled skills synced (copied=${result.copied.length}, skipped=${result.skipped.length}, removed=${result.removed.length})`,
      };
    } catch (error) {
      return {
        name: 'bundled_skills',
        status: 'warning',
        message: `Failed to sync bundled skills: ${error instanceof Error ? error.message : String(error)}`,
        remediation: SKILLS_HINT,
      };
    }
  }

  const bundledSkillsDir = getBundledSkillsDir();
  const globalSkillsDir = getGlobalSkillsDir();

  if (!existsSync(bundledSkillsDir)) {
    return {
      name: 'bundled_skills',
      status: 'warning',
      message: `Bundled skills directory does not exist: ${bundledSkillsDir}`,
      remediation: SKILLS_HINT,
    };
  }

  if (!existsSync(globalSkillsDir)) {
    return {
      name: 'global_skills_dir',
      status: 'warning',
      message: `Global skills directory does not exist: ${globalSkillsDir}`,
      remediation: SKILLS_HINT,
    };
  }

  return {
    name: 'bundled_skills',
    status: 'ok',
    message: 'Bundled skills are available',
  };
}

/**
 * 检查 CLI 可用性
 */
function checkCLI(_options: BootstrapOptions = {}): BootstrapCheck {
  const localCliPath = resolve(MODULE_DIR, '../cli.js');
  const packagedCliPath = resolve(MODULE_DIR, '../../dist/cli.js');

  if (!existsSync(localCliPath) && !existsSync(packagedCliPath) && !commandExists('lingxiao')) {
    return {
      name: 'cli_entry',
      status: 'error',
      message: 'No executable LingXiao CLI entry was found',
      remediation: 'Install the package first, then run: lingxiao init',
    };
  }

  return {
    name: 'cli',
    status: 'ok',
    message: 'CLI entry is available',
  };
}

/**
 * 检查日志目录
 */
function checkLogDirectory(_options: BootstrapOptions = {}): BootstrapCheck {
  const logDir = join(CONFIG_DIR, 'logs');

  if (!existsSync(logDir)) {
    try {
      mkdirSync(logDir, { recursive: true });
      return {
        name: 'log_dir',
        status: 'ok',
        message: `Created log directory: ${logDir}`,
      };
    } catch (error) {
      return {
        name: 'log_dir',
        status: 'warning',
        message: `Failed to create log directory: ${error}`,
        remediation: 'Create the log directory manually or check permissions',
      };
    }
  }

  return {
    name: 'log_dir',
    status: 'ok',
    message: `Log directory exists: ${logDir}`,
  };
}

/**
 * 运行完整的 bootstrap 检查
 */
export function runBootstrapDoctor(options: BootstrapOptions = {}): BootstrapReport {
  const checks: BootstrapCheck[] = [
    checkNodeVersion(),
    checkConfig(),
    checkDatabase(options),
    checkBundledSkills(options),
    checkCLI(options),
    checkLogDirectory(options),
  ];

  const errors = checks.filter(c => c.status === 'error');
  const warnings = checks.filter(c => c.status === 'warning');

  const ready = errors.length === 0;

  let summary: string;
  if (ready && warnings.length === 0) {
    summary = 'All checks passed. System is ready.';
  } else if (ready) {
    summary = `System is ready with ${warnings.length} warning(s).`;
  } else {
    summary = `System is NOT ready. ${errors.length} error(s) found.`;
  }

  return {
    ready,
    checks,
    summary,
  };
}

/**
 * 格式化报告为字符串
 */
export function formatBootstrapReport(report: BootstrapReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('╔════════════════════════════════════════════════════════════╗');
  lines.push(report.ready
    ? '║  ✅ Bootstrap Check: READY                                 ║'
    : '║  ❌ Bootstrap Check: NOT READY                             ║'
  );
  lines.push('╠════════════════════════════════════════════════════════════╣');

  for (const check of report.checks) {
    const icon = check.status === 'ok' ? '✅'
      : check.status === 'warning' ? '⚠️'
      : '❌';
    const msg = check.message.length > 30 ? check.message.slice(0, 27) + '...' : check.message;
    lines.push(`║ ${icon} ${check.name.padEnd(20)} ${msg.padEnd(30)} ║`);
    if (check.remediation && check.status !== 'ok') {
      const rem = check.remediation.length > 48 ? check.remediation.slice(0, 45) + '...' : check.remediation;
      lines.push(`║    → ${rem.padEnd(48)} ║`);
    }
  }

  lines.push('╠════════════════════════════════════════════════════════════╣');
  lines.push(`║ ${report.summary.padEnd(58)} ║`);
  lines.push('╚════════════════════════════════════════════════════════════╝');
  lines.push('');

  return lines.join('\n');
}

export default {
  runBootstrapDoctor,
  formatBootstrapReport,
};
