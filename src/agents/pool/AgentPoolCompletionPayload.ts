import type {
  WorkerArtifactTrace,
  WorkerContractComplianceProof,
  WorkerVerificationItem,
} from '../../core/AgentProtocol.js';
import type { SpeculativeWinnerEvidence } from '../../core/SpeculativeExecutionController.js';

export type StructuredCompletionPayload = {
  summary?: string;
  verdict?: 'PASS' | 'FAIL' | 'BLOCKED';
  artifacts?: WorkerArtifactTrace;
  verification?: WorkerVerificationItem[];
  next_steps?: string[];
  blocked_by_discovery?: string[];
  needs_leader_coordination?: boolean;
  evidence_refs?: string[];
  contract_compliance?: WorkerContractComplianceProof;
  toolTrace?: WorkerArtifactTrace;
  taskRunGeneration?: number;
  speculativeWinner?: SpeculativeWinnerEvidence;
};
