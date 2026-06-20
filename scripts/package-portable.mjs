#!/usr/bin/env node
/**
 * package-portable.mjs — 跨平台便携包打包
 *
 * 生成可直接解压运行的便携包，包含：
 *   - dist/          编译后的后端
 *   - web/dist/      编译后的前端
 *   - skills/        技能文件（排除大资源）
 *   - tessdata/      OCR 数据
 *   - node_modules/  生产依赖（npm install --production）
 *   - package.json, scripts/postinstall.mjs, README.md, LICENSE
 *
 * 产物命名（与 cli_upgrade.ts 下载逻辑对齐）：
 *   lingxiao-{version}-{platform}-{arch}.tar.gz  (Unix)
 *   lingxiao-{version}-{platform}-{arch}.zip     (Windows)
 *
 * Usage:
 *   node scripts/package-portable.mjs              # 当前平台
 *   node scripts/package-portable.mjs --all        # 全平台（CI 中使用）
 *   node scripts/package-portable.mjs --target linux-x64
 */

import { execSync } from 'child_process';
import {
  existsSync, mkdirSync, rmSync, copyFileSync, readdirSync, statSync,
  createReadStream, createWriteStream, readFileSync, writeFileSync,
} from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createGzip } from 'zlib';
import { platform, arch } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const IS_WINDOWS = platform() === 'win32';

// ── 读取版本 ──────────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8'));
const VERSION = pkg.version;

// ── 平台→target 映射 ──────────────────────────────────────────────────
function getTarget() {
  const p = platform();
  const a = arch();
  const platformName = p === 'darwin' ? 'darwin' : p === 'win32' ? 'win' : 'linux';
  const archName = a === 'arm64' ? 'arm64' : 'x64';
  return `${platformName}-${archName}`;
}

const ALL_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win-x64'];

// ── 排除列表（不打包到便携包） ─────────────────────────────────────────
const EXCLUDED_NAMES = new Set([
  'node_modules', 'dist', '.git', '.claude', '.codebuddy',
  'release', '.tmp-portable', '.DS_Store', 'Thumbs.db',
  'test', 'test-fixtures', 'docs', 'site',
  '.lingxiao',
]);

const EXCLUDED_PATTERNS = [
  /\.log$/, /\.tgz$/, /\.tar\.gz$/, /\.zip$/,
  /\.tsbuildinfo$/, /\.mp3$/, /\.mp4$/,
];

const EXCLUDED_SKILL_PATHS = [
  'skills/bundled/huashu-design/assets/sfx',
  'skills/bundled/huashu-design/assets/showcases',
  'skills/bundled/huashu-design/demos',
];

function shouldExclude(name, fullPath) {
  if (EXCLUDED_NAMES.has(name)) return true;
  for (const pat of EXCLUDED_PATTERNS) {
    if (pat.test(name)) return true;
  }
  const rel = fullPath.slice(pkgRoot.length + 1).replace(/\\/g, '/');
  for (const prefix of EXCLUDED_SKILL_PATHS) {
    if (rel === prefix || rel.startsWith(prefix + '/')) return true;
  }
  return false;
}

// ── 递归复制 ──────────────────────────────────────────────────────────
function copyRecursive(src, dest) {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (shouldExclude(entry.name, srcPath)) continue;
    if (entry.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      copyRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      copyFileSync(srcPath, destPath);
    }
  }
}

// ── tar.gz 打包（复用 package-release-source.mjs 的 tar 实现） ──────────
function normalizeTarPath(p) { return p.replace(/\\/g, '/').replace(/^\/+/, ''); }

function splitTarName(name) {
  const encoded = Buffer.byteLength(name);
  if (encoded <= 100) return { name, prefix: '' };
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    const rest = parts.slice(i).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) {
      return { name: rest, prefix };
    }
  }
  return { name: name.slice(-100), prefix: name.slice(0, -100) };
}

// ── tar.gz 打包（使用系统 tar，跨平台可靠） ──────────────────────────
async function createTarGz(root, dest) {
  execSync(`tar czf "${dest}" -C "${root}" .`, { stdio: 'inherit' });
}

// ── 创建 zip（Windows 平台用） ─────────────────────────────────────────
async function createZip(root, dest) {
  // 使用系统 zip 命令；CI 环境通常预装
  execSync(`cd "${root}" && zip -r -q "${dest}" .`, { stdio: 'inherit' });
}

// ── 构建单个平台的便携包 ───────────────────────────────────────────────
async function buildPortable(target) {
  console.log(`\n📦 Building portable package: ${target}`);

  const stagingDir = join(pkgRoot, '.tmp-portable', target);
  if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  // 1. 先执行构建（如果 dist/ 不存在）
  if (!existsSync(join(pkgRoot, 'dist', 'cli.js'))) {
    console.log('  → Running build:package...');
    execSync('node scripts/build.mjs --package', { stdio: 'inherit', cwd: pkgRoot });
  }

  // 2. 复制 dist/
  console.log('  → Copying dist/...');
  const distDir = join(stagingDir, 'dist');
  mkdirSync(distDir, { recursive: true });
  copyRecursive(join(pkgRoot, 'dist'), distDir);

  // 3. 复制 web/dist/
  if (existsSync(join(pkgRoot, 'web', 'dist'))) {
    console.log('  → Copying web/dist/...');
    mkdirSync(join(stagingDir, 'web', 'dist'), { recursive: true });
    copyRecursive(join(pkgRoot, 'web', 'dist'), join(stagingDir, 'web', 'dist'));
  }

  // 4. 复制 skills/（排除大资源）
  if (existsSync(join(pkgRoot, 'skills'))) {
    console.log('  → Copying skills/...');
    mkdirSync(join(stagingDir, 'skills'), { recursive: true });
    copyRecursive(join(pkgRoot, 'skills'), join(stagingDir, 'skills'));
  }

  // 5. 复制 tessdata/
  if (existsSync(join(pkgRoot, 'tessdata'))) {
    console.log('  → Copying tessdata/...');
    mkdirSync(join(stagingDir, 'tessdata'), { recursive: true });
    copyRecursive(join(pkgRoot, 'tessdata'), join(stagingDir, 'tessdata'));
  }

  // 6. 复制 scripts/postinstall.mjs
  if (existsSync(join(pkgRoot, 'scripts', 'postinstall.mjs'))) {
    mkdirSync(join(stagingDir, 'scripts'), { recursive: true });
    copyFileSync(join(pkgRoot, 'scripts', 'postinstall.mjs'), join(stagingDir, 'scripts', 'postinstall.mjs'));
  }

  // 7. 复制元文件
  for (const f of ['package.json', 'README.md', 'LICENSE']) {
    if (existsSync(join(pkgRoot, f))) {
      copyFileSync(join(pkgRoot, f), join(stagingDir, f));
    }
  }

  // 8. 安装生产依赖（带重试和容错）
  console.log('  → Installing production dependencies...');
  const npmCmd = IS_WINDOWS ? 'npm.cmd' : 'npm';
  let npmOk = false;
  const npmAttempts = [
    `${npmCmd} install --production --no-scripts`,
    `${npmCmd} install --production --no-scripts --prefer-offline`,
    `${npmCmd} install --production --no-scripts --no-audit --no-fund`,
  ];
  for (let i = 0; i < npmAttempts.length; i++) {
    try {
      execSync(npmAttempts[i], { cwd: stagingDir, stdio: 'inherit', timeout: 120000 });
      npmOk = true;
      break;
    } catch (err) {
      console.log(`  ⚠️  npm install attempt ${i + 1} failed: ${err.message?.slice(0, 100) || err}`);
      if (i < npmAttempts.length - 1) console.log('  → Retrying...');
    }
  }
  if (!npmOk) {
    console.log('  ⚠️  npm install failed — packaging without node_modules (user must run npm install after extract)');
    // 写一个提示文件
    writeFileSync(join(stagingDir, 'INSTALL.txt'),
      'npm install failed during packaging.\nPlease run: npm install --production\n');
  }

  // 9. 创建启动脚本
  const launcherUnix = join(stagingDir, 'lingxiao');
  writeFileSync(launcherUnix, `#!/usr/bin/env bash\ncd "$(dirname "$0")" && exec node dist/cli.js "$@"\n`);
  if (!IS_WINDOWS) {
    try { execSync(`chmod +x "${launcherUnix}"`); } catch {}
  }

  if (target.startsWith('win-')) {
    const launcherWin = join(stagingDir, 'lingxiao.cmd');
    writeFileSync(launcherWin, `@echo off\r\ncd /d "%~dp0"\r\nnode dist\\cli.js %*\r\n`);
  }

  // 10. 打包
  const releaseDir = join(pkgRoot, 'release');
  mkdirSync(releaseDir, { recursive: true });

  const ext = target.startsWith('win-') ? '.zip' : '.tar.gz';
  const archiveName = `lingxiao-v${VERSION}-${target}${ext}`;
  const archivePath = join(releaseDir, archiveName);

  if (existsSync(archivePath)) rmSync(archivePath, { force: true });

  console.log(`  → Creating archive: ${archiveName}`);
  if (target.startsWith('win-')) {
    await createZip(stagingDir, archivePath);
  } else {
    await createTarGz(stagingDir, archivePath);
  }

  // 11. 清理
  rmSync(stagingDir, { recursive: true, force: true });

  const sizeMB = (statSync(archivePath).size / 1024 / 1024).toFixed(1);
  console.log(`  ✓ ${archiveName} (${sizeMB} MB)`);
  return archivePath;
}

// ── 主入口 ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const buildAll = args.includes('--all');
const targetArg = args.find((a) => a.startsWith('--target='));

let targets;
if (buildAll) {
  targets = ALL_TARGETS;
} else if (targetArg) {
  targets = [targetArg.replace('--target=', '')];
} else {
  targets = [getTarget()];
}

console.log(`\n🗡️  Lingxiao Portable Packager v${VERSION}`);
console.log(`   Targets: ${targets.join(', ')}`);

const releaseDir = join(pkgRoot, 'release');
mkdirSync(releaseDir, { recursive: true });

for (const target of targets) {
  await buildPortable(target);
}

console.log('\n✓ All portable packages created.\n');
