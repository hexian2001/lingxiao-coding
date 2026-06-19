import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mdSrc = readFileSync(path.join(root, 'README.md'), 'utf8');
const mermaidJs = readFileSync(path.join(root, 'node_modules/mermaid/dist/mermaid.min.js'), 'utf8');
const hljsCss = readFileSync(path.join(root, 'node_modules/highlight.js/styles/github.css'), 'utf8');

const md = new MarkdownIt({
  html: true,
  linkify: true,
  highlight(code, lang) {
    if (lang === 'mermaid') {
      return `<pre class="mermaid">${md.utils.escapeHtml(code)}</pre>`;
    }
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(code, { language: lang }).value}</code></pre>`;
      } catch {}
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(code)}</code></pre>`;
  },
});

const body = md.render(mdSrc);

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
${hljsCss}
* { box-sizing: border-box; }
body {
  font-family: -apple-system, "Segoe UI", "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
  color: #1f2328;
  line-height: 1.65;
  max-width: 880px;
  margin: 0 auto;
  padding: 32px 40px 64px;
  font-size: 14.5px;
}
h1, h2, h3, h4 { line-height: 1.3; margin-top: 1.6em; margin-bottom: 0.6em; font-weight: 650; }
h1 { font-size: 2em; border-bottom: 2px solid #d0d7de; padding-bottom: 0.3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid #d8dee4; padding-bottom: 0.3em; }
h3 { font-size: 1.22em; }
h4 { font-size: 1.05em; color: #3a4150; }
a { color: #0969da; text-decoration: none; }
p { margin: 0.7em 0; }
img { max-width: 100%; border-radius: 8px; border: 1px solid #e1e4e8; margin: 12px 0; display: block; }
img[src$="logo.svg"] { border: none; width: 96px; margin: 0 auto; }
code { background: #eff1f3; padding: 0.15em 0.4em; border-radius: 5px; font-size: 0.88em; font-family: "SF Mono", "Cascadia Code", Consolas, monospace; }
pre { background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 8px; padding: 14px 16px; overflow-x: auto; font-size: 0.85em; line-height: 1.5; }
pre code { background: none; padding: 0; font-size: 1em; }
pre.mermaid { background: #fff; border: none; text-align: center; }
table { border-collapse: collapse; width: 100%; margin: 14px 0; font-size: 0.92em; }
th, td { border: 1px solid #d0d7de; padding: 7px 12px; text-align: left; }
th { background: #f6f8fa; font-weight: 600; }
blockquote { margin: 1em 0; padding: 0.4em 1em; color: #57606a; border-left: 4px solid #d0d7de; background: #f6f8fa; border-radius: 0 6px 6px 0; }
hr { border: none; border-top: 1px solid #d8dee4; margin: 2em 0; }
ul, ol { padding-left: 1.6em; }
li { margin: 0.25em 0; }
p[align="center"], div[align="center"] { text-align: center; }
@media print { body { padding: 0 16px; } a { color: #0969da; } pre, img, table { break-inside: avoid; } }
</style>
</head>
<body>
${body}
<script>${mermaidJs}</script>
<script>
  mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose' });
  window.__mermaidDone = mermaid.run({ querySelector: 'pre.mermaid' }).then(() => true).catch(e => { console.error(e); return true; });
</script>
</body>
</html>`;

const htmlPath = path.join(root, 'README.html');
writeFileSync(htmlPath, html, 'utf8');
console.log('wrote', htmlPath);

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium-browser' });
const page = await browser.newPage();
await page.goto('file://' + htmlPath, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__mermaidDone !== undefined', { timeout: 15000 });
await page.evaluate('window.__mermaidDone');
// settle fonts/diagrams
await page.waitForTimeout(600);

const pdfPath = path.join(root, 'README.pdf');
await page.pdf({
  path: pdfPath,
  format: 'A4',
  printBackground: true,
  margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
});
await browser.close();
console.log('wrote', pdfPath, existsSync(pdfPath) ? '(ok)' : '(missing)');
