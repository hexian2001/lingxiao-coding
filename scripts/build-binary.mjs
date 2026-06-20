#!/usr/bin/env node
/**
 * build-binary.mjs — Node SEA (Single Executable Application) 单文件可执行
 *
 * 利用 Node 22+ 的 --experimental-sea-config 生成单文件可执行程序。
 * 产物命名：lingxiao-{version}-{platform}-{arch}[.exe]
 *
 * 前置条件：
 *   - Node >= 22（项目要求 >=24）
 *   - 已运行 npm run build:package
 *   - npx postject 可用（会自动安装）
 *
 * Usage:
 *   node scripts/build-binary.mjs              # 当前平台
 *   node scripts/build-binary.mjs --all        # CI 中分平台运行
 */

import { execSync } from 'child_process';
import {
  existsSync, mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync, statSync,
} from 'fs';
import { join, resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { platform, arch } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const IS_WINDOWS = platform() === 'win32';

const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8'));
const VERSION = pkg.version;

// ── 平台信息 ──────────────────────────────────────────────────────────
function getPlatformInfo() {
  const p = platform();
  const a = arch();
  const platformName = p === 'darwin' ? 'darwin' : p === 'win32' ? 'win' : 'linux';
  const archName = a === 'arm64' ? 'arm64' : 'x64';
  const ext = p === 'win32' ? '.exe' : '';
  return { platformName, archName, ext, target: `${platformName}-${archName}` };
}

// ── SEA 配置文件 ──────────────────────────────────────────────────────
const seaConfig = {
  main: 'dist/cli.js',
  output: 'sea-prep.blob',
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: true,
};

// ── 构建入口 ──────────────────────────────────────────────────────────
async function buildBinary() {
  const info = getPlatformInfo();
  console.log(`\n🗡️  Building SEA binary: ${info.target}`);

  // 1. 确保已构建
  if (!existsSync(join(pkgRoot, 'dist', 'cli.js'))) {
    console.log('  → Running build:package...');
    execSync('node scripts/build.mjs --package', { stdio: 'inherit', cwd: pkgRoot });
  }

  // 2. 写 SEA 配置
  const seaConfigPath = join(pkgRoot, 'sea-config.json');
  writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));
  console.log('  → Generating SEA blob...');
  execSync(`node --experimental-sea-config "${seaConfigPath}"`, {
    stdio: 'inherit',
    cwd: pkgRoot,
  });

  // 3. 复制 Node 二进制
  const nodeBin = process.execPath;
  const releaseDir = join(pkgRoot, 'release');
  mkdirSync(releaseDir, { recursive: true });

  const binaryName = `lingxiao-v${VERSION}-${info.target}${info.ext}`;
  const binaryPath = join(releaseDir, binaryName);

  console.log(`  → Copying Node binary → ${binaryName}`);
  copyFileSync(nodeBin, binaryPath);

  // 4. 移除签名（macOS）
  if (info.platformName === 'darwin') {
    console.log('  → Removing code signature (macOS)...');
    try {
      execSync(`codesign --remove-signation "${binaryPath}" 2>/dev/null || true`, { stdio: 'pipe' });
    } catch {
      // 非致命
    }
  }

  // 5. 注入 SEA blob
  console.log('  → Injecting SEA blob...');
  const blobPath = join(pkgRoot, 'sea-prep.blob');
  const postjectArgs = [
    `"${binaryPath}"`,
    'NODE_SEA_BLOB',
    `"${blobPath}"`,
    '--sentinel',
    '--overwrite',
  ];

  // Windows 需要先用 signtool 移除签名
  if (IS_WINDOWS) {
    try {
      execSync(`signtool remove /s "${binaryPath}" 2>nul || true`, { stdio: 'pipe' });
    } catch {}
  }

  execSync(`npx postject ${postjectArgs.join(' ')}`, {
    stdio: 'inherit',
    cwd: pkgRoot,
  });

  // 6. 重新签名（macOS）
  if (info.platformName === 'darwin') {
    console.log('  → Re-signing (ad-hoc, macOS)...');
    try {
      execSync(`codesign --sign - "${binaryPath}"`, { stdio: 'pipe' });
    } catch {}
  }

  // 7. 设置可执行权限（Unix）
  if (!IS_WINDOWS) {
    try { execSync(`chmod +x "${binaryPath}"`); } catch {}
  }

  // 8. 清理临时文件
  rmSync(seaConfigPath, { force: true });
  rmSync(blobPath, { force: true });

  const sizeMB = (statSync(binaryPath).size / 1024 / 1024).toFixed(1);
  console.log(`  ✓ ${binaryName} (${sizeMB} MB)\n`);

  // 9. 注意事项
  console.log('  ⚠️  SEA binary 注意事项：');
  console.log('     - skills/ 和 tessdata/ 需要单独分发或放在同级目录');
  console.log('     - web/dist/ 需要单独分发或嵌入');
  console.log('     - 建议配合 portable 包使用，SEA 仅作为 CLI 入口');
  console.log('');
}

// ── 主入口 ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const buildAll = args.includes('--all');

if (buildAll) {
  console.log('\n⚠️  --all 模式：SEA 只能在当前平台构建当前平台的二进制。');
  console.log('   CI 中请分别在对应平台的 runner 上运行此脚本。\n');
}

await buildBinary();
