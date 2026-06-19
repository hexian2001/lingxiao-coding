#!/usr/bin/env node
/**
 * fetch-models-snapshot.mjs
 *
 * 构建时脚本：从 models.dev 拉取最新模型数据，
 * 写入 src/llm/models-snapshot.json 作为离线兜底 snapshot。
 *
 * 用法：
 *   node scripts/fetch-models-snapshot.mjs
 *
 * 失败策略：
 *   - 网络不通时：保留上一次的 snapshot 文件（不覆盖）
 *   - 首次构建且无网络：生成一个空 snapshot（运行时会后台拉取）
 */

import { writeFileSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = join(__dirname, '..', 'package.json');
const OUTPUT_PATH = join(__dirname, '..', 'src', 'llm', 'models-snapshot.json');
const MODELS_DEV_URL = 'https://models.dev/api.json';
const TIMEOUT_MS = 15_000;
const rootPkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
const USER_AGENT = `lingxiao-cli/${rootPkg.version || '0.0.0'} (models snapshot build)`;

async function main() {
  console.log('[snapshot] Fetching models.dev...');

  let data;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(MODELS_DEV_URL, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const text = await res.text();
    // 验证 JSON 合法
    data = JSON.parse(text);
    console.log(`[snapshot] OK — ${Object.keys(data).length} providers`);

    writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`[snapshot] Written to ${OUTPUT_PATH}`);
  } catch (err) {
    console.warn(`[snapshot] Fetch failed: ${err.message}`);

    if (existsSync(OUTPUT_PATH)) {
      console.log('[snapshot] Keeping existing snapshot.');
    } else {
      // 首次构建无网络：写入空 snapshot，运行时会后台拉取
      console.log('[snapshot] Writing empty snapshot as fallback.');
      writeFileSync(OUTPUT_PATH, '{}', 'utf-8');
    }
  }
}

main().catch(e => {
  console.error('[snapshot] Fatal:', e);
  process.exit(1);
});
