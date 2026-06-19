/**
 * build.mjs — Cross-platform build script
 *
 * Replaces the Unix-only shell commands in `npm run build`:
 *   - optional `rm -rf dist`      → fs.rmSync  (works on Windows, macOS, Linux)
 *   - `tsc -p tsconfig.cli.json` → npx tsc    (cross-platform via shell:true)
 *   - `cd web && vite build`     → vite build with cwd option (no `cd` needed)
 *   - `chmod +x dist/cli.js`     → fs.chmodSync (no-op on Windows)
 *
 * Usage (invoked automatically by `npm run build`):
 *   node scripts/build.mjs [--web-only] [--server-only] [--clean] [--package]
 */

import { execSync } from 'child_process';
import { copyFileSync, existsSync, chmodSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { platform } from 'os';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const IS_WINDOWS = platform() === 'win32';

const args = process.argv.slice(2);
const WEB_ONLY = args.includes('--web-only');
const SERVER_ONLY = args.includes('--server-only');
const PACKAGE_BUILD = args.includes('--package');
const CLEAN = args.includes('--clean') || PACKAGE_BUILD || process.env.LINGXIAO_CLEAN_BUILD === '1';
const DEV_ONLY_DIST_GLOBS = [
  /^test-llm-request\.(?:js|js\.map|d\.ts|d\.ts\.map)$/,
];
const GENERATED_OUTPUT_SUFFIXES = ['.d.ts.map', '.js.map', '.d.ts', '.js'];

/**
 * 同步 web/package.json 和 site/package.json 的 version 到 root package.json，确保所有子包与 CLI 同版本。
 * Root package.json 是版本号的唯一来源（single source of truth）。
 */
function syncSubPackageVersions() {
  const rootPkgPath = join(pkgRoot, 'package.json');
  if (!existsSync(rootPkgPath)) return;
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
  const subPaths = [
    join(pkgRoot, 'web', 'package.json'),
    join(pkgRoot, 'site', 'package.json'),
  ];
  for (const subPath of subPaths) {
    if (!existsSync(subPath)) continue;
    const subPkg = JSON.parse(readFileSync(subPath, 'utf-8'));
    if (subPkg.version === rootPkg.version) continue;
    subPkg.version = rootPkg.version;
    writeFileSync(subPath, JSON.stringify(subPkg, null, 2) + '\n');
    console.log(`> sync ${subPath.replace(pkgRoot + '/', '')} version → ${rootPkg.version}`);
  }
}

/** Run a command, streaming output to the terminal. */
function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', shell: IS_WINDOWS, ...opts });
}

/** Resolve the Vite binary inside web/node_modules, or fall back to npx. */
function viteCmd() {
  const local = join(pkgRoot, 'web', 'node_modules', '.bin', IS_WINDOWS ? 'vite.cmd' : 'vite');
  if (existsSync(local)) return JSON.stringify(local);
  return IS_WINDOWS ? 'npx.cmd vite' : 'npx vite';
}

function pruneDevOnlyDistFiles() {
  const distPath = join(pkgRoot, 'dist');
  if (!existsSync(distPath)) return;
  for (const fileName of ['test-llm-request.js', 'test-llm-request.js.map', 'test-llm-request.d.ts', 'test-llm-request.d.ts.map']) {
    const shouldPrune = DEV_ONLY_DIST_GLOBS.some((pattern) => pattern.test(fileName));
    if (!shouldPrune) continue;
    const filePath = join(distPath, fileName);
    if (existsSync(filePath)) {
      rmSync(filePath, { force: true });
      console.log(`> prune dev-only dist/${fileName}`);
    }
  }
}

function walkFiles(root, relativeRoot = '') {
  const files = [];
  for (const entry of readdirSync(join(root, relativeRoot), { withFileTypes: true })) {
    const relativePath = relativeRoot ? join(relativeRoot, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...walkFiles(root, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath.replace(/\\/g, '/'));
    }
  }
  return files;
}

function sourceCandidatesForDistFile(relativeDistPath) {
  const suffix = GENERATED_OUTPUT_SUFFIXES.find((candidate) => relativeDistPath.endsWith(candidate));
  if (!suffix) return [];

  const base = relativeDistPath.slice(0, -suffix.length);
  if (suffix.startsWith('.d.ts')) {
    return [`${base}.ts`, `${base}.tsx`, `${base}.d.ts`];
  }
  return [`${base}.ts`, `${base}.tsx`];
}

function hasActiveSource(relativeDistPath) {
  return sourceCandidatesForDistFile(relativeDistPath).some((relativeSourcePath) => (
    existsSync(join(pkgRoot, 'src', relativeSourcePath))
  ));
}

function pruneUnmappedDistSidecars() {
  const distPath = join(pkgRoot, 'dist');
  if (!existsSync(distPath)) return;

  const pruned = [];
  for (const relativeDistPath of walkFiles(distPath)) {
    if (sourceCandidatesForDistFile(relativeDistPath).length === 0) continue;
    if (hasActiveSource(relativeDistPath)) continue;

    rmSync(join(distPath, relativeDistPath), { force: true });
    pruned.push(relativeDistPath);
  }

  if (pruned.length > 0) {
    console.log(`> prune generated dist sidecars without active src (${pruned.length})`);
  }
}

// ── 0. Sync web subpackage version with root package.json (single source of truth) ──
syncSubPackageVersions();

// ── 1. Model snapshot refresh ────────────────────────────────────────────────
// 每次构建自动拉取最新模型数据；网络不通时 fetch-models-snapshot.mjs 会静默保留当前文件。
// 设 LINGXIAO_SKIP_MODELS_SNAPSHOT=1 可跳过（离线/CI 场景）。
if (!WEB_ONLY && process.env.LINGXIAO_SKIP_MODELS_SNAPSHOT !== '1') {
  run(`node scripts/fetch-models-snapshot.mjs`, { cwd: pkgRoot });
} else if (!WEB_ONLY) {
  console.log('\n> skip model snapshot refresh (LINGXIAO_SKIP_MODELS_SNAPSHOT=1)');
}

// ── 2. Optional clean dist/ ───────────────────────────────────────────────────
//
// Keep dist/ in place by default. The daemon runs from dist/ and may spawn
// workers during a local rebuild; deleting dist/ in-place can remove
// dist/agents/WorkerProcessEntry.js under the live process.
if (!WEB_ONLY && CLEAN) {
  const distPath = join(pkgRoot, 'dist');
  if (existsSync(distPath)) {
    console.log('\n> rm -rf dist  (cross-platform)');
    rmSync(distPath, { recursive: true, force: true });
  }
} else if (!WEB_ONLY) {
  console.log('\n> preserve dist/ during build (use --clean for a clean rebuild)');
}

// ── 3. Compile TypeScript ─────────────────────────────────────────────────────
if (!WEB_ONLY) {
  // npx tsc works on all platforms; shell:true handles npx.cmd on Windows.
  // Regular builds keep test outputs for npm test; package builds exclude tests/maps.
  const tsconfig = PACKAGE_BUILD ? 'tsconfig.package.json' : 'tsconfig.cli.json';
  run(`npx tsc -p ${tsconfig}`, { cwd: pkgRoot });

  const snapshotSrc = join(pkgRoot, 'src', 'llm', 'models-snapshot.json');
  const snapshotDestDir = join(pkgRoot, 'dist', 'llm');
  const snapshotDest = join(snapshotDestDir, 'models-snapshot.json');
  if (existsSync(snapshotSrc)) {
    mkdirSync(snapshotDestDir, { recursive: true });
    copyFileSync(snapshotSrc, snapshotDest);
  }
  pruneDevOnlyDistFiles();
  pruneUnmappedDistSidecars();
}

// ── 4. Build web (Vite) ───────────────────────────────────────────────────────
if (!SERVER_ONLY) {
  // Auto-install web dependencies if web/node_modules is missing.
  // This ensures `npm install && npm run build` works out-of-the-box
  // without requiring a separate `cd web && npm install` step.
  const webNodeModules = join(pkgRoot, 'web', 'node_modules');
  if (!existsSync(webNodeModules)) {
    console.log('\n> web/node_modules not found — running npm install for web subpackage...');
    const npmCmd = IS_WINDOWS ? 'npm.cmd' : 'npm';
    run(`${npmCmd} install`, { cwd: join(pkgRoot, 'web') });
  }

  run(`${viteCmd()} build`, { cwd: join(pkgRoot, 'web') });
}

// ── 5. chmod +x dist/cli.js (Unix only, non-fatal) ───────────────────────────
if (!IS_WINDOWS && !WEB_ONLY) {
  const cliJs = join(pkgRoot, 'dist', 'cli.js');
  if (existsSync(cliJs)) {
    try {
      chmodSync(cliJs, 0o755);
    } catch {
      // Non-fatal: filesystem may not support chmod (FAT, some Docker setups)
    }
  }
}

// ── 6. Generate settings schema ───────────────────────────────────────────────
if (!WEB_ONLY) {
  run(`node scripts/generate-settings.mjs`, { cwd: pkgRoot });
}

console.log('\n✓ Build complete.');
