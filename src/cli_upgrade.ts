/**
 * lingxiao upgrade — 自更新命令
 *
 * 功能：
 *   lingxiao upgrade          检查并升级到最新版本
 *   lingxiao upgrade --check  只检查不更新
 *
 * 原理：
 *   1. 查询 GitHub releases/latest 获取最新 tag
 *   2. 与当前 VERSION 做 semver 比较
 *   3. 下载对应平台便携包 → 替换安装目录 → 刷新 symlink
 *   4. npm 安装则提示 npm update -g
 */

import { VERSION } from './version.js';
import { platform, arch, tmpdir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, createReadStream } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { createGunzip } from 'zlib';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import chalk from 'chalk';

const REPO = 'hexian2001/lingxiao-coding';
const GITHUB_API = `https://api.github.com/repos/${REPO}/releases/latest`;

// ── 类型 ──────────────────────────────────────────────────────────────────────

interface ReleaseInfo {
  tag: string;
  version: string;
  htmlUrl: string;
  publishedAt: string;
}

interface UpgradeOptions {
  check?: boolean;
}

// ── semver 比较 ───────────────────────────────────────────────────────────────

function parseSemver(v: string): [number, number, number] {
  const cleaned = v.replace(/^v/, '');
  const parts = cleaned.split('.').map((s) => parseInt(s, 10) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function compareVersions(a: string, b: string): number {
  const [aMaj, aMin, aPat] = parseSemver(a);
  const [bMaj, bMin, bPat] = parseSemver(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPat - bPat;
}

// ── 平台检测 ──────────────────────────────────────────────────────────────────

function detectTarget(): string {
  const p = platform();
  const a = arch();
  const platformName = p === 'win32' ? 'win32' : p === 'darwin' ? 'darwin' : p === 'linux' ? 'linux' : null;
  if (!platformName) throw new Error(`不支持的操作系统: ${p}`);
  const archName = a === 'x64' ? 'x64' : a === 'arm64' ? 'arm64' : null;
  if (!archName) throw new Error(`不支持的架构: ${a}`);
  return `${platformName}-${archName}`;
}

// ── 查询最新版本 ───────────────────────────────────────────────────────────────

async function fetchLatestRelease(): Promise<ReleaseInfo> {
  // 使用 spawnSync 同步调用 curl，避免引入额外依赖
  const result = spawnSync('curl', ['-fsSL', GITHUB_API], {
    encoding: 'utf-8',
    timeout: 15000,
  });

  if (result.status !== 0 || !result.stdout) {
    throw new Error('无法连接 GitHub API，请检查网络后重试');
  }

  const data = JSON.parse(result.stdout);
  const tag: string = data.tag_name || '';
  if (!tag) throw new Error('GitHub API 返回格式异常');

  return {
    tag,
    version: tag.replace(/^v/, ''),
    htmlUrl: data.html_url || '',
    publishedAt: data.published_at || '',
  };
}

// ── 检测安装类型 ───────────────────────────────────────────────────────────────

type InstallType = 'portable' | 'npm' | 'source';

function detectInstallType(): { type: InstallType; installDir?: string } {
  const scriptPath = dirname(fileURLToPath(import.meta.url));

  // 便携版：/opt/lingxiao/lingxiao → scriptPath 类似 /opt/lingxiao/dist
  // 特征：同级或上级有 lingxiao 可执行文件，且路径含 lingxiao
  const possibleBinaryDirs = [
    join(scriptPath, '..'),
    join(scriptPath, '..', '..'),
  ];

  for (const dir of possibleBinaryDirs) {
    const binPath = join(dir, 'lingxiao');
    const binCmdPath = join(dir, 'lingxiao.cmd');
    if (existsSync(binPath) || existsSync(binCmdPath)) {
      // 检查是否是便携安装目录（不在 node_modules 内）
      if (!dir.includes('node_modules')) {
        return { type: 'portable', installDir: dir };
      }
    }
  }

  // npm 全局安装：路径含 node_modules
  if (scriptPath.includes('node_modules')) {
    return { type: 'npm' };
  }

  // 源码开发
  return { type: 'source' };
}

// ── 下载并解压 ────────────────────────────────────────────────────────────────

async function downloadAndExtract(tag: string, target: string, destDir: string): Promise<void> {
  const isWindows = platform() === 'win32';
  const archiveExt = isWindows ? '.zip' : '.tar.gz';
  const archiveName = `lingxiao-${tag}-${target}${archiveExt}`;
  // 同时尝试不带 v 前缀
  const versionNoV = tag.replace(/^v/, '');
  const archiveNameAlt = `lingxiao-${versionNoV}-${target}${archiveExt}`;

  const baseUrl = `https://github.com/${REPO}/releases/download/${tag}`;
  const downloadUrl = `${baseUrl}/${archiveName}`;
  const downloadUrlAlt = `${baseUrl}/${archiveNameAlt}`;

  const tmpDir = join(tmpdir(), `lingxiao-upgrade-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    console.log(chalk.cyan(`▸ 下载: ${downloadUrl}`));
    let downloadResult = spawnSync('curl', ['-fSL', '-o', join(tmpDir, archiveName), downloadUrl], {
      stdio: 'inherit',
      timeout: 120000,
    });

    let actualArchive = archiveName;

    if (downloadResult.status !== 0) {
      console.log(chalk.yellow(`▸ 重试: ${downloadUrlAlt}`));
      downloadResult = spawnSync('curl', ['-fSL', '-o', join(tmpDir, archiveNameAlt), downloadUrlAlt], {
        stdio: 'inherit',
        timeout: 120000,
      });
      actualArchive = archiveNameAlt;
    }

    if (downloadResult.status !== 0) {
      throw new Error('下载失败，请检查网络或版本号');
    }
    console.log(chalk.green('  ✓ 下载完成'));

    // 解压
    const archivePath = join(tmpDir, actualArchive);
    console.log(chalk.cyan(`▸ 解压到 ${destDir}...`));

    // 备份现有安装
    if (existsSync(destDir)) {
      const backupDir = `${destDir}.bak`;
      if (existsSync(backupDir)) rmSync(backupDir, { recursive: true, force: true });
      renameSync(destDir, backupDir);
      console.log(chalk.yellow(`  ⚠ 旧版本已备份到 ${backupDir}`));
    }

    mkdirSync(destDir, { recursive: true });

    if (isWindows) {
      // Windows: 用 PowerShell 解压 zip
      spawnSync('powershell', ['-Command',
        `Expand-Archive -Path "${archivePath}" -DestinationPath "${destDir}" -Force`], {
        stdio: 'inherit',
      });

      // 如果多一层目录，提上来
      const innerDir = join(destDir, 'lingxiao');
      if (existsSync(innerDir)) {
        spawnSync('powershell', ['-Command',
          `Get-ChildItem "${innerDir}" | ForEach-Object { Move-Item $_.FullName "${destDir}" -Force }; Remove-Item "${innerDir}" -Recurse -Force`], {
          stdio: 'inherit',
        });
      }
    } else {
      // Unix: tar 解压
      spawnSync('tar', ['xzf', archivePath, '-C', destDir, '--strip-components=1'], {
        stdio: 'inherit',
      });
    }

    if (!existsSync(join(destDir, isWindows ? 'lingxiao.cmd' : 'lingxiao'))) {
      throw new Error('解压后未找到可执行文件，可能包结构有变');
    }
    console.log(chalk.green('  ✓ 解压完成'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── 刷新 symlink ──────────────────────────────────────────────────────────────

function refreshSymlink(installDir: string): void {
  const binDir = '/usr/local/bin';
  const binPath = join(installDir, 'lingxiao');
  const linkPath = join(binDir, 'lingxiao');

  if (!existsSync(binPath)) return;
  if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });

  spawnSync('ln', ['-sf', binPath, linkPath], { stdio: 'inherit' });
  console.log(chalk.green(`  ✓ ${linkPath} → ${binPath}`));
}

// ── 主入口 ─────────────────────────────────────────────────────────────────────

export async function runUpgrade(opts: UpgradeOptions = {}): Promise<void> {
  const { check = false } = opts;
  const currentVersion = VERSION;
  const target = detectTarget();

  console.log(chalk.dim(`当前版本: v${currentVersion}  平台: ${target}`));

  // 查询最新版本
  let release: ReleaseInfo;
  try {
    console.log(chalk.cyan('▸ 检查最新版本...'));
    release = await fetchLatestRelease();
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }

  console.log(chalk.dim(`最新版本: ${release.tag}  发布于: ${release.publishedAt || '未知'}`));

  // 版本比较
  const cmp = compareVersions(release.version, currentVersion);
  if (cmp <= 0) {
    console.log(chalk.green(`✓ 已是最新版本 (v${currentVersion})`));
    if (release.htmlUrl) {
      console.log(chalk.dim(`  ${release.htmlUrl}`));
    }
    return;
  }

  console.log(chalk.yellow(`★ 发现新版本: v${currentVersion} → ${release.tag}`));

  if (check) {
    console.log(chalk.cyan('运行 `lingxiao upgrade` 执行升级。'));
    if (release.htmlUrl) {
      console.log(chalk.dim(`  ${release.htmlUrl}`));
    }
    return;
  }

  // 检测安装类型
  const installInfo = detectInstallType();
  console.log(chalk.dim(`安装类型: ${installInfo.type}`));

  if (installInfo.type === 'npm') {
    console.log(chalk.cyan('\nnpm 全局安装 detected，请手动升级：'));
    console.log(chalk.bold('  npm update -g lingxiao_cli'));
    console.log(chalk.dim(`\n或使用便携版安装脚本：`));
    console.log(chalk.dim('  curl -fsSL https://raw.githubusercontent.com/hexian2001/lingxiao-coding/main/scripts/install.sh | sh'));
    return;
  }

  if (installInfo.type === 'source') {
    console.log(chalk.cyan('\n源码开发模式，请手动拉取最新代码：'));
    console.log(chalk.bold('  git pull && npm install && npm run build'));
    return;
  }

  // 便携版：下载并替换
  if (!installInfo.installDir) {
    console.error(chalk.red('✗ 无法确定安装目录'));
    process.exit(1);
  }

  try {
    await downloadAndExtract(release.tag, target, installInfo.installDir);

    // 刷新 symlink (非 Windows)
    if (platform() !== 'win32') {
      console.log(chalk.cyan('▸ 刷新命令链接...'));
      refreshSymlink(installInfo.installDir);
    }

    // 验证新版本
    const verifyResult = spawnSync('lingxiao', ['--version'], { encoding: 'utf-8', timeout: 5000 });
    const newVersion = verifyResult.stdout?.trim() || release.tag;

    console.log('');
    console.log(chalk.green('╔══════════════════════════════════════════════════════════════╗'));
    console.log(chalk.green('║  ✓ 凌霄剑域升级完成                                          ║'));
    console.log(chalk.green(`║  ${currentVersion} → ${release.tag}`));
    console.log(chalk.green(`║  安装目录: ${installInfo.installDir}`));
    console.log(chalk.green('╚══════════════════════════════════════════════════════════════╝'));
    console.log('');
    console.log(chalk.dim('旧版本备份在 .bak 目录，确认无误后可删除。'));
    console.log(chalk.dim('首次使用浏览器功能时会自动下载 Chromium（约 300MB）。'));
  } catch (err) {
    console.error(chalk.red(`✗ 升级失败: ${(err as Error).message}`));
    console.error(chalk.yellow('旧版本备份可在 .bak 目录恢复。'));
    process.exit(1);
  }
}
