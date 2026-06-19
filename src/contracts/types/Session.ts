export type LeaderExecutionMode = 'direct' | 'hybrid' | 'delegate';
export type ControlMode = 'manual' | 'eternal';

export interface SessionIdentity {
  id: string;
  workspace: string;
}

