#!/usr/bin/env node
/**
 * health-check.mjs — 项目健康度指标收集脚本
 *
 * 根据 metrics_contract.md 定义的数据契约，收集 lingxiao_cli 项目健康度指标。
 * 输出 JSON 到 session scratchpad 下的 health_metrics.json。
 *
 * 使用方式:
 *   node scripts/health-check.mjs [--output <path>]
 *
 * 默认输出路径: $LINGXIAO_SCRATCHPAD_DIR/health_metrics.json
 */

import { globSync } from 'glob';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { platform, version as nodeVersion } from 'os';
import { dirname, resolve, join, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

// ── 工具函数 ──────────────────────────────────────────────

/** 安全执行 shell 命令，超时默认 15s */
function safeExec(cmd, timeoutMs = 15000) {
  try {
    return execSync(cmd, {
      cwd: pkgRoot,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024, // 50MB
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    return err.stdout || err.stderr || String(err.message || err);
  }
}

/** 统计一组文件的总行数 */
function countLines(files) {
  let total = 0;
  for (const f of files) {
    try {
      const content = readFileSync(f, 'utf-8');
      total += content.split('\n').length;
    } catch {
      // 跳过无法读取的文件
    }
  }
  return total;
}

/** 统计匹配模式的文件数 */
function countFiles(pattern, cwd = pkgRoot) {
  try {
    return globSync(pattern, { cwd, nodir: true, ignore: ['**/node_modules/**', '**/dist/**'] }).length;
  } catch {
    return 0;
  }
}

/** 匹配模式的文件列表 */
function listFiles(pattern, cwd = pkgRoot) {
  try {
    return globSync(pattern, { cwd, nodir: true, ignore: ['**/node_modules/**', '**/dist/**'] });
  } catch {
    return [];
  }
}

// ── 指标收集函数 ──────────────────────────────────────────

/** 1. Project 基本信息 */
function collectProjectInfo(pkg) {
  try {
    return {
      name: pkg.name || 'unknown',
      version: pkg.version || '0.0.0',
      scanTimestamp: new Date().toISOString(),
      nodeVersion: nodeVersion,
    };
  } catch (err) {
    return { error: `collectProjectInfo: ${err.message}` };
  }
}

/** 2. 代码规模 (Code Scale) */
function collectCodeScale() {
  try {
    // 后端文件 (src/)
    const tsFiles = listFiles('src/**/*.{ts,tsx}');
    const tsxFiles = tsFiles.filter(f => f.endsWith('.tsx'));
    const tsOnlyFiles = tsFiles.filter(f => f.endsWith('.ts'));

    // 前端文件 (web/src/)
    const feTsFiles = listFiles('web/src/**/*.{ts,tsx}');

    // JS 文件 (不含 node_modules/dist)
    const jsFiles = listFiles('{src,web/src,test}/**/*.{js,jsx,mjs,cjs}');

    // 测试文件
    const inlineTests = listFiles('src/**/*.test.ts');
    const standaloneTests = listFiles('test/**/*.{ts,js}');

    // 行数统计
    const backendLines = countLines(tsFiles);
    const frontendLines = countLines(feTsFiles);
    const jsLines = countLines(jsFiles);

    // 模块计数
    const backendModules = countDirs('src');
    const frontendModules = countDirs('web/src');

    const allCodeFiles = [...tsFiles, ...feTsFiles, ...jsFiles];
    const totalFiles = allCodeFiles.length;
    const totalLines = backendLines + frontendLines + jsLines;
    const typescriptCount = tsFiles.length + feTsFiles.length;
    const typescriptPercentage = totalFiles > 0
      ? parseFloat(((typescriptCount / totalFiles) * 100).toFixed(1))
      : 0;

    return {
      totalFiles,
      totalLines,
      typescriptFiles: typescriptCount,
      typescriptLines: backendLines + frontendLines,
      javascriptFiles: jsFiles.length,
      javascriptLines: jsLines,
      typescriptPercentage,
      backendFiles: tsFiles.length,
      backendLines,
      frontendFiles: feTsFiles.length,
      frontendLines,
      testFiles: inlineTests.length + standaloneTests.length,
      backendModules,
      frontendModules,
      totalModules: backendModules + frontendModules,
    };
  } catch (err) {
    return { error: `collectCodeScale: ${err.message}` };
  }
}

/** 统计目录下的一级子目录数（非空） */
function countDirs(dirPath) {
  const full = join(pkgRoot, dirPath);
  try {
    if (!existsSync(full)) return 0;
    return readdirSync(full, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .length;
  } catch {
    return 0;
  }
}

/** 3. 依赖健康度 (Dependency Health) */
function collectDependencyHealth(pkg) {
  try {
    const prodDeps = Object.keys(pkg.dependencies || {}).length;
    const devDeps = Object.keys(pkg.devDependencies || {}).length;
    const optionalDeps = Object.keys(pkg.optionalDependencies || {}).length;
    const totalDeps = prodDeps + devDeps + optionalDeps;

    // npm audit
    let vulnerabilities = { total: 0, low: 0, moderate: 0, high: 0, critical: 0, details: [] };
    try {
      const auditRaw = safeExec('npm audit --json 2>/dev/null', 20000);
      const audit = JSON.parse(auditRaw);
      if (audit.metadata && audit.metadata.vulnerabilities) {
        const v = audit.metadata.vulnerabilities;
        vulnerabilities = {
          total: v.total || 0,
          low: v.low || 0,
          moderate: v.moderate || 0,
          high: v.high || 0,
          critical: v.critical || 0,
          details: [],
        };
        // 提取详情
        if (audit.vulnerabilities && typeof audit.vulnerabilities === 'object') {
          for (const [name, info] of Object.entries(audit.vulnerabilities)) {
            if (info && info.severity) {
              vulnerabilities.details.push({
                name,
                severity: info.severity,
                via: Array.isArray(info.via) ? info.via[0] : String(info.via || ''),
                fixAvailable: info.fixAvailable ? String(info.fixAvailable) : 'none',
              });
            }
          }
        }
      }
    } catch {
      // audit 失败不影响其他指标
      vulnerabilities = { error: 'npm audit failed or unavailable' };
    }

    // outdated deps (npm outdated, optional)
    let outdatedDependencies = [];
    try {
      const outdatedRaw = safeExec('npm outdated --json 2>/dev/null', 15000);
      const outdated = JSON.parse(outdatedRaw);
      if (outdated && typeof outdated === 'object') {
        outdatedDependencies = Object.entries(outdated).map(([name, info]) => ({
          name,
          current: info.current || 'unknown',
          latest: info.latest || 'unknown',
        }));
      }
    } catch {
      outdatedDependencies = []; // 非关键，静默跳过
    }

    return {
      totalDependencies: totalDeps,
      prodDependencies: prodDeps,
      devDependencies: devDeps,
      optionalDependencies: optionalDeps,
      knownVulnerabilities: vulnerabilities,
      outdatedDependencies,
    };
  } catch (err) {
    return { error: `collectDependencyHealth: ${err.message}` };
  }
}

/** 4. 测试覆盖 (Test Coverage) */
function collectTestCoverage(pkg) {
  try {
    const testScript = pkg.scripts?.test || '';
    const ciScript = pkg.scripts?.['test:ci'] || testScript;

    const inlineTests = listFiles('src/**/*.test.ts');
    const standaloneTests = listFiles('test/**/*.{ts,js}');

    // 检测测试框架
    let testFramework = 'unknown';
    if (testScript.includes('node --test')) {
      testFramework = 'node:test (built-in)';
    } else if (testScript.includes('jest')) {
      testFramework = 'jest';
    } else if (testScript.includes('vitest') || testScript.includes('vite test')) {
      testFramework = 'vitest';
    } else if (testScript.includes('mocha')) {
      testFramework = 'mocha';
    }

    // 检查覆盖率工具配置
    const coverageToolConfigured =
      testScript.includes('c8') ||
      testScript.includes('nyc') ||
      testScript.includes('--coverage') ||
      existsSync(join(pkgRoot, '.nycrc')) ||
      existsSync(join(pkgRoot, '.nycrc.json')) ||
      existsSync(join(pkgRoot, 'c8.json'));

    return {
      testScript,
      ciScript,
      inlineTestFiles: inlineTests.length,
      standaloneTestFiles: standaloneTests.length,
      totalTestFiles: inlineTests.length + standaloneTests.length,
      testFramework,
      coverageToolConfigured,
      coverageConfig: {},
      coveragePercentage: null,
      testFiles: [...inlineTests, ...standaloneTests].slice(0, 20), // 最多列 20 个
    };
  } catch (err) {
    return { error: `collectTestCoverage: ${err.message}` };
  }
}

/** 5. 构建状态 (Build Status) */
function collectBuildStatus(pkg) {
  try {
    // 读取 tsconfig 文件
    const rootTsconfig = readJsonFile(join(pkgRoot, 'tsconfig.json'));
    const cliTsconfig = readJsonFile(join(pkgRoot, 'tsconfig.cli.json'));
    const pkgTsconfig = readJsonFile(join(pkgRoot, 'tsconfig.package.json'));
    const feTsconfig = readJsonFile(join(pkgRoot, 'web/tsconfig.json'));

    // 前端构建器
    let frontendBuilder = 'unknown';
    try {
      const webPkg = readJsonFile(join(pkgRoot, 'web/package.json'));
      const viteVersion = webPkg?.devDependencies?.vite || 'unknown';
      const reactVersion = webPkg?.dependencies?.react || 'unknown';
      frontendBuilder = `Vite ${viteVersion} + React ${reactVersion}`;
    } catch {
      frontendBuilder = 'unknown';
    }

    // 前端插件
    const frontendPlugins = [];
    try {
      const webPkg = readJsonFile(join(pkgRoot, 'web/package.json'));
      if (webPkg?.devDependencies) {
        for (const [name] of Object.entries(webPkg.devDependencies)) {
          if (name.includes('vite') && name !== 'vite') {
            frontendPlugins.push(name);
          }
        }
      }
    } catch {
      // ignore
    }

    // 构建步骤（从 build.mjs 推断）
    const buildSteps = [];
    if (existsSync(join(pkgRoot, 'scripts/build.mjs'))) {
      const buildScript = readFileSync(join(pkgRoot, 'scripts/build.mjs'), 'utf-8');
      if (buildScript.includes('tsc')) buildSteps.push('tsc -p tsconfig.cli.json');
      if (buildScript.includes('vite')) buildSteps.push('vite build (web/)');
      if (buildScript.includes('chmod')) buildSteps.push('chmod +x dist/cli.js');
      if (buildScript.includes('generate-settings')) buildSteps.push('generate-settings');
      if (buildScript.includes('copyFileSync')) buildSteps.push('copy skill assets');
    }

    return {
      backendTsconfig: 'tsconfig.cli.json',
      packageTsconfig: 'tsconfig.package.json',
      frontendTsconfig: 'web/tsconfig.json',
      target: rootTsconfig?.compilerOptions?.target || 'unknown',
      strictMode: rootTsconfig?.compilerOptions?.strict === true,
      skipLibCheck: rootTsconfig?.compilerOptions?.skipLibCheck === true,
      sourceMap: cliTsconfig?.compilerOptions?.sourceMap === true ||
        rootTsconfig?.compilerOptions?.sourceMap === true,
      declaration: cliTsconfig?.compilerOptions?.declaration === true,
      buildCommand: pkg.scripts?.build || 'unknown',
      buildSteps,
      frontendBuilder,
      frontendPlugins,
    };
  } catch (err) {
    return { error: `collectBuildStatus: ${err.message}` };
  }
}

/** 安全读取 JSON 文件 */
function readJsonFile(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/** 6. 代码质量风险 (Code Quality Risks) */
function collectCodeQualityRisks() {
  try {
    // 6a. console 使用统计
    const consoleUsage = scanConsoleUsage();

    // 6b. any 类型使用统计
    const anyTypeUsage = scanAnyTypeUsage();

    // 6c. TODO/FIXME 统计
    const todoFixmeComments = scanTodoFixme();

    // 6d. 循环依赖检测
    const circularDependencies = detectCircularDependencies();

    // 6e. ESLint / Prettier 配置检查
    const eslintConfigured = [
      '.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yaml', '.eslintrc.yml',
      'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts',
    ].some(f => existsSync(join(pkgRoot, f)));

    const prettierConfigured = [
      '.prettierrc', '.prettierrc.js', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml',
      'prettier.config.js', 'prettier.config.mjs', 'prettier.config.cjs',
      '.prettierrc.cjs',
    ].some(f => existsSync(join(pkgRoot, f)));

    // 也检查 package.json 中是否有 eslint/prettier 配置字段
    const pkg = readJsonFile(join(pkgRoot, 'package.json'));
    if (pkg) {
      if (pkg.eslintConfig || pkg.eslintIgnore) {
        // eslint configured in package.json
      }
      if (pkg.prettier) {
        // prettier configured in package.json
      }
    }

    return {
      consoleUsage,
      anyTypeUsage,
      todoFixmeComments,
      circularDependencies,
      eslintConfigured,
      prettierConfigured,
    };
  } catch (err) {
    return { error: `collectCodeQualityRisks: ${err.message}` };
  }
}

/** 扫描 console.* 调用 */
function scanConsoleUsage() {
  try {
    const files = listFiles('{src,web/src}/**/*.{ts,tsx,js,jsx}');
    let totalCalls = 0;
    const filesAffected = new Set();
    const breakdown = { log: 0, error: 0, warn: 0, info: 0, debug: 0 };
    const hotspots = [];

    for (const file of files) {
      const fullPath = join(pkgRoot, file);
      try {
        const content = readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        let fileCount = 0;

        for (const line of lines) {
          // 跳过纯注释行
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

          const matches = line.match(/console\.(log|error|warn|info|debug)\s*\(/g);
          if (matches) {
            for (const m of matches) {
              const method = m.match(/console\.(log|error|warn|info|debug)/)[1];
              breakdown[method] = (breakdown[method] || 0) + 1;
              totalCalls++;
              fileCount++;
            }
          }
        }

        if (fileCount > 0) {
          filesAffected.add(file);
          hotspots.push({ file, count: fileCount });
        }
      } catch {
        // skip unreadable files
      }
    }

    hotspots.sort((a, b) => b.count - a.count);

    return {
      totalCalls,
      filesAffected: filesAffected.size,
      breakdown,
      hotspots: hotspots.slice(0, 10), // top 10
    };
  } catch (err) {
    return { error: `scanConsoleUsage: ${err.message}` };
  }
}

/** 扫描 any 类型使用 */
function scanAnyTypeUsage() {
  try {
    const files = listFiles('{src,web/src}/**/*.{ts,tsx}');
    let totalInstances = 0;
    const filesAffected = new Set();
    const hotspots = [];

    for (const file of files) {
      const fullPath = join(pkgRoot, file);
      try {
        const content = readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        let fileCount = 0;

        for (const line of lines) {
          const trimmed = line.trim();
          // 跳过纯注释行
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

          // 匹配类型位置的 any:  : any,  | any,  <any,  as any,  catch(e: any)
          // 排除非类型上下文中的 any（如变量名中包含 any）
          const anyMatches = line.match(/:\s*any\b|\|\s*any\b|<\s*any\b|\bas\s+any\b|\(\s*any\b/g);
          if (anyMatches) {
            fileCount += anyMatches.length;
          }
        }

        if (fileCount > 0) {
          totalInstances += fileCount;
          filesAffected.add(file);
          hotspots.push({ file, count: fileCount });
        }
      } catch {
        // skip unreadable files
      }
    }

    hotspots.sort((a, b) => b.count - a.count);

    return {
      totalInstances,
      filesAffected: filesAffected.size,
      hotspots: hotspots.slice(0, 10),
    };
  } catch (err) {
    return { error: `scanAnyTypeUsage: ${err.message}` };
  }
}

/** 扫描 TODO/FIXME 注释 */
function scanTodoFixme() {
  try {
    const files = listFiles('{src,web/src}/**/*.{ts,tsx,js,jsx}');
    let total = 0;
    const filesAffected = new Set();

    for (const file of files) {
      const fullPath = join(pkgRoot, file);
      try {
        const content = readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        let fileCount = 0;

        for (const line of lines) {
          const trimmed = line.trim();
          // 跳过非注释行
          if (!trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*')) continue;

          if (/\bTODO\b/i.test(trimmed) || /\bFIXME\b/i.test(trimmed)) {
            fileCount++;
          }
        }

        if (fileCount > 0) {
          total += fileCount;
          filesAffected.add(file);
        }
      } catch {
        // skip unreadable files
      }
    }

    return {
      total,
      filesAffected: filesAffected.size,
    };
  } catch (err) {
    return { error: `scanTodoFixme: ${err.message}` };
  }
}

/** 检测模块级循环依赖 */
function detectCircularDependencies() {
  try {
    // 获取 src/ 下的一级模块目录
    const srcDir = join(pkgRoot, 'src');
    const modules = readdirSync(srcDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name);

    // 为每个模块建立导入关系图
    const importGraph = new Map(); // module -> Set<imported modules>

    for (const mod of modules) {
      // 注意：glob 路径必须以 src/ 开头
      const tsFiles = listFiles(`src/${mod}/**/*.{ts,tsx}`);
      const importedModules = new Set();

      for (const file of tsFiles) {
        const fullPath = join(pkgRoot, file);
        try {
          const content = readFileSync(fullPath, 'utf-8');
          // 匹配 from '../module' 或 from '../../module' 等
          const importMatches = content.match(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g);
          if (importMatches) {
            for (const imp of importMatches) {
              // 提取路径
              const pathMatch = imp.match(/from\s+['"](\.{1,2}\/[^'"]+)['"]/);
              if (pathMatch) {
                const importPath = pathMatch[1];
                // 解析为模块名
                const resolved = resolveImportToModule(mod, importPath);
                if (resolved && modules.includes(resolved)) {
                  importedModules.add(resolved);
                }
              }
            }
          }
        } catch {
          // skip unreadable files
        }
      }

      importGraph.set(mod, importedModules);
    }

    // 检测双向依赖
    const pairs = [];
    const checked = new Set();

    for (const [modA, importsA] of importGraph) {
      for (const modB of importsA) {
        if (modA === modB) continue;
        const key = [modA, modB].sort().join('<-->');
        if (checked.has(key)) continue;

        const importsB = importGraph.get(modB);
        if (importsB && importsB.has(modA)) {
          pairs.push({ moduleA: modA, moduleB: modB });
          checked.add(key);
        }
      }
    }

    let riskLevel = 'low';
    if (pairs.length >= 5) riskLevel = 'high';
    else if (pairs.length >= 2) riskLevel = 'medium';

    return {
      detected: pairs.length > 0,
      pairs,
      riskLevel,
    };
  } catch (err) {
    return { error: `detectCircularDependencies: ${err.message}` };
  }
}

/** 将相对导入路径解析为模块名 */
function resolveImportToModule(currentModule, importPath) {
  // importPath 如 '../core/xxx' 或 '../../tools/yyy' 或 './utils'
  // currentModule 是一级模块名（如 'core'）
  // 文件可能在 core/agents/xxx.ts，需要用文件的实际子目录深度来计算
  const parts = importPath.split('/');
  let upCount = 0;
  for (const p of parts) {
    if (p === '..') upCount++;
    else break;
  }

  // 剩余路径部分（去掉 .. 后）
  const remaining = parts.slice(upCount);
  if (remaining.length === 0) return null; // 纯 '..' 无意义

  // upCount=1: 从 currentModule 子目录上一级 → 回到 src/ → 剩余部分是一级模块
  // upCount=2: 从 currentModule 子目录上两级 → 回到 src/ → 剩余部分是一级模块
  // 实际上只要 upCount >= 1，回到 src/ 后的第一个目录就是目标模块
  if (upCount >= 1) {
    const targetModule = remaining[0];
    return targetModule || null;
  }

  // upCount=0: 当前模块内导入
  return null;
}

// ── 主函数 ────────────────────────────────────────────────

async function main() {
  console.log('🔍 Collecting project health metrics...');
  const startTime = Date.now();

  // 读取 package.json
  const pkgPath = join(pkgRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    console.error('❌ package.json not found at:', pkgPath);
    process.exit(1);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

  // 并行收集所有指标
  console.log('  ├─ project info...');
  const project = collectProjectInfo(pkg);

  console.log('  ├─ code scale...');
  const codeScale = collectCodeScale();

  console.log('  ├─ dependency health...');
  const dependencyHealth = collectDependencyHealth(pkg);

  console.log('  ├─ test coverage...');
  const testCoverage = collectTestCoverage(pkg);

  console.log('  ├─ build status...');
  const buildStatus = collectBuildStatus(pkg);

  console.log('  ├─ code quality risks...');
  const codeQualityRisks = collectCodeQualityRisks();

  // 聚合结果
  const metrics = {
    project,
    codeScale,
    dependencyHealth,
    testCoverage,
    buildStatus,
    codeQualityRisks,
  };

  // 计算扫描耗时
  const elapsedMs = Date.now() - startTime;
  console.log(`\n✅ Metrics collection complete in ${elapsedMs}ms`);

  // 确定输出路径
  const outputArgIdx = process.argv.indexOf('--output');
  let outputPath;
  if (outputArgIdx >= 0 && process.argv[outputArgIdx + 1]) {
    outputPath = resolve(process.cwd(), process.argv[outputArgIdx + 1]);
  } else {
    // 默认写入 session scratchpad
    const scratchpad = process.env.LINGXIAO_SCRATCHPAD_DIR;
    if (scratchpad) {
      outputPath = join(scratchpad, 'health_metrics.json');
    } else {
      outputPath = join(pkgRoot, 'health_metrics.json');
    }
  }

  // 确保输出目录存在
  const outputDir = dirname(outputPath);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // 写入 JSON
  const jsonOutput = JSON.stringify(metrics, null, 2);
  writeFileSync(outputPath, jsonOutput, 'utf-8');
  console.log(`📄 Output written to: ${outputPath}`);

  // 打印摘要
  printSummary(metrics);

  return metrics;
}

/** 打印指标摘要到终端 */
function printSummary(metrics) {
  console.log('\n── Health Metrics Summary ──');
  console.log(`Project: ${metrics.project.name} v${metrics.project.version}`);
  console.log(`Timestamp: ${metrics.project.scanTimestamp}`);

  if (!metrics.codeScale.error) {
    console.log(`Files: ${metrics.codeScale.totalFiles} | Lines: ${metrics.codeScale.totalLines} | TS%: ${metrics.codeScale.typescriptPercentage}%`);
    console.log(`Backend: ${metrics.codeScale.backendFiles} files, ${metrics.codeScale.backendModules} modules`);
    console.log(`Frontend: ${metrics.codeScale.frontendFiles} files, ${metrics.codeScale.frontendModules} modules`);
  }

  if (!metrics.dependencyHealth.error) {
    console.log(`Dependencies: ${metrics.dependencyHealth.totalDependencies} (${metrics.dependencyHealth.prodDependencies} prod / ${metrics.dependencyHealth.devDependencies} dev)`);
    if (metrics.dependencyHealth.knownVulnerabilities && !metrics.dependencyHealth.knownVulnerabilities.error) {
      const v = metrics.dependencyHealth.knownVulnerabilities;
      console.log(`Vulnerabilities: ${v.total} (high: ${v.high}, critical: ${v.critical})`);
    }
  }

  if (!metrics.testCoverage.error) {
    console.log(`Tests: ${metrics.testCoverage.totalTestFiles} files (${metrics.testCoverage.inlineTestFiles} inline + ${metrics.testCoverage.standaloneTestFiles} standalone)`);
    console.log(`Framework: ${metrics.testCoverage.testFramework} | Coverage tool: ${metrics.testCoverage.coverageToolConfigured ? 'Yes' : 'No'}`);
  }

  if (!metrics.buildStatus.error) {
    console.log(`Build: strict=${metrics.buildStatus.strictMode} | target=${metrics.buildStatus.target}`);
  }

  if (!metrics.codeQualityRisks.error) {
    const cqr = metrics.codeQualityRisks;
    console.log(`Code Quality:`);
    if (!cqr.consoleUsage.error) {
      console.log(`  console calls: ${cqr.consoleUsage.totalCalls} in ${cqr.consoleUsage.filesAffected} files`);
    }
    if (!cqr.anyTypeUsage.error) {
      console.log(`  any types: ${cqr.anyTypeUsage.totalInstances} in ${cqr.anyTypeUsage.filesAffected} files`);
    }
    if (!cqr.todoFixmeComments.error) {
      console.log(`  TODO/FIXME: ${cqr.todoFixmeComments.total} in ${cqr.todoFixmeComments.filesAffected} files`);
    }
    if (!cqr.circularDependencies.error) {
      const cd = cqr.circularDependencies;
      console.log(`  Circular deps: ${cd.pairs.length} pairs (risk: ${cd.riskLevel})`);
    }
  }

  // 检查是否有错误字段
  const errors = [];
  for (const [section, data] of Object.entries(metrics)) {
    if (data && data.error) errors.push(`${section}: ${data.error}`);
  }
  if (errors.length > 0) {
    console.log(`\n⚠️  Errors in ${errors.length} section(s):`);
    errors.forEach(e => console.log(`   ${e}`));
  }
}

// ── 入口 ──────────────────────────────────────────────────

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
