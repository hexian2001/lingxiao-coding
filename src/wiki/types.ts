/**
 * Repo Wiki 类型定义与常量
 */

// ─── 语言 ──────────────────────────────────────────
export type WikiLanguage = 'zh' | 'en';

// ─── 常量 ──────────────────────────────────────────
export const WIKI_DIR_NAME = 'wiki';
export const WIKI_META_FILE = 'meta.json';
export const MAX_PROJECT_FILES = 10_000;
export const MAX_FILE_SIZE = 100 * 1024;       // 100KB per file
export const MAX_TOTAL_CHANGES = 10_000;        // lines
export const WIKI_GENERATION_CONCURRENCY = 3;
export const WIKI_GENERATION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
export const WIKI_INCREMENTAL_THRESHOLD = 0.5;  // >50% sections affected → full regen

// 排除的目录模式
export const WIKI_EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next',
  '.nuxt', 'coverage', '.nyc_output', '__pycache__', '.venv',
  'venv', '.tox', '.mypy_cache', '.pytest_cache', '.lingxiao',
  '.qoder', '.cache', '.gradle', '.idea', '.vscode',
]);

// 排除的文件扩展名（二进制等）
export const WIKI_EXCLUDE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
  '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2',
  '.exe', '.dll', '.so', '.dylib', '.wasm',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.sqlite', '.db', '.lock', '.pem', '.key', '.cert',
]);

// ─── Wiki 状态 ──────────────────────────────────────
export interface WikiStatus {
  projectPath: string;
  lang: WikiLanguage;
  exists: boolean;
  generating: boolean;
  lastGeneratedAt: number | null;
  documentCount: number;
  totalSize: number;
  changeCount: number;     // files changed since last generation
  version: number;
}

// ─── Wiki 文档 ──────────────────────────────────────
export interface WikiDocument {
  path: string;            // relative path within wiki dir
  title: string;
  section: string;         // "architecture", "modules", "api", etc.
  size: number;
  lastModified: number;
}

// ─── Meta 文件格式 ───────────────────────────────────
export interface WikiMeta {
  version: number;
  generatedAt: number;
  lang: WikiLanguage;
  totalFiles: number;
  sections: WikiMetaSection[];
  fileHashes: Record<string, string>;  // relativeFilePath → sha256
}

export interface WikiMetaSection {
  id: string;
  title: string;
  documentPath: string;    // e.g., "architecture.md"
  sourceFiles: string[];   // which source files this section covers
  hash: string;            // sha256 of the document content
}

/** 断点续传：记录已完成的 sections，用于中断恢复 */
export interface WikiCheckpoint {
  /** outline 哈希：outline 变化时 checkpoint 作废 */
  outlineHash: string;
  /** 已完成的 sections */
  sections: WikiMetaSection[];
}

// ─── 生成结果 ───────────────────────────────────────
export interface WikiGenerationResult {
  success: boolean;
  documentsGenerated: number;
  documentsUpdated: number;
  tokensUsed: number;
  duration: number;
  error?: string;
}

// ─── 变更集 ─────────────────────────────────────────
export interface ChangeSet {
  added: string[];
  modified: string[];
  deleted: string[];
}

// ─── 更新检查结果 ───────────────────────────────────
export interface UpdateCheckResult {
  needsUpdate: boolean;
  changeSet: ChangeSet;
  affectedSections: string[];  // section IDs
  changeCount: number;
}

// ─── Wiki 大纲 ──────────────────────────────────────
export interface WikiOutline {
  sections: WikiOutlineSection[];
}

export interface WikiOutlineSection {
  id: string;
  title: string;
  documentPath: string;
  sourceFiles: string[];
  description: string;    // what this section should cover
}

// ─── 项目扫描结果 ───────────────────────────────────
export interface ProjectScanResult {
  rootPath: string;
  totalFiles: number;
  languages: Record<string, number>;  // extension → count
  directoryTree: string;              // formatted tree string for LLM context
  keyFiles: string[];                 // entry points, configs, README
  sourceFiles: string[];              // all source files (relative)
}

// ─── 进度回调 ──────────────────────────────────────
export type WikiProgressCallback = (phase: WikiGenerationPhase, progress: number, detail: string) => void;

// ─── 流式输出回调 ──────────────────────────────────
export type WikiStreamCallback = (sectionId: string, sectionTitle: string, chunk: string) => void;

export type WikiGenerationPhase = 'scanning' | 'analyzing' | 'generating' | 'finalizing';

// ─── Git 同步结果 ───────────────────────────────────
export interface SyncResult {
  synced: boolean;
  documentsSynced: number;
  error?: string;
}

// ─── 生成请求 ───────────────────────────────────────
export interface WikiGenerateRequest {
  projectPath: string;
  lang: WikiLanguage;
}

export interface WikiUpdateRequest {
  projectPath: string;
  lang: WikiLanguage;
}
