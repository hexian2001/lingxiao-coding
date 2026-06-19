import { Dirent, existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { extname, isAbsolute, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import type { MessageContent } from './llm/types.js';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg']);
const BINARY_EXTS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'zip', 'tar', 'gz', 'rar', '7z', 'exe', 'dll', 'so',
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp',
  'mp3', 'mp4', 'wav', 'avi', 'mov', 'mkv', 'flv',
]);

const TRAILING_PATH_PUNCTUATION = /[.,;:!?]+$/;

export function buildDirectoryPreview(targetPath: string, depth = 2): string {
  const root = resolve(targetPath);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return `路径不是目录: ${targetPath}`;
  }

  const ignoreNames = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.idea', 'dist', 'build']);

  const walk = (currentPath: string, prefix: string, currentDepth: number): string[] => {
    if (currentDepth >= depth) {
      return [];
    }

    let entries: Dirent[];
    try {
      entries = readdirSync(currentPath, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith('.') && !ignoreNames.has(entry.name))
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });
    } catch {/* expected: fallback to default */
      return [`${prefix}[权限不足]`];
    }

    const lines: string[] = [];
    entries.forEach((entry, index) => {
      const isLast = index === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      lines.push(`${prefix}${connector}${entry.name}`);
      if (entry.isDirectory()) {
        const nextPrefix = `${prefix}${isLast ? '    ' : '│   '}`;
        lines.push(...walk(join(currentPath, entry.name), nextPrefix, currentDepth + 1));
      }
    });

    return lines;
  };

  return [root, ...walk(root, '', 0)].join('\n');
}

function getImageMediaType(ext: string): string {
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function stripTerminalDropDecoration(value: string): string {
  let candidate = value.trim();
  if (!candidate) return candidate;

  const bracketed = candidate.match(/^@\[\/*ssh-remote\+[^\]]*?((?:\/[^\]]+)|(?:[A-Za-z]:[\\/][^\]]+))\]$/);
  if (bracketed) {
    candidate = bracketed[1];
  }

  if (
    (candidate.startsWith('"') && candidate.endsWith('"'))
    || (candidate.startsWith("'") && candidate.endsWith("'"))
  ) {
    candidate = candidate.slice(1, -1);
  }

  candidate = candidate.replace(TRAILING_PATH_PUNCTUATION, '');
  candidate = candidate.replace(/\\([\\ "'()])/g, '$1');

  if (candidate.startsWith('file://')) {
    try {
      return fileURLToPath(candidate);
    } catch {/* expected: keep trying as plain text */
      try {
        return decodeURI(candidate.replace(/^file:\/\//, ''));
      } catch {/* expected: fallback below */
        return candidate.replace(/^file:\/\//, '');
      }
    }
  }

  try {
    return decodeURI(candidate);
  } catch {/* expected: terminal text may contain raw percent signs */
    return candidate;
  }
}

function expandHomePath(candidate: string): string {
  if (candidate === '~') return homedir();
  if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    return join(homedir(), candidate.slice(2));
  }
  return candidate;
}

function resolveDroppedPath(candidate: string, baseDir: string): string {
  const normalized = expandHomePath(stripTerminalDropDecoration(candidate));
  return isAbsolute(normalized) || /^[A-Za-z]:[\\/]/.test(normalized)
    ? normalized
    : resolve(baseDir, normalized);
}

function shellLikeTokens(text: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | null = null;

  const pushToken = () => {
    if (token.length > 0) {
      tokens.push(token);
      token = '';
    }
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === '\\') {
      const next = text[i + 1];
      if (quote !== "'" && next && /[\s\\ "'()]/.test(next)) {
        token += next;
        i++;
        continue;
      }
      token += char;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        token += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      pushToken();
      continue;
    }

    token += char;
  }

  pushToken();
  return tokens;
}

function quotedPathCandidates(text: string): string[] {
  const matches = text.matchAll(/(["'])(.+?)\1/g);
  return Array.from(matches, (match) => match[2]);
}

function remotePathCandidates(text: string): string[] {
  const matches = text.matchAll(/@\[\/*ssh-remote\+[^\]]*?((?:\/[^\]]+)|(?:[A-Za-z]:[\\/][^\]]+))\]/g);
  return Array.from(matches, (match) => match[1]);
}

function fileUriCandidates(text: string): string[] {
  const matches = text.matchAll(/file:\/\/(?:[^\s'"<>]|%[0-9A-Fa-f]{2})+/g);
  return Array.from(matches, (match) => match[0]);
}

function existingFilePathsFromText(text: string, baseDir: string): string[] {
  const rawCandidates = [
    ...remotePathCandidates(text),
    ...fileUriCandidates(text),
    ...quotedPathCandidates(text),
    ...shellLikeTokens(text),
  ];

  const filePaths: string[] = [];
  for (const rawCandidate of rawCandidates) {
    const filePath = resolveDroppedPath(rawCandidate, baseDir);
    try {
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        filePaths.push(filePath);
      }
    } catch {/* expected: ignore invalid or inaccessible paths */
    }
  }

  return unique(filePaths);
}

function fileExtension(filePath: string): string {
  return extname(filePath).replace(/^\./, '').toLowerCase();
}

function imageContentPart(filePath: string) {
  const ext = fileExtension(filePath);
  const base64 = readFileSync(filePath).toString('base64');
  return {
    type: 'image_url' as const,
    image_url: {
      url: `data:${getImageMediaType(ext)};base64,${base64}`,
      detail: 'auto' as const,
    },
  };
}

export function prepareMessage(text: string, baseDir: string): MessageContent {
  const filePaths = existingFilePathsFromText(text, baseDir);
  if (filePaths.length === 0) {
    return text;
  }

  const imagePaths = filePaths.filter((filePath) => IMAGE_EXTS.has(fileExtension(filePath)));
  if (imagePaths.length > 0) {
    return [
      { type: 'text', text },
      ...imagePaths.map(imageContentPart),
    ];
  }

  const filePath = filePaths[0];
  const ext = fileExtension(filePath);
  const fileSize = statSync(filePath).size;
  const sizeLabel = fileSize < 1024 * 1024
    ? `${(fileSize / 1024).toFixed(1)}KB`
    : `${(fileSize / 1024 / 1024).toFixed(1)}MB`;

  if (BINARY_EXTS.has(ext)) {
    return `--- 附带文件: ${filePath} (${sizeLabel}) ---\n\n${text}`;
  }

  try {
    const maxRead = 100 * 1024;
    const content = readFileSync(filePath, 'utf-8');
    const truncated = content.length > maxRead ? `${content.slice(0, maxRead)}\n... (文件过大，仅读取前 100KB)` : content;
    return `--- 附带文件内容: ${filePath} ---\n${truncated}\n\n${text}`;
  } catch {/* expected: fallback to default */
    return `--- 附带文件: ${filePath} (${sizeLabel}) ---\n\n${text}`;
  }
}
