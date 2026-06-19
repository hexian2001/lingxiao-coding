/**
 * WikiFileScanner — 项目文件树扫描
 *
 * 扫描项目目录，产出结构化信息用于 LLM 生成 Wiki 文档。
 * 尊重 .gitignore，排除二进制文件和常见无关目录。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  WIKI_EXCLUDE_DIRS,
  WIKI_EXCLUDE_EXTENSIONS,
  MAX_PROJECT_FILES,
  MAX_FILE_SIZE,
  type ProjectScanResult,
} from './types.js';

// 常见入口文件/配置文件名
const ENTRY_FILE_NAMES = new Set([
  'package.json', 'tsconfig.json', 'Cargo.toml', 'go.mod', 'pyproject.toml',
  'setup.py', 'requirements.txt', 'Gemfile', 'pom.xml', 'build.gradle',
  'Makefile', 'CMakeLists.txt', 'Dockerfile', 'docker-compose.yml',
  'README.md', 'README.zh-CN.md', 'README.cn.md', 'CHANGELOG.md',
  '.env.example', '.env.template',
]);

export class WikiFileScanner {
  /**
   * 扫描项目，返回结构化结果
   */
  async scan(projectPath: string): Promise<ProjectScanResult> {
    const sourceFiles: string[] = [];
    const keyFiles: string[] = [];
    const languages: Record<string, number> = {};
    const dirLines: string[] = [];

    const totalFiles = this.walkDir(
      projectPath,
      projectPath,
      sourceFiles,
      keyFiles,
      languages,
      dirLines,
      0,
    );

    if (totalFiles > MAX_PROJECT_FILES) {
      throw new Error(
        `项目文件数 ${totalFiles} 超过上限 ${MAX_PROJECT_FILES}，` +
        '请在 .lingxiao/wiki-exclude 中排除非必要路径。'
      );
    }

    return {
      rootPath: projectPath,
      totalFiles,
      languages,
      directoryTree: dirLines.join('\n'),
      keyFiles,
      sourceFiles,
    };
  }

  /**
   * 递归遍历目录
   * @returns 扫描到的文件总数
   */
  private walkDir(
    rootPath: string,
    currentDir: string,
    sourceFiles: string[],
    keyFiles: string[],
    languages: Record<string, number>,
    dirLines: string[],
    depth: number,
  ): number {
    let count = 0;
    if (depth > 15) return 0; // 最大深度

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {/* expected: fallback to default */
      return 0;
    }

    // 排序：目录在前，按名称排序
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    const indent = '  '.repeat(depth);
    const dirName = path.relative(rootPath, currentDir) || '.';

    for (const entry of sorted) {
      // 跳过排除的目录
      if (entry.isDirectory() && WIKI_EXCLUDE_DIRS.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootPath, fullPath);

      if (entry.isDirectory()) {
        const subDirLines: string[] = [];
        const subCount = this.walkDir(
          rootPath,
          fullPath,
          sourceFiles,
          keyFiles,
          languages,
          subDirLines,
          depth + 1,
        );
        count += subCount;
        if (subCount > 0) {
          dirLines.push(`${indent}${entry.name}/`);
          dirLines.push(...subDirLines);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();

        // 跳过排除的扩展名
        if (WIKI_EXCLUDE_EXTENSIONS.has(ext)) continue;

        // 跳过隐藏文件（除 .env.example 等）
        if (entry.name.startsWith('.') && !ENTRY_FILE_NAMES.has(entry.name)) continue;

        // 检查文件大小
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > MAX_FILE_SIZE) continue;
        } catch {/* expected: skip invalid entry */
          continue;
        }

        count++;
        sourceFiles.push(relativePath);

        // 统计语言分布
        if (ext) {
          languages[ext] = (languages[ext] || 0) + 1;
        }

        // 检测入口文件
        if (ENTRY_FILE_NAMES.has(entry.name)) {
          keyFiles.push(relativePath);
        }

        // 只在浅层显示文件（深层只显示目录）
        if (depth < 3) {
          dirLines.push(`${indent}${entry.name}`);
        }
      }
    }

    return count;
  }

  /**
   * 读取文件内容，带大小限制
   */
  readFileContent(filePath: string): string | null {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_FILE_SIZE) return null;
      return fs.readFileSync(filePath, 'utf-8');
    } catch {/* expected: operation may fail gracefully */
      return null;
    }
  }

  /**
   * 批量读取入口文件内容
   */
  readKeyFiles(projectPath: string, keyFiles: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const relPath of keyFiles) {
      const content = this.readFileContent(path.join(projectPath, relPath));
      if (content) {
        result[relPath] = content;
      }
    }
    return result;
  }

  /**
   * 检查是否为 git 仓库
   */
  isGitRepo(projectPath: string): boolean {
    return fs.existsSync(path.join(projectPath, '.git'));
  }
}
