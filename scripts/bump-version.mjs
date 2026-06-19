#!/usr/bin/env node
/**
 * lingxiao version bump 脚本
 *
 * 用法：
 *   node scripts/bump-version.mjs <patch|minor|major> [pre-release-id]
 *
 * 功能：
 *   1. 更新 root package.json 版本号
 *   2. 同步 web/package.json 和 site/package.json
 *   3. 更新首页 index.astro 中硬编码的版本号
 *   4. 可选：创建 git tag（需 --tag 参数）
 *   5. 可选：推送 tag 触发 release CI（需 --push 参数）
 *
 * 示例：
 *   node scripts/bump-version.mjs patch           # 0.3.9 → 0.3.10
 *   node scripts/bump-version.mjs minor           # 0.3.9 → 0.4.0
 *   node scripts/bump-version.mjs major           # 0.3.9 → 1.0.0
 *   node scripts/bump-version.mjs patch --tag     # bump + 创建 git tag
 *   node scripts/bump-version.mjs patch --tag --push  # bump + tag + push
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function log(msg) { console.log(msg); }

function error(msg) {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
}

// ── 解析参数 ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0 || !['patch', 'minor', 'major'].includes(args[0])) {
  console.log('用法: node scripts/bump-version.mjs <patch|minor|major> [--tag] [--push]');
  process.exit(1);
}

const bumpType = args[0];
const shouldTag = args.includes('--tag');
const shouldPush = args.includes('--push');

if (shouldPush && !shouldTag) {
  error('--push 需要 --tag 配合使用');
}

// ── 读取当前版本 ───────────────────────────────────────────────────────────────

const rootPkgPath = join(pkgRoot, 'package.json');
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
const currentVersion = rootPkg.version;

// ── 计算新版本号 ───────────────────────────────────────────────────────────────

function bumpVersion(version, type) {
  const [major, minor, patch] = version.split('.').map((n) => parseInt(n, 10));
  switch (type) {
    case 'major': return `${major + 1}.0.0`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'patch': return `${major}.${minor}.${patch + 1}`;
    default: error(`未知 bump 类型: ${type}`);
  }
}

const newVersion = bumpVersion(currentVersion, bumpType);

log(`\n┌────────────────────────────────────────────┐`);
log(`│  版本升级: ${currentVersion} → ${newVersion}${' '.repeat(Math.max(0, 18 - newVersion.length))}│`);
log(`└────────────────────────────────────────────┘\n`);

// ── 1. 更新 root package.json ─────────────────────────────────────────────────

rootPkg.version = newVersion;
writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n');
log(`✓ root package.json → ${newVersion}`);

// ── 2. 同步子包 ───────────────────────────────────────────────────────────────

const subPackages = [
  join(pkgRoot, 'web', 'package.json'),
  join(pkgRoot, 'site', 'package.json'),
];

for (const subPath of subPackages) {
  if (!existsSync(subPath)) continue;
  const subPkg = JSON.parse(readFileSync(subPath, 'utf-8'));
  subPkg.version = newVersion;
  writeFileSync(subPath, JSON.stringify(subPkg, null, 2) + '\n');
  log(`✓ ${subPath.replace(pkgRoot + '/', '')} → ${newVersion}`);
}

// ── 3. 更新首页硬编码版本号 ────────────────────────────────────────────────────

const indexPath = join(pkgRoot, 'site', 'src', 'pages', 'index.astro');
if (existsSync(indexPath)) {
  let content = readFileSync(indexPath, 'utf-8');
  // 匹配 LingXiao vX.Y.Z
  const versionRegex = /LingXiao\s+v\d+\.\d+\.\d+/g;
  if (versionRegex.test(content)) {
    content = content.replace(versionRegex, `LingXiao v${newVersion}`);
    writeFileSync(indexPath, content);
    log(`✓ site/src/pages/index.astro → v${newVersion}`);
  }
}

// ── 4. 更新 changelog 提示 ─────────────────────────────────────────────────────

const changelogPath = join(pkgRoot, 'site', 'src', 'content', 'docs', 'reference', 'changelog.md');
if (existsSync(changelogPath)) {
  let content = readFileSync(changelogPath, 'utf-8');
  const tag = `v${newVersion}`;
  // 检查是否已有该版本条目
  if (!content.includes(`## ${tag}`)) {
    const today = new Date().toISOString().slice(0, 10);
    const newEntry = `## ${tag}（${today}）\n\n### 变更内容\n\n- (待补充)\n`;
    // 在第一个 ## 标题后插入
    content = content.replace(/^(# .+\n\n## )/m, `${newEntry}\n$1`);
    writeFileSync(changelogPath, content);
    log(`✓ changelog.md → 添加 ${tag} 条目`);
  }
}

// ── 5. 可选：git tag ───────────────────────────────────────────────────────────

if (shouldTag) {
  const tag = `v${newVersion}`;
  try {
    // 检查 tag 是否已存在
    try {
      execSync(`git rev-parse ${tag}`, { stdio: 'pipe' });
      error(`git tag ${tag} 已存在`);
    } catch {
      // tag 不存在，继续
    }

    execSync(`git add -A`, { stdio: 'inherit', cwd: pkgRoot });
    execSync(`git commit -m "release: bump version → ${tag}"`, { stdio: 'inherit', cwd: pkgRoot });
    execSync(`git tag ${tag}`, { stdio: 'inherit', cwd: pkgRoot });
    log(`✓ git tag ${tag} 已创建`);

    if (shouldPush) {
      execSync(`git push origin main`, { stdio: 'inherit', cwd: pkgRoot });
      execSync(`git push origin ${tag}`, { stdio: 'inherit', cwd: pkgRoot });
      log(`✓ 已推送到 origin — CI 将自动构建 release`);
    } else {
      log(`\n→ 推送以触发 CI: git push origin main && git push origin ${tag}`);
    }
  } catch (err) {
    error(`git 操作失败: ${err.message}`);
  }
} else {
  log(`\n→ 创建 tag: git tag v${newVersion}`);
  log(`→ 触发 release: git push origin v${newVersion}`);
}

log(`\n✓ 版本升级完成\n`);
