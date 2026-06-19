import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { readFileSync } from 'fs';

// 单一来源：从 root package.json 读取版本号，构建期注入到前端
const rootPkg = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8')) as { version: string };
const apiProxyTarget =
  process.env.LINGXIAO_WEB_PROXY_TARGET ||
  process.env.VITE_LINGXIAO_API_TARGET ||
  'http://127.0.0.1:8080';
const devHost = process.env.LINGXIAO_WEB_DEV_HOST || '127.0.0.1';
const hmrHost = process.env.LINGXIAO_WEB_HMR_HOST || (devHost === '0.0.0.0' ? '127.0.0.1' : devHost);
const hmrClientPort = process.env.LINGXIAO_WEB_HMR_CLIENT_PORT
  ? Number(process.env.LINGXIAO_WEB_HMR_CLIENT_PORT)
  : undefined;
const buildSourcemap = process.env.LINGXIAO_WEB_SOURCEMAP === '1'
  || process.env.VITE_LINGXIAO_SOURCEMAP === '1'
  || process.env.VITE_SOURCEMAP === 'true';
const buildMinify = process.env.LINGXIAO_WEB_MINIFY === 'false' ? false : 'esbuild';

// 自定义插件：修复 lodash 中的 require 调用
function fixLodashRequire(): Plugin {
  return {
    name: 'fix-lodash-require',
    enforce: 'post',
    generateBundle(_, bundle) {
      for (const fileName in bundle) {
        const chunk = bundle[fileName];
        if (chunk.type === 'chunk' && fileName.endsWith('.js')) {
          // 替换 lodash 中的 Io&&Io.require&&Io.require("util") 为安全的调用
          chunk.code = chunk.code.replace(
            /(\w+)&&\1\.require&&\1\.require\("util"\)\.types/g,
            '(typeof $1 !== "undefined" && $1 && $1.require && typeof $1.require === "function" ? $1.require("util").types : undefined)'
          );
          
          // 通用替换：所有 Io&&Io.require 模式
          chunk.code = chunk.code.replace(
            /(\w+)&&\1\.require&&\1\.require\(([^)]+)\)/g,
            '(typeof $1 !== "undefined" && $1 && $1.require && typeof $1.require === "function" ? $1.require($2) : undefined)'
          );
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), fixLodashRequire()],
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@contracts': path.resolve(__dirname, '../src/contracts'),
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: false,
    chunkSizeWarningLimit: 1000,
    minify: buildMinify,
    sourcemap: buildSourcemap,
  },
  server: {
    host: devHost,
    port: 5173,
    hmr: {
      protocol: 'ws',
      host: hmrHost,
      ...(hmrClientPort ? { clientPort: hmrClientPort } : {}),
    },
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
