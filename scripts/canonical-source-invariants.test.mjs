#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(scriptsDir, '..');
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
