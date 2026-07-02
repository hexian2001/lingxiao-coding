/**
 * lingxiao upgrade — 自更新命令（跨平台）
 *
 * 功能：
 *   lingxiao upgrade          检查并升级到最新版本
 *   lingxiao upgrade --check  只检查不更新
 *
 * 原理：
 *   1. 查询 GitHub releases/latest 获取最新 tag（Node 原生 fetch，不依赖 curl）
 *   2. 与当前 VERSION 做 semver 比较
 *   3. 根据安装类型自动选择升级策略：
 *      - source: git pull + npm install + npm run build
 *      - portable: 下载平台对应预构建包 → 替换安装目录 → 刷新 symlink
 *      - npm: 提示 npm update -g
 *   4. 跨平台支持 Windows/macOS/Linux × x64/arm64
 */

import { VERSION } from './version.js';
import { platform, arch, tmpdir } from 'os';
import { existsSync, readFileSync, mkdirSync, rmSync, renameSync, realpathSync, createWriteStream } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { pipeline } from 'stream/promises';
import chalk from 'chalk';

const IS_WINDOWS = platform() === 'win32';
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

// ── 查询最新版本（Node 原生 fetch，跨平台） ────────────────────────────────────

async function fetchLatestRelease(): Promise<ReleaseInfo> {
  const response = await fetch(GITHUB_API, {
    headers: { 'User-Agent': 'lingxiao-cli' },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`无法连接 GitHub API (HTTP ${response.status})，请检查网络后重试`);
  }

  const data = await response.json() as { tag_name?: string; html_url?: string; published_at?: string };
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

  // ── 策略 1：通过 `which`/`where lingxiao` + realpath 反向追踪真实安装路径 ──
  // 跨平台：Unix 用 which，Windows 用 where；解析 symlink 用 Node fs.realpathSync
  const whichCmd = IS_WINDOWS ? 'where' : 'which';
  const whichResult = spawnSync(whichCmd, ['lingxiao'], { encoding: 'utf-8', timeout: 5000, shell: IS_WINDOWS });
  if (whichResult.status === 0 && whichResult.stdout.trim()) {
    // Windows `where` 可能返回多行，取第一行；Unix `which` 返回单行
    let binPath = whichResult.stdout.trim().split('\n')[0].trim().replace(/\r$/, '');

    // 递归解析 symlink（npm link 会创建 /usr/local/bin/lingxiao → .../bin/lingxiao.js → ...）
    // 跨平台：用 Node fs.realpathSync 替代 readlink -f
    let resolved = binPath;
    try {
      resolved = realpathSync(binPath);
    } catch {
      // realpathSync 失败时 fallback 到原路径
    }

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
  // Windows 上 dist\cli_upgrade.js → 项目根 = dirname(scriptPath) 同样有效
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

  // ── 策略 3：legacy fallback ──
  const possibleBinaryDirs = [
    join(scriptPath, '..'),
    join(scriptPath, '..', '..'),
  ];

  for (const dir of possibleBinaryDirs) {
    // 跨平台：Unix 检查 lingxiao，Windows 检查 lingxiao.cmd / lingxiao.exe
    const binPath = join(dir, 'lingxiao');
    const binCmdPath = join(dir, 'lingxiao.cmd');
    const binExePath = join(dir, 'lingxiao.exe');
    if (existsSync(binPath) || existsSync(binCmdPath) || existsSync(binExePath)) {
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

// ── 下载并解压（跨平台） ──────────────────────────────────────────────────────

async function downloadAndExtract(tag: string, target: string, destDir: string): Promise<void> {
  // 跨平台：Windows 用 .zip，Unix 用 .tar.gz
  const archiveExt = IS_WINDOWS ? '.zip' : '.tar.gz';
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
    // 跨平台下载：使用 Node 原生 fetch + stream pipeline，不依赖 curl
    console.log(chalk.cyan(`▸ 下载: ${downloadUrl}`));
    let actualArchive = archiveName;
    let downloadOk = false;

    try {
      const archivePath = join(tmpDir, archiveName);
      const resp = await fetch(downloadUrl, {
        signal: AbortSignal.timeout(120000),
        redirect: 'follow',
      });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
      const ws = createWriteStream(archivePath);
      await pipeline(resp.body, ws);
      downloadOk = true;
    } catch {
      console.log(chalk.yellow(`▸ 重试: ${downloadUrlAlt}`));
      try {
        const archivePath = join(tmpDir, archiveNameAlt);
        const resp = await fetch(downloadUrlAlt, {
          signal: AbortSignal.timeout(120000),
          redirect: 'follow',
        });
        if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
        const ws = createWriteStream(archivePath);
        await pipeline(resp.body, ws);
        actualArchive = archiveNameAlt;
        downloadOk = true;
      } catch {
        // 两个 URL 都失败
      }
    }

    if (!downloadOk) {
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

      if (IS_WINDOWS) {
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

      // 跨平台验证可执行文件
      const exeFound = IS_WINDOWS
        ? existsSync(join(destDir, 'lingxiao.cmd')) || existsSync(join(destDir, 'lingxiao.exe'))
        : existsSync(join(destDir, 'lingxiao'));
      if (!exeFound) {
        throw new Error('解压后未找到可执行文件，可能包结构有变');
      }
      console.log(chalk.green('  ✓ 解压完成'));
      needRollback = false; // 成功，不需要回滚
    } catch (extractError) {
      // 解压失败时回滚到备份
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

// ── 刷新 symlink（跨平台） ────────────────────────────────────────────────────

function refreshSymlink(installDir: string): void {
  // Windows 不使用 symlink — 便携版通过 PATH 或直接运行 lingxiao.cmd
  if (IS_WINDOWS) {
    console.log(chalk.dim('  ℹ Windows 便携版，请确保安装目录在 PATH 中'));
    return;
  }

  // Unix: 创建/刷新 /usr/local/bin/lingxiao symlink
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

    // 确认是 git 仓库（git 命令本身跨平台）
    const gitCheck = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: sourceDir, encoding: 'utf-8', timeout: 5000, shell: IS_WINDOWS,
    });

    if (gitCheck.status !== 0) {
      console.log(chalk.cyan('\n源码开发模式（非 git 仓库），请手动更新：'));
      console.log(chalk.bold('  git pull && npm install && npm run build'));
      return;
    }

    try {
      console.log(chalk.cyan(`\n▸ 源码安装模式，强制升级 (目录: ${sourceDir})`));

      // 1. git fetch + 强制 reset 到最新 tag（丢弃所有本地修改）
      // --force：允许覆盖本地已存在但被远端重打的 tag（避免 "would clobber existing tag" 让整个升级失败）
      console.log(chalk.cyan('▸ 拉取最新代码...'));
      const gitFetch = spawnSync('git', ['fetch', '--all', '--tags', '--prune', '--force'], {
        cwd: sourceDir, stdio: 'inherit', timeout: 60000, shell: IS_WINDOWS,
      });
      // fetch 非零通常只是个别历史 tag 冲突，主要 ref（目标 tag / 分支）一般已成功拉取。
      // 不直接中断，降级为警告，让后续 reset 决定成败——reset 找不到目标 ref 时才真正报错。
      if (gitFetch.status !== 0) {
        console.log(chalk.yellow('  ⚠ git fetch 返回非零（可能是个别 tag 冲突或网络抖动），继续尝试重置到目标版本...'));
      }

      // 强制 reset 到最新 release tag，丢弃所有本地修改。
      // 用 refs/tags/ 前缀消除 tag 与同名分支的歧义（refname ambiguous）。
      const resetRef = `refs/tags/${release.tag}`;
      console.log(chalk.cyan(`▸ 强制重置到 ${release.tag}（将丢弃所有本地修改）...`));
      const gitReset = spawnSync('git', ['reset', '--hard', resetRef], {
        cwd: sourceDir, stdio: 'inherit', timeout: 30000, shell: IS_WINDOWS,
      });
      if (gitReset.status !== 0) {
        throw new Error(`git reset --hard ${release.tag} 失败，请检查 tag 是否存在（fetch 是否成功拉取该 tag）`);
      }

      // 清理未追踪的文件和目录（保留 node_modules，避免重新下载所有依赖）
      console.log(chalk.cyan('▸ 清理未追踪文件...'));
      const gitClean = spawnSync('git', ['clean', '-fd'], {
        cwd: sourceDir, stdio: 'inherit', timeout: 30000, shell: IS_WINDOWS,
      });
      if (gitClean.status !== 0) {
        console.log(chalk.yellow('  ⚠ git clean 失败（可忽略）'));
      }

      // 2. 清理旧的构建产物（确保全新构建）
      const distDir = join(sourceDir, 'dist');
      if (existsSync(distDir)) {
        console.log(chalk.cyan('▸ 清理旧的构建产物...'));
        rmSync(distDir, { recursive: true, force: true });
      }

      // 3. npm install（npm 命令跨平台，Windows 上需要 npm.cmd）
      const npmCmd = IS_WINDOWS ? 'npm.cmd' : 'npm';
      console.log(chalk.cyan('▸ 安装依赖（强制重新安装）...'));
      // 跳过 electron 二进制下载（CLI 源码升级不需要，避免大文件下载超时）
      const npmInstall = spawnSync(npmCmd, ['install', '--force'], {
        cwd: sourceDir, stdio: 'inherit', timeout: 300000,
        env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
      });
      if (npmInstall.status !== 0) {
        throw new Error('npm install 失败（可能是网络问题，尝试设置代理后手动执行 npm install --force）');
      }

      // 4. npm run build
      console.log(chalk.cyan('▸ 构建项目...'));
      const npmBuild = spawnSync(npmCmd, ['run', 'build'], {
        cwd: sourceDir, stdio: 'inherit', timeout: 300000,
      });
      if (npmBuild.status !== 0) {
        throw new Error('npm run build 失败');
      }

      // 5. npm link（刷新全局链接）
      console.log(chalk.cyan('▸ 刷新全局链接...'));
      const npmLink = spawnSync(npmCmd, ['link'], {
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

    // 刷新 symlink（跨平台：Windows 跳过）
    console.log(chalk.cyan('▸ 刷新命令链接...'));
    refreshSymlink(installInfo.installDir);

    // 验证新版本（跨平台）
    const verifyCmd = IS_WINDOWS ? 'lingxiao.cmd' : 'lingxiao';
    const verifyResult = spawnSync(verifyCmd, ['--version'], { encoding: 'utf-8', timeout: 5000, shell: IS_WINDOWS });
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
