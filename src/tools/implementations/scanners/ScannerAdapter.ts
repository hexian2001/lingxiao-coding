/**
 * scanners/ScannerAdapter.ts — 统一扫描器适配器接口。
 *
 * 把原本在 runFullScan 里硬编码的 6 段扫描（ast-grep / builtin / js-x-ray /
 * tsc / npm-audit / semgrep）收口为统一接口，runFullScan 遍历 SCANNER_ADAPTERS。
 * 纯重构：扫描顺序与输出字节级不变（P2）。
 *
 * 类型 ScanResult/ScanFinding 留在 BughuntScanTools（核心类型 + 已被外部 import），
 * 本文件仅 import type（编译期擦除，运行时无循环依赖）。
 *
 * 扩展点：新增 scanner tier 时，在 BughuntScanTools 追加一个 ScannerAdapter 对象
 * 并注册进 SCANNER_ADAPTERS 即可，runFullScan 自动纳入。
 */
import type { ScanResult } from '../BughuntScanTools.js';

export interface ScanOptions {
  skipBuiltin?: boolean;
  skipJsXray?: boolean;
  skipTreeSitter?: boolean;
  skipTsc?: boolean;
  skipNpmAudit?: boolean;
  skipSemgrep?: boolean;
  semgrepRules?: string;
}

export interface ScannerAdapter {
  /** 扫描器名称（与 ScanResult.tool 对齐）。 */
  readonly name: string;
  /** 是否被 options 跳过。 */
  shouldSkip(options: ScanOptions): boolean;
  /**
   * 执行扫描；不可用时返回 success:false（与原 run*Scan 一致，不抛错——
   * 这是跨平台优雅降级的核心：工具缺失不中断整次扫描）。
   */
  scan(target: string, options: ScanOptions): Promise<ScanResult>;
}
