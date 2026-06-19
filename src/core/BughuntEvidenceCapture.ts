import type { BughuntDb } from './BughuntLedger.js';
import { appendBughuntEvent, readBughuntLedger } from './BughuntLedger.js';
import { extractBughuntEvidenceEvent, type ExtractBughuntEvidenceInput } from './BughuntEvidenceExtractor.js';
import { writeBughuntEvidencePack } from './BughuntEvidencePack.js';
import { DEFAULT_BUGHUNT_POLICY, type BughuntPolicy } from './BughuntPolicy.js';

export interface CaptureBughuntEvidenceInput extends ExtractBughuntEvidenceInput {
  sessionId: string;
  workspace: string;
}

export function captureBughuntEvidence(
  db: BughuntDb,
  input: CaptureBughuntEvidenceInput,
  policy: BughuntPolicy = DEFAULT_BUGHUNT_POLICY,
): boolean {
  // 必须存在活跃的 bughunt ledger 才捕获。否则普通任务结果命中证据正则时，
  // 会在 ledger 存在性检查之前就把 evidence pack 写到 bughunt/unlinked/，
  // 留下孤儿产物（用户从未 /bughunt 也会落盘）。
  const ledger = readBughuntLedger(db, input.sessionId);
  if (!ledger || !ledger.active) return false;

  const event = extractBughuntEvidenceEvent(input, policy);
  if (!event) return false;

  const artifactPath = policy.evidencePack
    ? writeBughuntEvidencePack({
        sessionId: input.sessionId,
        workspace: input.workspace,
        event,
        rawResult: input.result,
        policy,
      })
    : undefined;

  appendBughuntEvent(db, input.sessionId, { ...event, artifact_path: artifactPath }, policy);
  return true;
}
