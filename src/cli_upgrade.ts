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

  // ── 策略 1：通过 `which lingxiao` + readlink 反向追踪真实安装路径 ──
  // 这是唯一可靠的全局入口探测方式，无论 npm link / 便携版 / 手动 symlink 都能找到
  const whichResult = spawnSync('which', ['lingxiao'], { encoding: 'utf-8', timeout: 5000 });
  if (whichResult.status === 0 && whichResult.stdout.trim()) {
    let binPath = whichResult.stdout.trim();

    // 递归解析 symlink（npm link 会创建 /usr/local/bin/lingxiao → .../bin/lingxiao.js → ...）
    let resolved = binPath;
    for (let i = 0; i < 10; i++) {
      const readlink = spawnSync('readlink', ['-f', resolved], { encoding: 'utf-8', timeout: 5000 });
      if (readlink.status !== 0 || !readlink.stdout.trim()) break;
      const next = readlink.stdout.trim();
      if (next === resolved) break;
      resolved = next;
    }

    // resolved 现在指向真实文件，例如：
    //   源码安装：/root/lingxiao/lingxiao_cli/lingxiao-coding/bin/lingxiao.js
    //   npm 全局：/usr/lib/node_modules/lingxiao_cli/bin/lingxiao.js
    //   便携版：  /opt/lingxiao/bin/lingxiao.js 或 /opt/lingxiao/lingxiao

    // 从真实路径向上查找项目根目录（含 package.json 且 name=lingxiao_cli）
    let dir = dirname(resolved);
    for (let i = 0; i < 8; i++) {
      const pkgPath = join(dir, 'package.json');
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
          if (pkg.name === 'lingxiao_cli') {
            // 判断安装类型
            if (dir.includes('node_modules')) {
              return { type: 'npm', installDir: dir };
            }
            // 检查是否有 .git 目录 → 源码安装
            if (existsSync(join(dir, '.git'))) {
              return { type: 'source', installDir: dir };
            }
            // 无 .git 但有 package.json → 便携版（解压的预构建包）
            return { type: 'portable', installDir: dir };
          }
        } catch { /* package.json 解析失败，继续向上找 */ }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // ── 策略 2：fallback — 从 scriptPath（当前 dist 目录）推断 ──
  // dist/cli_upgrade.js → 项目根 = dirname(scriptPath)
  const projectRoot = dirname(scriptPath);
  const pkgPath = join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.name === 'lingxiao_cli') {
        if (existsSync(join(projectRoot, '.git'))) {
          return { type: 'source', installDir: projectRoot };
        }
        return { type: 'portable', installDir: projectRoot };
      }
    } catch { /* ignore */ }
  }

  // ── 策略 3：legacy fallback — 原有逻辑 ──
  const possibleBinaryDirs = [
    join(scriptPath, '..'),
    join(scriptPath, '..', '..'),
  ];

  for (const dir of possibleBinaryDirs) {
    const binPath = join(dir, 'lingxiao');
    const binCmdPath = join(dir, 'lingxiao.cmd');
    if (existsSync(binPath) || existsSync(binCmdPath)) {
      if (!dir.includes('node_modules')) {
        return { type: 'portable', installDir: dir };
      }
    }
  }

  if (scriptPath.includes('node_modules')) {
    return { type: 'npm' };
  }

  // 无法确定，返回 source + cwd
  return { type: 'source', installDir: process.cwd() };
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
    const backupDir = `${destDir}.bak`;
    let needRollback = false;
    if (existsSync(destDir)) {
      if (existsSync(backupDir)) rmSync(backupDir, { recursive: true, force: true });
      renameSync(destDir, backupDir);
      console.log(chalk.yellow(`  ⚠ 旧版本已备份到 ${backupDir}`));
      needRollback = true;
    }

    try {
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
      needRollback = false; // 成功，不需要回滚
    } catch (extractError) {
      // P0-10: 解压失败时回滚到备份
      if (needRollback && existsSync(backupDir)) {
        console.log(chalk.red('  ✗ 解压失败，正在回滚到旧版本...'));
        rmSync(destDir, { recursive: true, force: true });
        renameSync(backupDir, destDir);
        console.log(chalk.yellow('  ⚠ 已回滚到旧版本'));
      }
      throw extractError;
    }
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
    // 源码安装：自动 git pull + npm install + npm run build
    const sourceDir = installInfo.installDir
      ? (installInfo.installDir.includes('dist')
          ? dirname(installInfo.installDir)
          : installInfo.installDir)
      : process.cwd();

    // 确认是 git 仓库
    const gitCheck = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: sourceDir, encoding: 'utf-8', timeout: 5000,
    });

    if (gitCheck.status !== 0) {
      console.log(chalk.cyan('\n源码开发模式（非 git 仓库），请手动更新：'));
      console.log(chalk.bold('  git pull && npm install && npm run build'));
      return;
    }

    try {
      console.log(chalk.cyan(`\n▸ 源码安装模式，自动升级 (目录: ${sourceDir})`));

      // 1. git fetch + reset 到最新 tag（避免本地修改冲突）
      console.log(chalk.cyan('▸ 拉取最新代码...'));
      const gitFetch = spawnSync('git', ['fetch', '--tags', 'origin'], {
        cwd: sourceDir, stdio: 'inherit', timeout: 60000,
      });
      if (gitFetch.status !== 0) {
        throw new Error('git fetch 失败，请检查网络或手动执行 git pull');
      }

      // checkout 到最新 release tag
      const gitCheckout = spawnSync('git', ['checkout', release.tag], {
        cwd: sourceDir, stdio: 'inherit', timeout: 30000,
      });
      if (gitCheckout.status !== 0) {
        // checkout 失败可能是本地有修改，尝试 stash + pull
        console.log(chalk.yellow('  ⚠ checkout 失败，尝试 stash 后 pull...'));
        spawnSync('git', ['stash'], { cwd: sourceDir, stdio: 'inherit', timeout: 10000 });
        const gitPull = spawnSync('git', ['pull', 'origin', 'main'], {
          cwd: sourceDir, stdio: 'inherit', timeout: 60000,
        });
        if (gitPull.status !== 0) {
          throw new Error('git pull 失败，请手动解决冲突后重试');
        }
      }

      // 2. npm install
      console.log(chalk.cyan('▸ 安装依赖...'));
      const npmInstall = spawnSync('npm', ['install'], {
        cwd: sourceDir, stdio: 'inherit', timeout: 300000,
      });
      if (npmInstall.status !== 0) {
        throw new Error('npm install 失败');
      }

      // 3. npm run build
      console.log(chalk.cyan('▸ 构建项目...'));
      const npmBuild = spawnSync('npm', ['run', 'build'], {
        cwd: sourceDir, stdio: 'inherit', timeout: 300000,
      });
      if (npmBuild.status !== 0) {
        throw new Error('npm run build 失败');
      }

      // 4. npm link（刷新全局链接）
      console.log(chalk.cyan('▸ 刷新全局链接...'));
      const npmLink = spawnSync('npm', ['link'], {
        cwd: sourceDir, stdio: 'inherit', timeout: 30000,
      });
      if (npmLink.status !== 0) {
        console.log(chalk.yellow('  ⚠ npm link 失败，可能需要手动执行 sudo npm link'));
      }

      console.log('');
      console.log(chalk.green('╔══════════════════════════════════════════════════════════════╗'));
      console.log(chalk.green('║  ✓ 凌霄剑域升级完成                                          ║'));
      console.log(chalk.green(`║  ${currentVersion} → ${release.tag}`));
      console.log(chalk.green(`║  安装目录: ${sourceDir}`));
      console.log(chalk.green('╚══════════════════════════════════════════════════════════════╝'));
      console.log('');
      console.log(chalk.dim('如需恢复旧版本，执行: git checkout v' + currentVersion));
    } catch (err) {
      console.error(chalk.red(`✗ 升级失败: ${(err as Error).message}`));
      console.error(chalk.yellow('可手动执行: git pull && npm install && npm run build'));
      process.exit(1);
    }
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
