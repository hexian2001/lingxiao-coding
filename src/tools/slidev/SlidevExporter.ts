import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import { basename, join } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { lockedAtomicWriteBuffer } from '../implementations/utils.js';
import { zipToBuffer } from '../implementations/OfficeXmlBuilder.js';
import { withToolProxyEnv } from '../../core/ProxyConfig.js';
import { hiddenSpawnOpts, killProcess } from '../../utils/platform.js';

export interface SlidevExportArtifact {
  format: 'pdf' | 'pptx' | 'png';
  path: string;
  mimeType: string;
  warning?: string;
}

const MIME_TYPES: Record<SlidevExportArtifact['format'], string> = {
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'application/zip',
};

async function zipPngDirectory(dir: string, outputPath: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: Record<string, Buffer> = {};
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.png')) continue;
    const fullPath = join(dir, entry.name);
    files[entry.name] = await import('fs/promises').then(fs => fs.readFile(fullPath));
  }
  if (Object.keys(files).length === 0) {
    throw new Error(`Slidev PNG 导出未生成图片: ${dir}`);
  }
  await lockedAtomicWriteBuffer(outputPath, await zipToBuffer(files), { createDirs: true });
}

async function runSlidevExport(input: {
  projectDir: string;
  slidesPath: string;
  format: 'pdf' | 'pptx' | 'png';
  outputPath: string;
  timeoutMs: number;
}): Promise<void> {
  const cliPath = fileURLToPath(new URL('../../../node_modules/@slidev/cli/bin/slidev.mjs', import.meta.url));
  const args = [cliPath, 'export', input.slidesPath, '--format', input.format, '--output', input.outputPath, '--timeout', String(input.timeoutMs)];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: input.projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: withToolProxyEnv({ ...process.env, CI: '1' }),
      ...hiddenSpawnOpts(),
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (child.pid) {
        void killProcess(child.pid, undefined, { tree: true, graceMs: 2_000 });
      } else {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }
      reject(new Error(`Slidev ${input.format.toUpperCase()} 导出超时 (${input.timeoutMs}ms)`));
    }, input.timeoutMs + 10_000);

    child.stdout?.on('data', data => { stdout += data.toString(); });
    child.stderr?.on('data', data => { stderr += data.toString(); });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Slidev ${input.format.toUpperCase()} 导出失败 (exit ${code}): ${stderr || stdout || '无输出'}`));
    });
  });
}

export async function exportSlidevDeck(input: {
  projectDir: string;
  slidesPath: string;
  formats: Array<'pdf' | 'pptx' | 'png'>;
  outputBaseName: string;
  timeoutMs: number;
}): Promise<SlidevExportArtifact[]> {
  if (input.formats.length === 0) return [];
  const exportsDir = join(input.projectDir, 'exports');
  const results: SlidevExportArtifact[] = [];

  for (const format of input.formats) {
    if (format === 'png') {
      const pngDir = join(exportsDir, 'png');
      await runSlidevExport({
        projectDir: input.projectDir,
        slidesPath: input.slidesPath,
        format,
        outputPath: pngDir,
        timeoutMs: input.timeoutMs,
      });
      const zipPath = join(exportsDir, `${input.outputBaseName}-png.zip`);
      await zipPngDirectory(pngDir, zipPath);
      results.push({ format, path: zipPath, mimeType: MIME_TYPES[format] });
      continue;
    }

    const outputPath = join(exportsDir, `${input.outputBaseName}.${format}`);
    await runSlidevExport({
      projectDir: input.projectDir,
      slidesPath: input.slidesPath,
      format,
      outputPath,
      timeoutMs: input.timeoutMs,
    });

    if (!existsSync(outputPath)) {
      throw new Error(`Slidev ${format.toUpperCase()} 导出未生成文件: ${outputPath}`);
    }

    results.push({
      format,
      path: outputPath,
      mimeType: MIME_TYPES[format],
      warning: format === 'pptx' ? 'Slidev 导出的 PPTX 为图片拼装模式，文字不可编辑。' : undefined,
    });
  }

  return results;
}

export function slidevExportName(path: string): string {
  return basename(path);
}
