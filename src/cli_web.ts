import { WebFetchTool } from './tools/implementations/WebFetch.js';
import { WebSearchTool } from './tools/implementations/WebSearch.js';
import { browserManager } from './tools/implementations/BrowserManager.js';
import { readBrowserDaemonFlag } from './core/BrowserProvider.js';

const fetchTool = new WebFetchTool();
const searchTool = new WebSearchTool();

export async function runFetchCommand(
  url: string,
  options?: { allowPrivateHosts?: boolean; prompt?: string },
): Promise<string> {
  try {
    const result = await fetchTool.execute({
      url,
      prompt: options?.prompt,
    });
    if (!result.success) return `ERROR: ${result.error}`;
    const d = result.data;
    if (d === null || d === undefined) return '';
    if (typeof d === 'string') return d;
    return JSON.stringify(d, null, 2);
  } finally {
    if (!readBrowserDaemonFlag()) {
      await browserManager.close();
    }
  }
}

export async function runSearchCommand(
  query: string,
  _options?: { allowPrivateHosts?: boolean },
): Promise<string> {
  try {
    const result = await searchTool.execute({ query });
    if (!result.success) return `ERROR: ${result.error}`;
    const d = result.data;
    if (d === null || d === undefined) return '';
    if (typeof d === 'string') return d;
    return JSON.stringify(d, null, 2);
  } finally {
    if (!readBrowserDaemonFlag()) {
      await browserManager.close();
    }
  }
}
