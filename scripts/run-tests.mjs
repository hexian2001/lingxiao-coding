/**
 * Cross-platform test entrypoint.
 *
 * Shell glob expansion behaves differently across shells. In particular,
 * PowerShell passes quoted globs through literally, which can make Node's test
 * runner report zero tests while still exiting successfully. Resolve test files
 * in Node first, then pass concrete paths to `node --test`.
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { glob } from 'glob';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const extraArgs = process.argv.slice(2);
const GENERATED_TEST_SUFFIX = '.test.js';

const testFiles = (await glob('dist/**/*.test.js', {
  absolute: true,
  cwd: pkgRoot,
  nodir: true,
})).sort((a, b) => a.localeCompare(b));

function relativeDistPath(filePath) {
  return filePath.slice(resolve(pkgRoot, 'dist').length + 1).replace(/\\/g, '/');
}

function activeTestSourceCandidates(filePath) {
  const relativePath = relativeDistPath(filePath);
  const base = relativePath.slice(0, -GENERATED_TEST_SUFFIX.length);
  return [`${base}.test.ts`, `${base}.test.tsx`];
}

const unmappedTestFiles = testFiles.filter((filePath) => !activeTestSourceCandidates(filePath).some((relativeSourcePath) => (
  existsSync(resolve(pkgRoot, 'src', relativeSourcePath))
)));

if (unmappedTestFiles.length > 0) {
  console.error('Compiled test file(s) do not map to active src tests:');
  for (const filePath of unmappedTestFiles) {
    console.error(`  ${relativeDistPath(filePath)}`);
  }
  console.error('Run `npm run build:server` to refresh dist from src.');
  process.exit(1);
}

if (testFiles.length === 0) {
  console.error('No compiled test files found for pattern: dist/**/*.test.js');
  console.error('Run `npm run build` before running dist tests.');
  process.exit(1);
}

const result = spawnSync(process.execPath, [
  '--test',
  '--test-timeout=30000',
  // 进程隔离:每测试文件在独立子进程跑,根除「全部 test.js 单进程」跨文件全局状态污染
  // (失败集每次不同的随机 flaky——i18n locale / 单例 / 未清理 timer 跨文件串扰,
  // 见 test-runner-single-process-i18n-pollution)。代价:略慢(fork 开销),换确定性
  // (全绿稳定可复现)。如需单进程调试可传 --test-isolation=none 覆盖。
  '--test-isolation=process',
  ...extraArgs,
  ...testFiles,
], {
  cwd: pkgRoot,
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.signal) {
  console.error(`node --test terminated by signal ${result.signal}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
