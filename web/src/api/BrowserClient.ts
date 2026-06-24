import { apiHeaders, getServerToken } from './headers';

export interface BrowserViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export interface BrowserSessionSummary {
  id: string;
  url: string;
  title: string;
  createdAt: number;
  lastUsedAt: number;
  viewport: BrowserViewport;
}

export interface BrowserHealth {
  platform: string;
  playwrightVersion?: string;
  expectedExecutablePath?: string;
  resolvedExecutablePath?: string;
  resolvedExecutableSource?: string;
  playwrightCliExists: boolean;
  executableExists: boolean;
  canLaunch?: boolean;
  installCommand: string;
  installDepsCommand?: string;
  detectedCandidates: Array<{ source: string; path: string; exists: boolean }>;
  diagnostics: string[];
}

export interface BrowserElementSelection {
  browserSessionId: string;
  url: string;
  title: string;
  selector: string;
  xpath: string;
  role?: string;
  ariaLabel?: string;
  tag: string;
  text?: string;
  htmlSnippet: string;
  rect: { x: number; y: number; width: number; height: number };
  viewport: BrowserViewport;
  screenshotUrl?: string;
}

export interface BrowserElementCommentResult {
  type: 'browser_element_comment';
  prompt: string;
  context: {
    type: 'browser_element_comment';
    intent: string;
    comment: string;
    selection: BrowserElementSelection;
  };
}

async function readJson<T>(res: Response): Promise<T> {
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(json?.error || `HTTP ${res.status}`);
  }
  return json?.data as T;
}

export const browserClient = {
  async health(launch = false): Promise<BrowserHealth> {
    const query = launch ? '?launch=1' : '';
    const res = await fetch(`/api/v1/browser/health${query}`, {
      headers: apiHeaders(),
    });
    return readJson<BrowserHealth>(res);
  },

  async listSessions(): Promise<BrowserSessionSummary[]> {
    const res = await fetch('/api/v1/browser/sessions', {
      headers: apiHeaders(),
    });
    return readJson<BrowserSessionSummary[]>(res);
  },

  async createSession(url?: string): Promise<BrowserSessionSummary> {
    const res = await fetch('/api/v1/browser/sessions', {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ url, viewport: { width: 1280, height: 820, deviceScaleFactor: 1 } }),
    });
    return readJson<BrowserSessionSummary>(res);
  },

  async closeSession(sessionId: string): Promise<{ closed: boolean }> {
    const res = await fetch(`/api/v1/browser/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: apiHeaders(),
    });
    return readJson<{ closed: boolean }>(res);
  },

  async navigate(sessionId: string, url: string): Promise<BrowserSessionSummary> {
    const res = await fetch(`/api/v1/browser/sessions/${encodeURIComponent(sessionId)}/navigate`, {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ url }),
    });
    return readJson<BrowserSessionSummary>(res);
  },

  async inspect(sessionId: string, x: number, y: number): Promise<BrowserElementSelection> {
    const res = await fetch(`/api/v1/browser/sessions/${encodeURIComponent(sessionId)}/inspect`, {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ x, y }),
    });
    return readJson<BrowserElementSelection>(res);
  },

  async comment(
    sessionId: string,
    selection: BrowserElementSelection,
    comment: string,
    intent: string,
  ): Promise<BrowserElementCommentResult> {
    const res = await fetch(`/api/v1/browser/sessions/${encodeURIComponent(sessionId)}/comment`, {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ selection, comment, intent }),
    });
    return readJson<BrowserElementCommentResult>(res);
  },

  screenshotUrl(sessionId: string): string {
    const token = encodeURIComponent(getServerToken());
    return `/api/v1/browser/sessions/${encodeURIComponent(sessionId)}/screenshot?token=${token}&t=${Date.now()}`;
  },
  // v1.0.5 剑阁大改：真实交互
  async click(sessionId: string, x: number, y: number): Promise<{ ok: true; url: string; title: string }> {
    const res = await fetch(`/api/v1/browser/sessions/${encodeURIComponent(sessionId)}/click`, {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ x, y }),
    });
    return readJson(res);
  },

  async clickSelector(sessionId: string, selector: string): Promise<{ ok: true; url: string; title: string }> {
    const res = await fetch(`/api/v1/browser/sessions/${encodeURIComponent(sessionId)}/click`, {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ selector }),
    });
    return readJson(res);
  },

  async fill(sessionId: string, selector: string, value: string): Promise<{ ok: true }> {
    const res = await fetch(`/api/v1/browser/sessions/${encodeURIComponent(sessionId)}/fill`, {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ selector, value }),
    });
    return readJson(res);
  },

  async scroll(sessionId: string, x: number, y: number): Promise<{ ok: true; scrollX: number; scrollY: number }> {
    const res = await fetch(`/api/v1/browser/sessions/${encodeURIComponent(sessionId)}/scroll`, {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ x, y }),
    });
    return readJson(res);
  },

  async evalJs(sessionId: string, script: string): Promise<{ ok: true; result: unknown }> {
    const res = await fetch(`/api/v1/browser/sessions/${encodeURIComponent(sessionId)}/eval`, {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ script }),
    });
    return readJson(res);
  },

  async getHtml(sessionId: string): Promise<{ html: string; url: string; title: string }> {
    const res = await fetch(`/api/v1/browser/sessions/${encodeURIComponent(sessionId)}/html`, {
      headers: apiHeaders(),
    });
    return readJson(res);
  },

  async setHtml(sessionId: string, html: string): Promise<{ ok: true; url: string; title: string }> {
    const res = await fetch(`/api/v1/browser/sessions/${encodeURIComponent(sessionId)}/html`, {
      method: 'PUT',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ html }),
    });
    return readJson(res);
  },

  async getDomTree(sessionId: string, depth?: number): Promise<DomTreeNode> {
    const url = `/api/v1/browser/sessions/${encodeURIComponent(sessionId)}/dom-tree${depth ? `?depth=${depth}` : ''}`;
    const res = await fetch(url, { headers: apiHeaders() });
    return readJson<DomTreeNode>(res);
  },

  async patchElement(sessionId: string, selector: string, patch: {
    html?: string; text?: string; style?: string; attr?: Record<string, string>; remove?: boolean;
  }): Promise<{ ok: true; applied: boolean }> {
    const res = await fetch(`/api/v1/browser/sessions/${encodeURIComponent(sessionId)}/patch-element`, {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ selector, ...patch }),
    });
    return readJson(res);
  },
};

export interface DomTreeNode {
  tag: string;
  attrs: Record<string, string>;
  text?: string;
  rect: { x: number; y: number; w: number; h: number };
  childCount: number;
  children?: DomTreeNode[];
}
