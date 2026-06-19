/**
 * 变量解析器
 * 
 * 解析 workflow 中的变量引用语法：
 * - ${workflow.variables.userName} - 全局变量
 * - ${node_id.outputs.result} - 节点输出
 * - ${context.sessionId} - 执行上下文
 * - ${env.WORKSPACE} - 环境变量
 * - ${input.userInput} - 输入节点数据
 * - ${node_id.outputs.data.items[0].name} - JSONPath 深度访问
 * - ${node_id.outputs.result || 'default'} - 默认值
 */

import type { VariableScope } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readPathProperty(value: unknown, key: string): unknown {
  if (isRecord(value)) {
    return value[key];
  }
  return undefined;
}

export class VariableResolver {
  /**
   * 解析模板字符串中的变量引用
   * 
   * @param template - 包含 ${...} 语法的模板字符串
   * @param scope - 变量作用域
   * @returns 解析后的字符串
   */
  resolve(template: string, scope: VariableScope): unknown {
    if (typeof template !== 'string') {
      return String(template);
    }

    // 匹配 ${...} 语法，支持嵌套和转义
    const exactMatch = template.match(/^\$\{([^}]+)\}$/);
    if (exactMatch) {
      return this.resolveExpression(exactMatch[1].trim(), scope);
    }

    const regex = /\$\{([^}]+)\}/g;
    
    return template.replace(regex, (match, expression) => {
      try {
        const value = this.resolveExpression(expression.trim(), scope);
        return value !== undefined && value !== null ? String(value) : '';
      } catch (error) {
        // 变量解析失败时保留原始语法
        console.warn(`[VariableResolver] Failed to resolve: ${match}`, error);
        return match;
      }
    });
  }

  /**
   * 解析单个表达式
   * 
   * @param expression - 表达式字符串（不含 ${}）
   * @param scope - 变量作用域
   * @returns 解析后的值
   */
  private resolveExpression(expression: string, scope: VariableScope): unknown {
    // 处理默认值语法: expression || 'default'
    const defaultValueMatch = expression.match(/^(.+?)\s*\|\|\s*(.+)$/);
    if (defaultValueMatch) {
      const [, mainExpr, defaultExpr] = defaultValueMatch;
      try {
        const value = this.resolveExpression(mainExpr.trim(), scope);
        if (value !== undefined && value !== null && value !== '') {
          return value;
        }
      } catch {
        // 主表达式失败，使用默认值
      }
      // 解析默认值（可能是字符串字面量或另一个变量引用）
      return this.parseDefaultValue(defaultExpr.trim(), scope);
    }

    // 解析路径: workflow.variables.userName
    const parts = expression.split('.');
    if (parts.length === 0) {
      return undefined;
    }

    const root = parts[0];
    let current: unknown;

    // 根据根路径选择起始对象
    switch (root) {
      case 'workflow':
        current = scope.workflow;
        break;
      case 'context':
        current = scope.context;
        break;
      case 'nodes':
        current = scope.nodes;
        break;
      case 'input':
        current = scope.input;
        break;
      case 'env':
        current = scope.env;
        break;
      default:
        // 尝试作为节点 ID 直接访问
        if (scope.nodes[root]) {
          current = scope.nodes[root];
        } else {
          throw new Error(`Unknown root path: ${root}`);
        }
    }

    // 遍历路径
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      
      if (current === undefined || current === null) {
        return undefined;
      }

      // 处理数组索引: items[0]
      const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
      if (arrayMatch) {
        const [, key, index] = arrayMatch;
        const arrayValue = readPathProperty(current, key);
        if (Array.isArray(arrayValue)) {
          current = arrayValue[parseInt(index, 10)];
        } else {
          return undefined;
        }
      } else {
        current = readPathProperty(current, part);
      }
    }

    return current;
  }

  /**
   * 解析默认值
   * 
   * @param defaultExpr - 默认值表达式
   * @param scope - 变量作用域
   * @returns 解析后的默认值
   */
  private parseDefaultValue(defaultExpr: string, scope: VariableScope): unknown {
    // 字符串字面量: 'default' 或 "default"
    if ((defaultExpr.startsWith("'") && defaultExpr.endsWith("'")) ||
        (defaultExpr.startsWith('"') && defaultExpr.endsWith('"'))) {
      return defaultExpr.slice(1, -1);
    }

    // 数字字面量
    if (/^-?\d+(\.\d+)?$/.test(defaultExpr)) {
      return parseFloat(defaultExpr);
    }

    // 布尔字面量
    if (defaultExpr === 'true') return true;
    if (defaultExpr === 'false') return false;
    if (defaultExpr === 'null') return null;
    if (defaultExpr === 'undefined') return undefined;

    // 否则作为变量引用解析
    return this.resolveExpression(defaultExpr, scope);
  }

  /**
   * 解析对象中的所有变量引用
   * 
   * @param obj - 包含变量引用的对象
   * @param scope - 变量作用域
   * @returns 解析后的对象
   */
  resolveObject<T extends Record<string, unknown>>(obj: T, scope: VariableScope): T {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        result[key] = this.resolve(value, scope);
      } else if (Array.isArray(value)) {
        result[key] = value.map(item => {
          if (typeof item === 'string') return this.resolve(item, scope);
          if (item !== null && typeof item === 'object') return this.resolveObject(item as Record<string, unknown>, scope);
          return item;
        });
      } else if (value !== null && typeof value === 'object') {
        result[key] = this.resolveObject(value as Record<string, unknown>, scope);
      } else {
        result[key] = value;
      }
    }

    return result as T;
  }

  /**
   * 检查字符串是否包含变量引用
   * 
   * @param str - 待检查的字符串
   * @returns 是否包含变量引用
   */
  hasVariableReference(str: string): boolean {
    if (typeof str !== 'string') {
      return false;
    }
    return /\$\{[^}]+\}/.test(str);
  }

  /**
   * 提取字符串中的所有变量引用
   * 
   * @param str - 待提取的字符串
   * @returns 变量引用列表
   */
  extractVariableReferences(str: string): string[] {
    if (typeof str !== 'string') {
      return [];
    }

    const regex = /\$\{([^}]+)\}/g;
    const references: string[] = [];
    let match;

    while ((match = regex.exec(str)) !== null) {
      references.push(match[1].trim());
    }

    return references;
  }

  /**
   * 验证变量引用是否有效
   * 
   * @param expression - 变量引用表达式
   * @param scope - 变量作用域
   * @returns 是否有效
   */
  isValidReference(expression: string, scope: VariableScope): boolean {
    try {
      const value = this.resolveExpression(expression, scope);
      return value !== undefined;
    } catch {/* expected: operation may fail */
      return false;
    }
  }

  /**
   * 检测循环引用
   * 
   * @param template - 模板字符串
   * @param scope - 变量作用域
   * @param visited - 已访问的变量集合
   * @returns 是否存在循环引用
   */
  detectCircularReference(
    template: string,
    scope: VariableScope,
    visited: Set<string> = new Set()
  ): boolean {
    const references = this.extractVariableReferences(template);

    for (const ref of references) {
      if (visited.has(ref)) {
        return true; // 检测到循环引用
      }

      visited.add(ref);

      try {
        const value = this.resolveExpression(ref, scope);
        if (typeof value === 'string' && this.hasVariableReference(value)) {
          if (this.detectCircularReference(value, scope, new Set(visited))) {
            return true;
          }
        }
      } catch {
        // 解析失败，忽略
      }

      visited.delete(ref);
    }

    return false;
  }
}

/**
 * 创建默认的变量解析器实例
 */
export function createVariableResolver(): VariableResolver {
  return new VariableResolver();
}
