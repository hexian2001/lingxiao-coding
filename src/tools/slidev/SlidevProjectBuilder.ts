import { existsSync, lstatSync, mkdirSync, symlinkSync } from 'fs';
import { readdir, readFile, stat } from 'fs/promises';
import { basename, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getSessionScopePaths, lockedAtomicWriteBuffer, resolveTaskWritePath } from '../implementations/utils.js';
import { slugFileName, zipToBuffer } from '../implementations/OfficeXmlBuilder.js';

export interface SlidevProjectBuildInput {
  workspace?: string;
  sessionId?: string;
  taskWriteScope?: string[];
  outputDir?: string;
  title?: string;
  markdown: string;
  theme: string;
  styleCss?: string;
}

export interface SlidevProjectBuildResult {
  projectDir: string;
  slidesPath: string;
  packageJsonPath: string;
  stylePath?: string;
  zipPath: string;
  files: string[];
  slug: string;
  warnings: string[];
}

const BUILTIN_THEMES = new Set(['default', 'seriph', 'apple-basic']);
const THEME_PACKAGES: Record<string, string> = {
  default: '@slidev/theme-default',
  seriph: '@slidev/theme-seriph',
  'apple-basic': '@slidev/theme-apple-basic',
};

function ensureFrontmatter(markdown: string, title: string, theme: string): { markdown: string; warnings: string[] } {
  const warnings: string[] = [];
  const trimmed = markdown.trimStart();
  if (trimmed.startsWith('---')) {
    const end = trimmed.indexOf('\n---', 3);
    if (end === -1) {
      warnings.push('检测到 frontmatter 起始标记但未闭合，请检查 slides.md。');
    }
    return { markdown, warnings };
  }

  warnings.push('未检测到 Slidev frontmatter，已自动补充 title/theme/transition。');
  return {
    markdown: `---\ntitle: ${JSON.stringify(title)}\ntheme: ${theme}\ntransition: slide-left\n---\n\n${markdown}`,
    warnings,
  };
}

function defaultOutputDir(input: SlidevProjectBuildInput, slug: string): string {
  const scope = getSessionScopePaths(input.workspace, input.sessionId);
  const base = scope.scratchpadDir || resolve(input.workspace || process.cwd(), '.lingxiao', 'slidev');
  return join(base, slug);
}

function packageJson(title: string, theme: string): string {
  const deps: Record<string, string> = {
    '@slidev/cli': '^52.0.0',
  };
  if (theme === 'default') deps['@slidev/theme-default'] = '^0.25.0';
  if (theme === 'seriph') deps['@slidev/theme-seriph'] = '^0.25.0';
  if (theme === 'apple-basic') deps['@slidev/theme-apple-basic'] = '^0.25.0';

  return JSON.stringify({
    name: slugFileName(title, 'lingxiao-slidev-deck').toLowerCase(),
    private: true,
    type: 'module',
    scripts: {
      dev: 'slidev --host 127.0.0.1 slides.md',
      build: 'slidev build slides.md',
      'export:pdf': 'slidev export slides.md --format pdf',
      'export:pptx': 'slidev export slides.md --format pptx',
      'export:png': 'slidev export slides.md --format png',
    },
    devDependencies: deps,
  }, null, 2) + '\n';
}

async function linkRuntimeDependencies(projectDir: string, theme: string): Promise<void> {
  const packageNames = ['@slidev/cli', THEME_PACKAGES[theme]].filter((value): value is string => Boolean(value));
  for (const packageName of packageNames) {
    const packagePath = fileURLToPath(new URL(`../../../node_modules/${packageName}/`, import.meta.url));
    if (!existsSync(join(packagePath, 'package.json'))) continue;
    const target = join(projectDir, 'node_modules', ...packageName.split('/'));
    if (existsSync(target)) continue;
    mkdirSync(join(target, '..'), { recursive: true });
    try {
      symlinkSync(packagePath, target, 'dir');
    } catch {/* swallowed: unhandled error */
      if (!existsSync(target) || !lstatSync(target).isSymbolicLink()) throw new Error(`无法链接 Slidev 运行时依赖: ${packageName}`);
    }
  }
}

async function collectFiles(dir: string, root = dir): Promise<Record<string, Buffer>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: Record<string, Buffer> = {};
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      Object.assign(files, await collectFiles(fullPath, root));
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = relative(root, fullPath).replace(/\\/g, '/');
    files[rel] = await readFile(fullPath);
  }
  return files;
}

export async function buildSlidevProject(input: SlidevProjectBuildInput): Promise<SlidevProjectBuildResult> {
  const title = input.title?.trim() || 'Lingxiao Slidev Deck';
  const slug = slugFileName(title, `slidev-${Date.now()}`).toLowerCase();
  const warnings: string[] = [];

  if (!BUILTIN_THEMES.has(input.theme)) {
    warnings.push(`主题 ${input.theme} 未内置，已生成项目但预览/导出可能失败；建议使用 default、seriph 或 apple-basic。`);
  }

  const projectDir = input.outputDir
    ? resolveTaskWritePath(input.workspace, input.outputDir, input.sessionId, input.taskWriteScope)
    : defaultOutputDir(input, slug);

  const { markdown, warnings: frontmatterWarnings } = ensureFrontmatter(input.markdown, title, input.theme);
  warnings.push(...frontmatterWarnings);

  const slides = markdown.includes('\n---') ? markdown : `${markdown.trimEnd()}\n\n---\n\n# Appendix\n`;
  if (slides !== markdown) warnings.push('仅检测到单页内容，已补充一页 Appendix 以保证 Slidev 分页结构。');

  const slidesPath = join(projectDir, 'slides.md');
  const packageJsonPath = join(projectDir, 'package.json');
  const stylePath = input.styleCss?.trim() ? join(projectDir, 'style.css') : undefined;

  await lockedAtomicWriteBuffer(slidesPath, Buffer.from(slides, 'utf-8'), { createDirs: true });
  await lockedAtomicWriteBuffer(packageJsonPath, Buffer.from(packageJson(title, input.theme), 'utf-8'), { createDirs: true });
  if (stylePath) {
    await lockedAtomicWriteBuffer(stylePath, Buffer.from(input.styleCss!, 'utf-8'), { createDirs: true });
  }
  await linkRuntimeDependencies(projectDir, input.theme);

  const zipPath = join(projectDir, `${basename(projectDir)}.zip`);
  const zipFiles = await collectFiles(projectDir);
  delete zipFiles[basename(zipPath)];
  const zipBuffer = await zipToBuffer(zipFiles);
  await lockedAtomicWriteBuffer(zipPath, zipBuffer, { createDirs: true });

  const fileNames = Object.keys(await collectFiles(projectDir)).sort();
  if (!existsSync(slidesPath) || !(await stat(slidesPath)).isFile()) {
    throw new Error(`Slidev slides.md 写入失败: ${slidesPath}`);
  }

  return {
    projectDir,
    slidesPath,
    packageJsonPath,
    stylePath,
    zipPath,
    files: fileNames,
    slug,
    warnings,
  };
}
