export type BughuntEventCaptureMode = 'off' | 'minimal';
export type BughuntTruthCheckMode = 'minimal';

export interface BughuntSignalPattern {
  name: string;
  pattern: RegExp;
}

export interface BughuntPolicy {
  eventCapture: BughuntEventCaptureMode;
  evidencePack: boolean;
  truthChecks: BughuntTruthCheckMode;
  maxEvents: number;
  maxEventSummaryChars: number;
  maxEventItems: number;
  maxEvidenceLineChars: number;
  maxRawResultChars: number;
  maxCommandChars: number;
  commandPrefixes: string[];
  sourcePathPrefixes: string[];
  evidenceSignals: BughuntSignalPattern[];
}

export const DEFAULT_BUGHUNT_POLICY: BughuntPolicy = {
  eventCapture: 'minimal',
  evidencePack: true,
  truthChecks: 'minimal',
  maxEvents: 50,
  maxEventSummaryChars: 500,
  maxEventItems: 10,
  maxEvidenceLineChars: 500,
  maxRawResultChars: 20_000,
  maxCommandChars: 800,
  commandPrefixes: [
    'npm', 'pnpm', 'yarn', 'node', 'npx', 'tsc', 'vitest', 'jest', 'pytest',
    'cargo', 'go test', 'curl', 'python', 'bash', 'sh',
  ],
  sourcePathPrefixes: ['src', 'web', 'test', 'tests', 'scripts', 'docs'],
  evidenceSignals: [
    { name: 'evidence', pattern: /\bevidence\b/i },
    { name: 'zh-evidence', pattern: /证据/ },
    { name: 'repro', pattern: /\brepro\b/i },
    { name: 'zh-repro', pattern: /复现/ },
    { name: 'verified', pattern: /\bverified\b/i },
    { name: 'zh-verified', pattern: /验证/ },
    { name: 'confirmed', pattern: /\bconfirmed\b/i },
    { name: 'zh-confirmed', pattern: /确认/ },
    { name: 'failed', pattern: /\bfailed\b/i },
    { name: 'zh-failed', pattern: /失败/ },
    { name: 'passed', pattern: /\bpassed\b/i },
    { name: 'zh-passed', pattern: /通过/ },
    { name: 'curl', pattern: /\bcurl\b/i },
    { name: 'exit-code', pattern: /\bexit code\b/i },
    { name: 'zh-exit-code', pattern: /退出码/ },
  ],
};

export function getBughuntPolicy(overrides?: Partial<BughuntPolicy>): BughuntPolicy {
  return { ...DEFAULT_BUGHUNT_POLICY, ...(overrides || {}) };
}
