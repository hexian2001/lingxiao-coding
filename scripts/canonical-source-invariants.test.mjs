#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(scriptsDir, '..');
const require = createRequire(import.meta.url);
const forbiddenSourceEntrypoints = [
  ['src', 'next'].join('-'),
  ['NEXT', 'GEN', 'ENABLED'].join('_'),
  ['dist', 'pub'].join('-'),
];

function walkFiles(root, relativeRoot = '') {
  const files = [];
  for (const entry of readdirSync(join(root, relativeRoot), { withFileTypes: true })) {
    const relativePath = relativeRoot ? join(relativeRoot, entry.name) : entry.name;
    const fullPath = join(root, relativePath);
    if (entry.isDirectory()) {
      files.push(...walkFiles(root, relativePath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function readText(filePath) {
  return readFileSync(filePath, 'utf8');
}

test('package scripts and build scripts do not reference retired source entrypoints', () => {
  const files = [
    join(pkgRoot, 'package.json'),
    ...walkFiles(join(pkgRoot, 'scripts')).filter((filePath) => /\.(?:mjs|js|json)$/.test(filePath)),
  ];

  const hits = [];
  for (const filePath of files) {
    const text = readText(filePath);
    for (const marker of forbiddenSourceEntrypoints) {
      if (text.includes(marker)) {
        hits.push(`${relative(pkgRoot, filePath).replace(/\\/g, '/')}: ${marker}`);
      }
    }
  }

  assert.deepEqual(hits, []);
});

test('postinstall resolves bundled skill registry from the canonical dist output only', () => {
  const postinstallPath = join(pkgRoot, 'scripts', 'postinstall.mjs');
  const text = readText(postinstallPath);

  assert.match(text, /resolve\(pkgRoot, 'dist\/core\/BundledSkillRegistry\.js'\)/);
  assert.equal(text.includes(['dist', 'pub'].join('-')), false);
});

test('build and dist test runners require generated files to map back to src', () => {
  for (const scriptName of ['build.mjs', 'run-tests.mjs']) {
    const scriptPath = join(pkgRoot, 'scripts', scriptName);
    const text = readText(scriptPath);

    assert.match(text, /existsSync\([^)]*pkgRoot[^)]*'src'/s);
    assert.doesNotMatch(text, /isExcluded(?:Test)?Source/);
  }
});

test('i18n locale values interpolate with double braces {{var}}, not single braces {var}', () => {
  // i18next v24 only substitutes {{var}}; a lone {var} renders literally.
  // This previously made the chat search counter show raw "{current}/{total} 个结果"
  // and silently broke ~16 other count/percent strings. Guard the whole class.
  // Negative lookbehind/ahead keep {{var}} (correct) from matching.
  const SINGLE_BRACE_VAR = /(?<!\{)\{[a-zA-Z_][a-zA-Z0-9_]*\}(?!\})/;

  const collectStrings = (obj, prefix, out) => {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'string') out.push([path, value]);
      else if (value && typeof value === 'object') collectStrings(value, path, out);
    }
    return out;
  };

  const localeDir = join(pkgRoot, 'web', 'src', 'i18n', 'locales');
  const offenders = [];
  for (const name of ['zh.json', 'en.json']) {
    const data = JSON.parse(readText(join(localeDir, name)));
    for (const [key, value] of collectStrings(data, '', [])) {
      if (SINGLE_BRACE_VAR.test(value)) offenders.push(`${name} ${key}: ${JSON.stringify(value)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Single-brace interpolation found (i18next requires {{var}}):\n${offenders.join('\n')}`,
  );
});

test('web i18n locale files (zh.json / en.json) have identical top-level key sets', () => {
  // 单一事实源守护：两套 locale 必须一一对应，杜绝只加了一种语言的 key。
  const localeDir = join(pkgRoot, 'web', 'src', 'i18n', 'locales');
  const zh = JSON.parse(readText(join(localeDir, 'zh.json')));
  const en = JSON.parse(readText(join(localeDir, 'en.json')));
  const zhKeys = new Set(Object.keys(zh));
  const enKeys = new Set(Object.keys(en));
  const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k));
  const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k));
  assert.deepEqual(onlyZh, [], `keys present only in zh.json: ${onlyZh.slice(0, 30).join(', ')}`);
  assert.deepEqual(onlyEn, [], `keys present only in en.json: ${onlyEn.slice(0, 30).join(', ')}`);
});

test('electron afterPack pruning removes only Windows-unneeded unpacked artifacts', () => {
  const { pruneUnpackedNodeModules } = require('./prune-electron-unpacked.cjs');
  const dir = join(tmpdir(), `lx-prune-electron-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const nodeModulesDir = join(dir, 'resources', 'app.asar.unpacked', 'node_modules');

  const write = (relativePath, content = 'x') => {
    const target = join(nodeModulesDir, ...relativePath.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };

  try {
    write('@ast-grep/lang-typescript/src/parser.c');
    write('@ast-grep/lang-typescript/src/parser.h');
    write('@ast-grep/lang-typescript/prebuild-linux-x64/tree-sitter-typescript.node');
    write('@ast-grep/lang-typescript/prebuild-darwin-arm64/tree-sitter-typescript.node');
    write('@ast-grep/lang-typescript/prebuild-win32-x64/tree-sitter-typescript.node');
    write('tree-sitter-grammar/prebuilds/linux-x64/parser.node');
    write('tree-sitter-grammar/prebuilds/darwin-arm64/parser.node');
    write('tree-sitter-grammar/prebuilds/win32-x64/parser.node');
    write('native-addon/build/Release/addon.node');
    write('native-addon/bin/helper.exe');
    write('native-addon/bin/runtime.dll');
    write('native-addon/package.json', '{"name":"native-addon"}');
    write('native-addon/README.md');
    write('native-addon/index.js.map');
    write('native-addon/include/addon.h');
    write('native-addon/src/addon.c');

    const result = pruneUnpackedNodeModules(nodeModulesDir);
    assert.ok(result.removed.length >= 6);

    assert.equal(existsSync(join(nodeModulesDir, '@ast-grep/lang-typescript/src/parser.c')), false);
    assert.equal(existsSync(join(nodeModulesDir, '@ast-grep/lang-typescript/prebuild-linux-x64/tree-sitter-typescript.node')), false);
    assert.equal(existsSync(join(nodeModulesDir, '@ast-grep/lang-typescript/prebuild-darwin-arm64/tree-sitter-typescript.node')), false);
    assert.equal(existsSync(join(nodeModulesDir, 'tree-sitter-grammar/prebuilds/linux-x64/parser.node')), false);
    assert.equal(existsSync(join(nodeModulesDir, 'tree-sitter-grammar/prebuilds/darwin-arm64/parser.node')), false);
    assert.equal(existsSync(join(nodeModulesDir, 'native-addon/README.md')), false);
    assert.equal(existsSync(join(nodeModulesDir, 'native-addon/index.js.map')), false);
    assert.equal(existsSync(join(nodeModulesDir, 'native-addon/include/addon.h')), false);
    assert.equal(existsSync(join(nodeModulesDir, 'native-addon/src/addon.c')), false);

    assert.equal(existsSync(join(nodeModulesDir, '@ast-grep/lang-typescript/prebuild-win32-x64/tree-sitter-typescript.node')), true);
    assert.equal(existsSync(join(nodeModulesDir, 'tree-sitter-grammar/prebuilds')), true);
    assert.equal(existsSync(join(nodeModulesDir, 'tree-sitter-grammar/prebuilds/win32-x64/parser.node')), true);
    assert.equal(existsSync(join(nodeModulesDir, 'native-addon/build/Release/addon.node')), true);
    assert.equal(existsSync(join(nodeModulesDir, 'native-addon/bin/helper.exe')), true);
    assert.equal(existsSync(join(nodeModulesDir, 'native-addon/bin/runtime.dll')), true);
    assert.equal(existsSync(join(nodeModulesDir, 'native-addon/package.json')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('worker tool surface stays aligned with ToolRegistry registration', () => {
  // WORKER_TOOLS must include every always-on registered tool that workers need.
  // Mode-gated tools (workflow, bughunt_full_scan, office via mode) and experimental lsp
  // are allowed to be registered without living in WORKER_TOOLS.
  const indexText = readText(join(pkgRoot, 'src/tools/index.ts'));
  const roleText = readText(join(pkgRoot, 'src/contracts/constants/rolePresets.ts'));

  const registered = new Set();
  for (const m of indexText.matchAll(/name:\s*['"`]([a-z][a-z0-9_]+)['"`]/g)) {
    registered.add(m[1]);
  }

  // Expand WORKER_TOOLS groups by parsing the mergeTools call region roughly via known literals.
  const workerRegion = roleText.match(/export const WORKER_TOOLS[\s\S]*?;\n/);
  assert.ok(workerRegion, 'WORKER_TOOLS export not found');
  const worker = new Set([...workerRegion[0].matchAll(/['"`]([a-z][a-z0-9_]+)['"`]/g)].map((m) => m[1]));
  // BASIC_TOOLS / nested constants also define tool names above WORKER_TOOLS
  for (const m of roleText.matchAll(/['"`]([a-z][a-z0-9_]+)['"`]/g)) {
    // only collect from tool-list arrays near known constants
  }
  // Re-parse with explicit group constants used by WORKER_TOOLS
  const extractArray = (name) => {
    const re = new RegExp(`(?:const|export const) ${name}[\\s\\S]*?=\\s*\\[([\\s\\S]*?)\\];`);
    const m = roleText.match(re);
    if (!m) return [];
    return [...m[1].matchAll(/['"`]([a-z][a-z0-9_]+)['"`]/g)].map((x) => x[1]);
  };
  for (const name of ['BASIC_TOOLS', 'COMM_TOOLS', 'MEMORY_TOOLS', 'TEAM_COMM_TOOLS', 'OFFICE_TOOL_NAMES']) {
    for (const n of extractArray(name)) worker.add(n);
  }
  // OFFICE comes from import; hardcode known office names from toolNames
  const toolNames = readText(join(pkgRoot, 'src/contracts/constants/toolNames.ts'));
  const office = toolNames.match(/export const OFFICE_TOOL_NAMES = \[([\s\S]*?)\]/);
  if (office) {
    for (const m of office[1].matchAll(/['"`]([a-z][a-z0-9_]+)['"`]/g)) worker.add(m[1]);
  }
  for (const m of workerRegion[0].matchAll(/['"`]([a-z][a-z0-9_]+)['"`]/g)) worker.add(m[1]);

  const modeGated = new Set(['workflow', 'bughunt_full_scan', 'lsp']);
  const registeredNotWorker = [...registered].filter((n) => !worker.has(n) && !modeGated.has(n)).sort();
  assert.deepEqual(
    registeredNotWorker,
    [],
    `Registered tools missing from WORKER_TOOLS (and not mode/env gated): ${registeredNotWorker.join(', ')}`,
  );

  // shell nextToolHints target must be worker-visible
  const meta = readText(join(pkgRoot, 'src/contracts/types/ToolMetadata.ts'));
  assert.match(meta, /nextToolHints:\s*\[['"]get_terminal_output['"]\]/);
  assert.equal(worker.has('get_terminal_output'), true, 'get_terminal_output must be in WORKER_TOOLS');
  assert.equal(worker.has('git'), true);
  assert.equal(worker.has('ast_query'), true);
  assert.equal(worker.has('terminal_control'), true);
});

test('tools/ToolMetadata re-exports contracts SSOT (no dual map)', () => {
  const toolsMeta = readText(join(pkgRoot, 'src/tools/ToolMetadata.ts'));
  assert.match(toolsMeta, /export \* from ['"]\.\.\/contracts\/types\/ToolMetadata\.js['"]/);
  assert.equal(toolsMeta.includes('export const TOOL_METADATA'), false);
});

test('orphan Tool class files that are not registered stay out of implementations root (deleted facades only)', () => {
  // SessionInfo / Edit* / Inspect* / GenerateCanvas/Slidev/Html* were unregistered dead agent tools.
  const ban = [
    'SessionInfoTool.ts',
    'EditDocxTool.ts',
    'EditPptxTool.ts',
    'EditXlsxTool.ts',
    'InspectDocxTool.ts',
    'InspectPptxTool.ts',
    'GenerateCanvasTool.ts',
    'GenerateSlidevTool.ts',
    'GenerateHtmlDocumentTool.ts',
    'GenerateHtmlPresentationTool.ts',
  ];
  const root = join(pkgRoot, 'src/tools/implementations');
  const present = ban.filter((name) => existsSync(join(root, name)));
  assert.deepEqual(present, [], `unexpected orphan tool files still present: ${present.join(', ')}`);
});


test('leader meta tools required by prompts are registered in LEADER_META_TOOLS schema', () => {
  const defs = readText(join(pkgRoot, 'src/contracts/constants/leaderToolDefinitions.ts'));
  const names = new Set([...defs.matchAll(/name:\s*['"`]([a-z][a-z0-9_]+)['"`]/g)].map((m) => m[1]));
  // 实现与 prompt 共同声明的关键工具必须出现在 schema 中
  const required = [
    'define_project_blueprint',
    'add_subsystem',
    'update_subsystem',
    'delete_subsystem',
    'canvas_save_sourcemap',
    'canvas_push_version',
    'canvas_get_state',
  ];
  const missing = required.filter((n) => !names.has(n));
  assert.deepEqual(missing, [], `LEADER_META_TOOLS missing: ${missing.join(', ')}`);
});

test('leader system prompt subsystem tools are subset of LEADER_META schema', () => {
  const prompt = readText(join(pkgRoot, 'src/agents/prompts/i18n/leader_system_prompt.ts'));
  const defs = readText(join(pkgRoot, 'src/contracts/constants/leaderToolDefinitions.ts'));
  const schemaNames = new Set([...defs.matchAll(/name:\s*['"`]([a-z][a-z0-9_]+)['"`]/g)].map((m) => m[1]));
  const claimed = [...prompt.matchAll(/\b(add_subsystem|update_subsystem|delete_subsystem|define_project_blueprint)\b/g)].map((m) => m[1]);
  const unique = [...new Set(claimed)];
  const missing = unique.filter((n) => !schemaNames.has(n));
  assert.deepEqual(missing, [], `prompt claims tools missing from schema: ${missing.join(', ')}`);
});

test('orphan office/html and tools/slidev directories stay deleted', () => {
  assert.equal(existsSync(join(pkgRoot, 'src/tools/implementations/office/html')), false);
  assert.equal(existsSync(join(pkgRoot, 'src/tools/slidev')), false);
  assert.equal(existsSync(join(pkgRoot, 'src/tools/implementations/fonts')), false);
  assert.equal(existsSync(join(pkgRoot, 'src/tools/implementations/office/OoxmlTextReplace.ts')), false);
});

