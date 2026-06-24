/**
 * DeterministicAcceptance — 确定性验收
 *
 * 从 contract (surface/content/criteria) 自动推导可执行的验收断言。
 * evaluator 必须跑通这些确定性检查才能标记 PASS。
 *
 * 核心理念：
 * - LLM 判断是"主观验收"——可作为补充但不能是唯一标准
 * - 确定性验收 = 可重复执行的命令/断言序列
 * - 从 contract 推导，不需要人工编写测试
 *
 * 推导策略：
 * - API contract (surface = "POST /api/xxx") → HTTP 请求断言
 * - Type contract (surface = "types.User") → tsc --noEmit 类型检查
 * - UI contract (surface = "page:/dashboard") → browser_visual_verify
 * - Build contract (surface = "build:pass") → shell 命令退出码
 * - Custom criteria → 转换为 shell 命令或 grep 检查
 */

import type { LedgerEntry } from './SharedLedger.js';

export type AcceptanceCheckType = 'http_assert' | 'type_check' | 'browser_verify' | 'shell_command' | 'file_content';

export interface AcceptanceCheck {
  /** 唯一 ID */
  id: string;
  /** 来源 contract */
  contractId: string;
  contractSurface: string;
  /** 检查类型 */
  type: AcceptanceCheckType;
  /** 人类可读描述 */
  description: string;
  /** 具体执行步骤 */
  execution: AcceptanceExecution;
  /** 是否必须通过（critical gate） */
  critical: boolean;
}

export type AcceptanceExecution =
  | { kind: 'http'; method: string; path: string; expectedStatus: number; bodyContains?: string }
  | { kind: 'shell'; command: string; expectedExitCode: number; outputContains?: string }
  | { kind: 'browser'; url: string; assertions: BrowserAssertion[] }
  | { kind: 'file_exists'; paths: string[] }
  | { kind: 'type_check'; command: string };

export interface BrowserAssertion {
  type: 'text_visible' | 'selector_exists' | 'no_console_errors';
  value?: string;
}

export interface AcceptanceSuite {
  /** 来源 contracts */
  contracts: string[];
  /** 全部检查项 */
  checks: AcceptanceCheck[];
  /** 关键检查项（必须全通过） */
  criticalChecks: AcceptanceCheck[];
  /** 渲染为 evaluator 可执行的指令 */
  rendered: string;
}

export class DeterministicAcceptance {
  /**
   * 从一组 contract 条目推导验收套件
   */
  buildSuite(contracts: LedgerEntry[], options?: { baseUrl?: string; buildCommand?: string }): AcceptanceSuite {
    const checks: AcceptanceCheck[] = [];

    for (const contract of contracts) {
      const derived = this.deriveChecks(contract, options);
      checks.push(...derived);
    }

    // 总是添加构建检查
    checks.push({
      id: 'build-pass',
      contractId: 'system',
      contractSurface: 'build:pass',
      type: 'shell_command',
      description: '项目构建无错误',
      execution: {
        kind: 'shell',
        command: options?.buildCommand || 'npx tsc --noEmit',
        expectedExitCode: 0,
      },
      critical: true,
    });

    const criticalChecks = checks.filter(c => c.critical);
    return {
      contracts: contracts.map(c => c.id),
      checks,
      criticalChecks,
      rendered: this.renderForEvaluator(checks),
    };
  }

  /**
   * 从单个 contract 推导检查项
   */
  private deriveChecks(contract: LedgerEntry, options?: { baseUrl?: string }): AcceptanceCheck[] {
    const checks: AcceptanceCheck[] = [];
    const surface = contract.surface;

    // API contract: "GET /api/users", "POST /api/auth/login"
    const apiMatch = surface.match(/^(GET|POST|PUT|DELETE|PATCH)\s+(.+)$/i);
    if (apiMatch) {
      checks.push(this.buildApiCheck(contract, apiMatch[1].toUpperCase(), apiMatch[2], options?.baseUrl));
      return checks;
    }

    // Page contract: "page:/dashboard", "page:/login"
    const pageMatch = surface.match(/^page:(.+)$/i);
    if (pageMatch) {
      checks.push(this.buildBrowserCheck(contract, pageMatch[1], options?.baseUrl));
      return checks;
    }

    // Type contract: "types.User", "interface.ApiResponse"
    if (surface.startsWith('types.') || surface.startsWith('interface.')) {
      checks.push(this.buildTypeCheck(contract));
      return checks;
    }

    // File contract: "file:src/xxx.ts"
    const fileMatch = surface.match(/^file:(.+)$/i);
    if (fileMatch) {
      checks.push({
        id: `file-${contract.id}`,
        contractId: contract.id,
        contractSurface: surface,
        type: 'file_content',
        description: `文件存在: ${fileMatch[1]}`,
        execution: { kind: 'file_exists', paths: [fileMatch[1]] },
        critical: false,
      });
      return checks;
    }

    // 从 contract content 中提取 criteria（如果有结构化的验收标准）
    const criteriaChecks = this.extractCriteriaChecks(contract);
    if (criteriaChecks.length > 0) {
      checks.push(...criteriaChecks);
    }

    return checks;
  }

  private buildApiCheck(
    contract: LedgerEntry,
    method: string,
    path: string,
    baseUrl?: string,
  ): AcceptanceCheck {
    const url = baseUrl ? `${baseUrl}${path}` : `http://localhost:3000${path}`;
    return {
      id: `api-${contract.id}`,
      contractId: contract.id,
      contractSurface: contract.surface,
      type: 'http_assert',
      description: `API 可达: ${method} ${path}`,
      execution: {
        kind: 'http',
        method,
        path: url,
        expectedStatus: method === 'POST' ? 201 : 200,
      },
      critical: true,
    };
  }

  private buildBrowserCheck(
    contract: LedgerEntry,
    pagePath: string,
    baseUrl?: string,
  ): AcceptanceCheck {
    const url = baseUrl ? `${baseUrl}${pagePath}` : `http://localhost:3000${pagePath}`;
    // 从 contract content 提取期望的文本/元素
    const assertions: BrowserAssertion[] = [
      { type: 'no_console_errors' },
    ];
    // 尝试从 content 提取关键文本
    const textMatches = contract.content.match(/(?:显示|展示|包含|shows?|displays?|contains?)\s*[：:]\s*[""]([^""]+)[""]/gi);
    if (textMatches) {
      for (const match of textMatches.slice(0, 3)) {
        const text = match.replace(/^.*[：:]\s*[""]/, '').replace(/[""]$/, '');
        if (text) assertions.push({ type: 'text_visible', value: text });
      }
    }

    return {
      id: `browser-${contract.id}`,
      contractId: contract.id,
      contractSurface: contract.surface,
      type: 'browser_verify',
      description: `页面验证: ${pagePath}`,
      execution: { kind: 'browser', url, assertions },
      critical: true,
    };
  }

  private buildTypeCheck(contract: LedgerEntry): AcceptanceCheck {
    return {
      id: `type-${contract.id}`,
      contractId: contract.id,
      contractSurface: contract.surface,
      type: 'type_check',
      description: `类型检查: ${contract.surface}`,
      execution: { kind: 'type_check', command: 'npx tsc --noEmit' },
      critical: true,
    };
  }

  /**
   * 从 contract content 中提取结构化的 criteria
   */
  private extractCriteriaChecks(contract: LedgerEntry): AcceptanceCheck[] {
    const checks: AcceptanceCheck[] = [];
    // 匹配 "- [ ] xxx" 或 "- xxx" 格式的 criteria
    const lines = contract.content.split('\n');
    let idx = 0;
    for (const line of lines) {
      const criteriaMatch = line.match(/^\s*-\s*(?:\[[ x]\]\s*)?(.+)$/);
      if (criteriaMatch && criteriaMatch[1].length > 10) {
        const criterion = criteriaMatch[1].trim();
        // 如果 criterion 看起来像是命令
        if (criterion.startsWith('`') || criterion.includes('exit code') || criterion.includes('运行')) {
          const cmd = criterion.replace(/^`|`$/g, '').trim();
          checks.push({
            id: `criteria-${contract.id}-${idx}`,
            contractId: contract.id,
            contractSurface: contract.surface,
            type: 'shell_command',
            description: criterion,
            execution: { kind: 'shell', command: cmd, expectedExitCode: 0 },
            critical: false,
          });
        }
        idx++;
      }
    }
    return checks;
  }

  /**
   * 渲染为 evaluator 可执行的指令格式
   */
  private renderForEvaluator(checks: AcceptanceCheck[]): string {
    const lines = [
      '## 确定性验收清单',
      '',
      '以下检查项必须全部通过才能标记任务为 PASS：',
      '',
    ];

    for (const check of checks) {
      const icon = check.critical ? '🔴' : '🟡';
      lines.push(`${icon} **${check.description}**`);
      switch (check.execution.kind) {
        case 'shell':
          lines.push(`   执行: \`${check.execution.command}\``);
          lines.push(`   期望: exit code = ${check.execution.expectedExitCode}`);
          break;
        case 'http':
          lines.push(`   请求: ${check.execution.method} ${check.execution.path}`);
          lines.push(`   期望: status = ${check.execution.expectedStatus}`);
          break;
        case 'browser':
          lines.push(`   打开: ${check.execution.url}`);
          for (const a of check.execution.assertions) {
            lines.push(`   断言: ${a.type}${a.value ? ` = "${a.value}"` : ''}`);
          }
          break;
        case 'file_exists':
          lines.push(`   检查文件存在: ${check.execution.paths.join(', ')}`);
          break;
        case 'type_check':
          lines.push(`   执行: \`${check.execution.command}\``);
          break;
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}
