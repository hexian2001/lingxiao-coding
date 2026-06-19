/**
 * postbuild 脚本：生成默认 settings.json
 * 仅当 ~/.lingxiao/settings.json 不存在时写入，不覆盖现有配置。
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  // 构建产物已在 dist/，动态加载
  const distConfig = join(__dirname, '../dist/config.js');
  const { generateDefaultSettings } = await import(distConfig);
  generateDefaultSettings();
} catch (e) {
  // 构建产物可能不存在或路径不同，静默跳过
  if (e?.code !== 'ERR_MODULE_NOT_FOUND') {
    console.warn('[generate-settings] 跳过自动生成配置:', e?.message || e);
  }
}
