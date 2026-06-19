/**
 * package-release-source.mjs — 生成完整源码分发包
 *
 * 排除 node_modules 和 dist，保留完整源码、配置、lockfile 和构建脚本。
 * 生成的 tarball 根目录为 package/，解压后可跨 macOS / Linux / Windows 安装构建。
 *
 * Usage:
 *   node scripts/package-release-source.mjs
 *   → 生成 release/lingxiao_cli-<version>-full.tar.gz
 */

import { createReadStream, createWriteStream, existsSync, copyFileSync, mkdirSync, rmSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createGzip } from 'zlib';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const pkgRoot = resolve(__dirname, '..');
if (!existsSync(join(pkgRoot, 'src')) || !existsSync(join(pkgRoot, 'web', 'package.json'))) {
  console.error('[package] This source release packager must be run from a full source checkout.');
  process.exit(1);
}
const tmpRoot = join(pkgRoot, '.tmp-pkg');
const releaseDir = join(pkgRoot, 'release');

// ── 1. 读取版本号 ──────────────────────────────────────────────────────────
const pkgJson = JSON.parse(
  readFileSync(join(pkgRoot, 'package.json'), 'utf8')
);
const version = pkgJson.version;
const tarballName = `lingxiao_cli-${version}-full.tar.gz`;
const tarballPath = join(releaseDir, tarballName);

// ── 2. 排除列表（不打包）───────────────────────────────────────────────────
const EXCLUDED_NAMES = new Set([
  'node_modules',
  'dist',
  '.git',
  '.claude',
  '.codebuddy',
  'release',
  '.tmp-pkg',
  '.DS_Store',
  'Thumbs.db',
]);

const EXCLUDED_PATTERNS = [
  /\.log$/,
  /\.tgz$/,
  /\.tar\.gz$/,
  /\.mp3$/,
  /\.mp4$/,
  /\.wav$/,
  /\.mov$/,
  /\.tsbuildinfo$/,
];

// 路径相对于 pkgRoot 的前缀，命中即跳过整目录。用于剔除体积大但可按需重新生成/下载的资源。
const EXCLUDED_PATH_PREFIXES = [
  'skills/bundled/huashu-design/assets/sfx',
  'skills/bundled/huashu-design/assets/showcases',
  'skills/bundled/huashu-design/demos',
  'test',
  'test-fixtures',
  'release',
  'docs',
];

function relativeToPkgRoot(fullPath) {
  return fullPath.startsWith(pkgRoot) ? fullPath.slice(pkgRoot.length + 1).replace(/\\/g, '/') : '';
}

function shouldExclude(name, fullPath) {
  if (EXCLUDED_NAMES.has(name)) return true;
  for (const pat of EXCLUDED_PATTERNS) {
    if (pat.test(name)) return true;
  }
  const rel = relativeToPkgRoot(fullPath);
  for (const prefix of EXCLUDED_PATH_PREFIXES) {
    if (rel === prefix || rel.startsWith(prefix + '/')) return true;
  }
  return false;
}

// ── 3. 递归复制文件 ────────────────────────────────────────────────────────
function copyRecursive(src, dest) {
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (shouldExclude(entry.name, srcPath)) continue;

    if (entry.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      copyRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

function normalizeTarPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

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
  throw new Error(`Tar path is too long for ustar header: ${name}`);
}

function writeString(buf, offset, length, value) {
  const bytes = Buffer.from(value);
  bytes.copy(buf, offset, 0, Math.min(bytes.length, length));
}

function writeOctal(buf, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, '0').slice(-(length - 1));
  writeString(buf, offset, length - 1, text);
  buf[offset + length - 1] = 0;
}

function tarHeader(entryName, stat, typeflag) {
  const header = Buffer.alloc(512, 0);
  const { name, prefix } = splitTarName(normalizeTarPath(entryName));
  const mode = typeflag === '5' ? 0o755 : (stat.mode & 0o777) || 0o644;
  const size = typeflag === '5' ? 0 : stat.size;

  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor(stat.mtimeMs / 1000));
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, typeflag);
  writeString(header, 257, 6, 'ustar');
  writeString(header, 263, 2, '00');
  writeString(header, 265, 32, 'lingxiao');
  writeString(header, 297, 32, 'lingxiao');
  writeString(header, 345, 155, prefix);

  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeString(header, 148, 8, checksum.toString(8).padStart(6, '0') + '\0 ');
  return header;
}

function collectTarEntries(root, relativeRoot = 'package') {
  const entries = [];
  function walk(fullPath, relPath) {
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      entries.push({ fullPath, relPath: `${normalizeTarPath(relPath).replace(/\/?$/, '/')}`, stat, type: '5' });
      for (const entry of readdirSync(fullPath, { withFileTypes: true })) {
        walk(join(fullPath, entry.name), `${relPath}/${entry.name}`);
      }
    } else if (stat.isFile()) {
      entries.push({ fullPath, relPath: normalizeTarPath(relPath), stat, type: '0' });
    }
  }
  walk(root, relativeRoot);
  return entries;
}

function writeToStream(stream, chunk) {
  return new Promise((resolveWrite, rejectWrite) => {
    const onError = (error) => {
      stream.off('drain', onDrain);
      rejectWrite(error);
    };
    const onDrain = () => {
      stream.off('error', onError);
      resolveWrite();
    };
    stream.once('error', onError);
    if (stream.write(chunk)) {
      stream.off('error', onError);
      resolveWrite();
    } else {
      stream.once('drain', onDrain);
    }
  });
}

async function pipeFileIntoStream(filePath, stream) {
  const input = createReadStream(filePath);
  for await (const chunk of input) {
    await writeToStream(stream, chunk);
  }
}

async function createTarGz(root, dest) {
  const output = createWriteStream(dest);
  const gzip = createGzip({ level: 9 });
  gzip.pipe(output);

  const done = new Promise((resolveDone, rejectDone) => {
    output.on('finish', resolveDone);
    output.on('error', rejectDone);
    gzip.on('error', rejectDone);
  });

  for (const entry of collectTarEntries(root)) {
    await writeToStream(gzip, tarHeader(entry.relPath, entry.stat, entry.type));
    if (entry.type === '0') {
      await pipeFileIntoStream(entry.fullPath, gzip);
      const padding = (512 - (entry.stat.size % 512)) % 512;
      if (padding > 0) await writeToStream(gzip, Buffer.alloc(padding));
    }
  }

  await writeToStream(gzip, Buffer.alloc(1024));
  gzip.end();
  await done;
}

// ── 4. 清理并创建临时目录 ──────────────────────────────────────────────────
console.log(`\n[package] Preparing tarball for v${version}...`);

if (existsSync(tmpRoot)) {
  rmSync(tmpRoot, { recursive: true, force: true });
}
mkdirSync(tmpRoot, { recursive: true });

const pkgDir = join(tmpRoot, 'package');
mkdirSync(pkgDir, { recursive: true });

// ── 5. 复制项目文件到 package/ ─────────────────────────────────────────────
console.log('[package] Copying project files...');
copyRecursive(pkgRoot, pkgDir);

// ── 6. 确保 release 目录存在 ───────────────────────────────────────────────
mkdirSync(releaseDir, { recursive: true });

// ── 7. 删除已有 tarball ────────────────────────────────────────────────────
if (existsSync(tarballPath)) {
  rmSync(tarballPath, { force: true });
}

// ── 8. 打包 ────────────────────────────────────────────────────────────────
console.log(`[package] Creating tarball: ${tarballName}`);

await createTarGz(pkgDir, tarballPath);

// ── 9. 清理临时目录 ────────────────────────────────────────────────────────
rmSync(tmpRoot, { recursive: true, force: true });

// ── 10. 输出结果 ───────────────────────────────────────────────────────────
const stats = statSync(tarballPath);
const sizeMB = (stats.size / 1024 / 1024).toFixed(1);

console.log(`\n✓ Package created: release/${tarballName} (${sizeMB} MB)`);
console.log(`\nUsage after extracting on macOS / Linux / Windows:`);
console.log(`  tar xzf ${tarballName}`);
console.log(`  cd package`);
console.log(`  npm install`);
console.log(`  npm run build`);
console.log(`  npm link`);
console.log(`  lingxiao doctor`);
console.log(`  lingxiao`);
console.log(`\nPowerShell 5.x note: run commands line by line; do not chain with &&.`);
