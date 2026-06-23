#!/usr/bin/env node
/**
 * LingXiao single-source version management script.
 *
 * Canonical source: root VERSION file.
 * Managed files:
 *   - package.json
 *   - package-lock.json
 *   - web/package.json
 *   - web/package-lock.json
 *   - site/package.json / site/package-lock.json when present
 *
 * Usage:
 *   node scripts/bump-version.mjs patch
 *   node scripts/bump-version.mjs minor
 *   node scripts/bump-version.mjs major
 *   node scripts/bump-version.mjs --set 1.0.3
 *   node scripts/bump-version.mjs 1.0.3
 *   node scripts/bump-version.mjs --sync
 *   node scripts/bump-version.mjs --check
 *   node scripts/bump-version.mjs patch --tag --push
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function log(msg = '') { console.log(msg); }

function error(msg) {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
}

function usage(exitCode = 1) {
  console.log(`用法:
  node scripts/bump-version.mjs <patch|minor|major> [--tag] [--push]
  node scripts/bump-version.mjs --set <version> [--tag] [--push]
  node scripts/bump-version.mjs <version> [--tag] [--push]
  node scripts/bump-version.mjs --sync
  node scripts/bump-version.mjs --check

说明:
  VERSION 是唯一人工编辑版本源。
  脚本会同步 root/web/site 的 package.json 与 package-lock.json。`);
  process.exit(exitCode);
}

function relativePath(filePath) {
  return relative(pkgRoot, filePath).replaceAll('\\', '/');
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    error(`${relativePath(filePath)} 不是有效 JSON: ${err.message}`);
  }
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeVersion(rawVersion) {
  if (!rawVersion || typeof rawVersion !== 'string') {
    error('缺少版本号');
  }
  const version = rawVersion.trim().replace(/^v/i, '');
  if (!semverPattern.test(version)) {
    error(`版本号格式无效: ${rawVersion}`);
  }
  return version;
}

function bumpVersion(version, type) {
  const [major, minor, patch] = normalizeVersion(version).split('.').map((n) => Number.parseInt(n, 10));
  switch (type) {
    case 'major': return `${major + 1}.0.0`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'patch': return `${major}.${minor}.${patch + 1}`;
    default: error(`未知 bump 类型: ${type}`);
  }
}

function parseArgs(argv) {
  const parsed = {
    command: null,
    explicitVersion: null,
    shouldTag: false,
    shouldPush: false,
    shouldCheck: false,
    shouldSync: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') usage(0);
    if (arg === '--tag') {
      parsed.shouldTag = true;
      continue;
    }
    if (arg === '--push') {
      parsed.shouldPush = true;
      continue;
    }
    if (arg === '--check') {
      parsed.shouldCheck = true;
      continue;
    }
    if (arg === '--sync') {
      parsed.shouldSync = true;
      continue;
    }
    if (arg === '--set') {
      if (parsed.explicitVersion) error('重复指定版本号');
      i += 1;
      parsed.explicitVersion = normalizeVersion(argv[i]);
      continue;
    }
    if (arg.startsWith('--')) {
      error(`未知参数: ${arg}`);
    }
    if (parsed.command) {
      error(`多余参数: ${arg}`);
    }
    parsed.command = arg;
  }

  if (parsed.shouldPush && !parsed.shouldTag) {
    error('--push 需要 --tag 配合使用');
  }
  if (parsed.shouldCheck && (parsed.command || parsed.explicitVersion || parsed.shouldTag || parsed.shouldPush || parsed.shouldSync)) {
    error('--check 只能单独使用');
  }
  if (parsed.shouldSync && (parsed.command || parsed.explicitVersion || parsed.shouldTag || parsed.shouldPush)) {
    error('--sync 只能单独使用');
  }
  if (parsed.command && parsed.explicitVersion) {
    error('不能同时使用位置参数和 --set');
  }

  return parsed;
}

const args = parseArgs(process.argv.slice(2));
if (process.argv.slice(2).length === 0) usage();

const versionFilePath = join(pkgRoot, 'VERSION');
const rootPkgPath = join(pkgRoot, 'package.json');
const rootPkg = readJson(rootPkgPath);

function readCanonicalVersion({ allowPackageFallback = false } = {}) {
  if (existsSync(versionFilePath)) {
    return normalizeVersion(readFileSync(versionFilePath, 'utf-8'));
  }
  if (allowPackageFallback) {
    // Bootstrap fallback for old checkouts before VERSION existed.
    return normalizeVersion(rootPkg.version);
  }
  error(`${relativePath(versionFilePath)} 缺失；VERSION 必须作为唯一人工编辑版本源提交。可运行 node scripts/bump-version.mjs --sync 从当前 package.json 初始化。`);
}

function writeCanonicalVersion(version) {
  writeFileSync(versionFilePath, `${normalizeVersion(version)}\n`);
  log(`✓ ${relativePath(versionFilePath)} → ${normalizeVersion(version)}`);
}

const currentVersion = readCanonicalVersion({ allowPackageFallback: !args.shouldCheck });

const managedVersionFiles = [
  join(pkgRoot, 'package.json'),
  join(pkgRoot, 'package-lock.json'),
  join(pkgRoot, 'web', 'package.json'),
  join(pkgRoot, 'web', 'package-lock.json'),
  join(pkgRoot, 'site', 'package.json'),
  join(pkgRoot, 'site', 'package-lock.json'),
];

function readVersionFields(filePath) {
  if (!existsSync(filePath)) return [];
  const json = readJson(filePath);
  const fields = [];
  if (typeof json.version === 'string') {
    fields.push({ filePath, selector: 'version', version: normalizeVersion(json.version) });
  }
  if (json.packages && json.packages[''] && typeof json.packages[''].version === 'string') {
    fields.push({ filePath, selector: 'packages[""] .version'.replace(' ', ''), version: normalizeVersion(json.packages[''].version) });
  }
  if (fields.length === 0) {
    error(`${relativePath(filePath)} 缺少可管理的 version 字段`);
  }
  return fields;
}

function updateVersionFile(filePath, newVersion) {
  if (!existsSync(filePath)) return;
  const json = readJson(filePath);
  const touched = [];

  if (typeof json.version === 'string') {
    json.version = newVersion;
    touched.push('version');
  }
  if (json.packages && json.packages[''] && typeof json.packages[''].version === 'string') {
    json.packages[''].version = newVersion;
    touched.push('packages[""] .version'.replace(' ', ''));
  }
  if (touched.length === 0) {
    error(`${relativePath(filePath)} 缺少可管理的 version 字段`);
  }

  writeJson(filePath, json);
  log(`✓ ${relativePath(filePath)} → ${newVersion} (${touched.join(', ')})`);
}

function checkVersionConsistency(expectedVersion) {
  log(`• ${relativePath(versionFilePath)} = ${expectedVersion}`);
  const fields = managedVersionFiles.flatMap(readVersionFields);
  const mismatches = fields.filter((field) => field.version !== expectedVersion);

  for (const field of fields) {
    log(`• ${relativePath(field.filePath)} ${field.selector} = ${field.version}`);
  }

  if (mismatches.length > 0) {
    log('');
    for (const field of mismatches) {
      log(`✗ ${relativePath(field.filePath)} ${field.selector}: ${field.version} !== ${expectedVersion}`);
    }
    error(`版本不一致；canonical version 应为 ${expectedVersion}`);
  }

  log(`\n✓ 所有受管版本字段已统一为 ${expectedVersion}`);
}

if (args.shouldCheck) {
  checkVersionConsistency(currentVersion);
  process.exit(0);
}

let newVersion;
if (args.shouldSync) {
  newVersion = currentVersion;
} else if (args.explicitVersion) {
  newVersion = args.explicitVersion;
} else if (args.command && ['patch', 'minor', 'major'].includes(args.command)) {
  newVersion = bumpVersion(currentVersion, args.command);
} else if (args.command) {
  newVersion = normalizeVersion(args.command);
} else {
  usage();
}

log(`\n┌────────────────────────────────────────────┐`);
log(`│  版本同步: ${currentVersion} → ${newVersion}${' '.repeat(Math.max(0, 18 - newVersion.length))}│`);
log(`└────────────────────────────────────────────┘\n`);

writeCanonicalVersion(newVersion);
for (const filePath of managedVersionFiles) {
  updateVersionFile(filePath, newVersion);
}

// ── 更新首页硬编码版本号（site 存在时）─────────────────────────────────────────

const indexPath = join(pkgRoot, 'site', 'src', 'pages', 'index.astro');
if (existsSync(indexPath)) {
  let content = readFileSync(indexPath, 'utf-8');
  const versionRegex = /LingXiao\s+v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/g;
  if (versionRegex.test(content)) {
    content = content.replace(versionRegex, `LingXiao v${newVersion}`);
    writeFileSync(indexPath, content);
    log(`✓ ${relativePath(indexPath)} → v${newVersion}`);
  }
}

// ── 更新 changelog 提示（site 存在时）──────────────────────────────────────────

const changelogPath = join(pkgRoot, 'site', 'src', 'content', 'docs', 'reference', 'changelog.md');
if (existsSync(changelogPath)) {
  let content = readFileSync(changelogPath, 'utf-8');
  const tag = `v${newVersion}`;
  if (!content.includes(`## ${tag}`)) {
    const today = new Date().toISOString().slice(0, 10);
    const newEntry = `## ${tag}（${today}）\n\n### 变更内容\n\n- (待补充)\n`;
    content = content.replace(/^(# .+\n\n## )/m, `${newEntry}\n$1`);
    writeFileSync(changelogPath, content);
    log(`✓ ${relativePath(changelogPath)} → 添加 ${tag} 条目`);
  }
}

checkVersionConsistency(newVersion);

function currentGitBranch() {
  try {
    return execSync('git branch --show-current', { cwd: pkgRoot, encoding: 'utf-8' }).trim() || 'main';
  } catch {
    return 'main';
  }
}

function hasStagedChanges() {
  try {
    execSync('git diff --cached --quiet', { cwd: pkgRoot, stdio: 'ignore' });
    return false;
  } catch {
    return true;
  }
}

if (args.shouldTag) {
  const tag = `v${newVersion}`;
  try {
    try {
      execSync(`git rev-parse ${tag}`, { stdio: 'pipe', cwd: pkgRoot });
      error(`git tag ${tag} 已存在`);
    } catch {
      // tag 不存在，继续
    }

    execSync('git add -A', { stdio: 'inherit', cwd: pkgRoot });
    if (hasStagedChanges()) {
      execSync(`git commit -m "release: bump version → ${tag}"`, { stdio: 'inherit', cwd: pkgRoot });
    } else {
      log('→ 没有版本文件变更，跳过 release commit');
    }
    execSync(`git tag ${tag}`, { stdio: 'inherit', cwd: pkgRoot });
    log(`✓ git tag ${tag} 已创建`);

    if (args.shouldPush) {
      const branch = currentGitBranch();
      execSync(`git push origin ${branch}`, { stdio: 'inherit', cwd: pkgRoot });
      execSync(`git push origin ${tag}`, { stdio: 'inherit', cwd: pkgRoot });
      log(`✓ 已推送 ${branch} 和 ${tag} 到 origin`);
    } else {
      log(`\n→ 推送以触发 CI: git push origin ${currentGitBranch()} && git push origin ${tag}`);
    }
  } catch (err) {
    error(`git 操作失败: ${err.message}`);
  }
} else {
  log(`\n→ 如需创建 tag: git tag v${newVersion}`);
  log(`→ 如需推送 tag: git push origin v${newVersion}`);
}

log(`\n✓ 版本同步完成\n`);

