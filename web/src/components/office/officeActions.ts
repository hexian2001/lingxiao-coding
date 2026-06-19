import { acpClient } from '../../api/AcpClient';

export type OfficeActionStatus = { kind: 'success' | 'error' | 'info'; message: string };

export async function sendSessionPrompt(sessionId: string, content: string): Promise<void> {
  await acpClient.sendJsonRpc('session/prompt', { sessionId, content });
}

export async function sendAgentPrompt(sessionId: string, agentName: string, message: string): Promise<void> {
  await sendSessionPrompt(sessionId, `@${agentName} ${message}`);
}

export async function sendNudge(sessionId: string, prompt: string): Promise<void> {
  await acpClient.sendJsonRpc('session/nudge', { sessionId, prompt });
}

export async function cancelSession(sessionId: string): Promise<void> {
  await acpClient.sendJsonRpc('session/cancel', { sessionId });
}

export async function runSlashCommand(command: string, args = ''): Promise<void> {
  const result = await acpClient.sendJsonRpc('session/command', { command, args });
  if (result && typeof result === 'object' && 'success' in result && (result as { success?: boolean }).success === false) {
    const message = (result as { error?: unknown }).error;
    throw new Error(typeof message === 'string' ? message : `Command failed: ${command}`);
  }
}

export async function approvePlan(): Promise<void> {
  await acpClient.sendJsonRpc('session/approvePlan');
}

export async function rejectPlan(feedback: string): Promise<void> {
  await acpClient.sendJsonRpc('session/rejectPlan', { feedback });
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
