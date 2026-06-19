import { useCallback, useEffect, useState } from 'react';
import { getServerToken } from '../../api/headers';
import type { WorkbenchContext } from './workbenchTypes';

export function useWorkbenchContext(sessionId: string | null, workspace: string) {
  const [context, setContext] = useState<WorkbenchContext | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const params = new URLSearchParams();
    if (sessionId) params.set('sessionId', sessionId);
    if (workspace) params.set('workspace', workspace);
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/workbench/context?${params.toString()}`, {
        headers: { 'x-lingxiao-token': getServerToken() },
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(json?.error || `HTTP ${res.status}`);
      }
      setContext(json?.data ?? null);
    } catch (event) {
      setError(event instanceof Error ? event.message : String(event));
    } finally {
      setIsLoading(false);
    }
  }, [sessionId, workspace]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return { context, isLoading, error, refresh };
}
