import type { ToolCall } from '../llm/types.js';

/**
 * Language keywords that should NOT be treated as tool names when found in
 * fenced code block language tags (```lang\n{...}\n```).
 */
const LANGUAGE_KEYWORDS = new Set([
  'json', 'javascript', 'js', 'typescript', 'ts', 'python', 'py', 'bash', 'sh', 'shell',
  'text', 'html', 'css', 'xml', 'yaml', 'yml', 'toml', 'ini', 'sql', 'go', 'rust', 'java',
  'c', 'cpp', 'c++', 'c#', 'php', 'ruby', 'kotlin', 'swift', 'scala', 'perl', 'r',
  'markdown', 'md', 'diff', 'plaintext', 'graphql', 'dockerfile', 'makefile',
]);
/**
 * JavaScript control-flow keywords that could theoretically precede ({...}) in
 * code examples. Used ONLY for function-call style detection in hasRawToolSyntax —
 * much smaller than LANGUAGE_KEYWORDS because tool_name({...}) format is inherently
 * unambiguous outside of actual code.
 */
const JS_CONTROL_FLOW = new Set([
  'if', 'for', 'while', 'switch', 'function', 'return', 'typeof',
  'void', 'new', 'delete', 'await', 'async', 'yield', 'catch',
]);

/**
 * Map graph_* fenced code block types to blackboard tool actions.
 * Worker prompts instruct models to use ```graph_fact {...}``` etc. for
 * blackboard writes; we translate them to blackboard({action, ...}) tool calls.
 */
const GRAPH_BLOCK_TO_BLACKBOARD_ACTION: Record<string, string> = {
  graph_fact: 'write_fact',
  graph_intent: 'declare_intent',
  graph_edge: 'add_edge',
  graph_supersede: 'supersede_node',
};

function buildToolCall(name: string, args: string | Record<string, unknown>): ToolCall {
  return {
    id: `parsed-${Math.random().toString(36).slice(2, 10)}`,
    type: 'function',
    function: {
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  };
}

function parseJsonValue(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {/* expected: fallback to default */
    return trimmed;
  }
}

function normalizeJsonObject(raw: string): string {
  const trimmed = raw.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch (error) {
    return JSON.stringify({
      __raw_tool_parse_error: true,
      raw_preview: trimmed.slice(0, 300),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseDurationMs(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let consumed = '';
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    consumed += match[0];
    const value = Number(match[1]);
    const unit = match[2];
    const multiplier = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000;
    total += value * multiplier;
  }
  if (!total || consumed !== text) return null;
  return Math.max(1_000, Math.min(Math.round(total), 300_000));
}

function withTimeoutArg(jsonRaw: string, timeoutRaw: string): string {
  const timeoutMs = parseDurationMs(timeoutRaw);
  if (!timeoutMs) return normalizeJsonObject(jsonRaw);
  try {
    const args = JSON.parse(jsonRaw.trim());
    if (!args || typeof args !== 'object' || Array.isArray(args)) return '{}';
    return JSON.stringify({ timeout_ms: timeoutMs, ...args });
  } catch (error) {
    return JSON.stringify({
      __raw_tool_parse_error: true,
      raw_preview: jsonRaw.trim().slice(0, 300),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function parseRawToolCalls(text: string): ToolCall[] | null {
  if (!text.trim()) {
    return null;
  }

  const results: ToolCall[] = [];

  const pattern1 = /<tool[=\s]+(\w+)>(.*?)(?:<\/tool_call>|<\/tool>|$)/gis;
  let match: RegExpExecArray | null;
  while ((match = pattern1.exec(text)) !== null) {
    const toolName = match[1].trim();
    const body = match[2].trim();
    const params: Record<string, unknown> = {};

    const paramPattern = /<parameter[=\s]+(\w+)>\s*(.*?)(?=<parameter|<\/tool_call|<\/tool|$)/gis;
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramPattern.exec(body)) !== null) {
      params[paramMatch[1].trim()] = parseJsonValue(paramMatch[2]);
    }

    if (toolName) {
      results.push(buildToolCall(toolName, params));
    }
  }

  if (results.length === 0) {
    const pattern2 = /<tool>\s*(\w+)\s*\(\s*(\{.*?\})\s*\)\s*<\/tool>/gis;
    while ((match = pattern2.exec(text)) !== null) {
      const toolName = match[1].trim();
      if (toolName) {
        results.push(buildToolCall(toolName, normalizeJsonObject(match[2])));
      }
    }
  }

  if (results.length === 0) {
    const pattern3 = /<tool_call>\s*(?:<function>)?(\w+)(?:<\/function>)?\s*(?:<parameters?>)?(\{.*?\})(?:<\/parameters?>)?\s*<\/tool_call>/gis;
    while ((match = pattern3.exec(text)) !== null) {
      const toolName = match[1].trim();
      if (toolName) {
        results.push(buildToolCall(toolName, normalizeJsonObject(match[2])));
      }
    }
  }

  if (results.length === 0) {
    const durationPrefixPattern = /(?:^|\n)\s*(\w+)\s+((?:\d+(?:\.\d+)?(?:ms|s|m|h))+)[ \t]*(\{[^\n]*\})\s*$/gis;
    while ((match = durationPrefixPattern.exec(text)) !== null) {
      const toolName = match[1].trim();
      if (toolName) {
        results.push(buildToolCall(toolName, withTimeoutArg(match[3], match[2])));
      }
    }
  }

  if (results.length === 0) {
    const pattern4 = /<invoke\s+tool="(\w+)">(.*?)<\/invoke>/gis;
    while ((match = pattern4.exec(text)) !== null) {
      const toolName = match[1].trim();
      const body = match[2].trim();
      const params: Record<string, unknown> = {};

      const paramPattern = /<parameter\s+name="(\w+)">(.*?)<\/parameter>/gis;
      let paramMatch: RegExpExecArray | null;
      while ((paramMatch = paramPattern.exec(body)) !== null) {
        params[paramMatch[1].trim()] = parseJsonValue(paramMatch[2]);
      }

      if (toolName) {
        results.push(buildToolCall(toolName, params));
      }
    }
  }

  if (results.length === 0) {
    const pattern5 = /<function[=\s]+(\w+)>(.*?)<\/function>/gis;
    while ((match = pattern5.exec(text)) !== null) {
      const toolName = match[1].trim();
      const body = match[2].trim();
      const params: Record<string, unknown> = {};

      const paramPattern = /<parameter[=\s]+(\w+)>\s*(.*?)\s*<\/parameter>/gis;
      let paramMatch: RegExpExecArray | null;
      while ((paramMatch = paramPattern.exec(body)) !== null) {
        params[paramMatch[1].trim()] = parseJsonValue(paramMatch[2]);
      }

      if (toolName) {
        results.push(buildToolCall(toolName, params));
      }
    }
  }

  // Pattern 6: Fenced code block with tool-call semantics.
  // Handles two degradation modes:
  //   (a) graph_* blocks — prompts instruct models to use ```graph_fact {...}```
  //       for blackboard writes; translate to blackboard({action, ...}) calls.
  //   (b) ```tool_name\n{...}\n``` — model wraps tool-call JSON in a code fence
  //       whose language tag is the tool name.
  if (results.length === 0) {
    const fencedPattern = /```(\w+)\s*\n([\s\S]*?)```/gi;
    while ((match = fencedPattern.exec(text)) !== null) {
      const fenceLang = match[1].trim().toLowerCase();
      const body = match[2].trim();
      if (!body) continue;

      // Case A: graph_* blocks → map to blackboard tool
      if (GRAPH_BLOCK_TO_BLACKBOARD_ACTION[fenceLang]) {
        const action = GRAPH_BLOCK_TO_BLACKBOARD_ACTION[fenceLang];
        try {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            results.push(buildToolCall('blackboard', { action, ...parsed }));
          }
        } catch {/* skip unparseable graph_* body */}
        continue;
      }

      // Case B: fence language is a plausible tool name (not a language keyword)
      if (fenceLang && !LANGUAGE_KEYWORDS.has(fenceLang)) {
        if (body.startsWith('{')) {
          results.push(buildToolCall(fenceLang, normalizeJsonObject(body)));
        }
      }
    }
  }

  return results.length > 0 ? results : null;
}

/**
 * Detect explicit tool-call markup in model output.
 *
 * Only matches structured patterns that the system prompt instructs models to emit:
 * 1. XML-based tool call tags: <tool_call>, <tool>, <function>, <invoke>, <tool_use>
 * 2. Duration-prefixed shorthand: `tool_name 30s {"arg":"val"}`
 *
 * Also detects bare JSON objects (entire output is pure JSON), graph_* fenced code
 * blocks, and function-call style tool_name({...}) — all common model degradation
 * modes where tool calls are written as text instead of native function calling.
 */
export function hasRawToolSyntax(text: string): boolean {
  // Duration-prefixed shorthand: `shell 1m30s {"command":"pwd"}`
  if (/(?:^|\n)\s*\w+\s+(?:\d+(?:\.\d+)?(?:ms|s|m|h))+[ \t]*\{[^\n]*\}\s*$/i.test(text)) {
    return true;
  }
  // Explicit opening XML tag for known tool-call elements
  if (/<(?:tool_call|tool|function|parameters|invoke|tool_use)(?:[=\s>]|$)/i.test(text)) {
    return true;
  }
  // Explicit closing XML tag for known tool-call elements
  if (/<\/(?:tool_call|tool|function|parameters|invoke|tool_use)\s*>/i.test(text)) {
    return true;
  }
  // Fenced code block with graph_* semantics (instructed by worker prompts)
  if (/```(?:graph_fact|graph_intent|graph_edge|graph_supersede)\b/i.test(text)) {
    return true;
  }
  // Bare JSON object: when the entire output (after stripping code fence) is a single
  // JSON object, it is almost certainly a degraded tool call — normal assistant replies
  // always contain natural language. This catches models that write tool-call arguments
  // as plain JSON instead of using native function calling.
  const bareStripped = text.trim()
    .replace(/^```(?:\w*)\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
  if (bareStripped.startsWith('{') && bareStripped.endsWith('}')) {
    try {
      const parsed = JSON.parse(bareStripped);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length > 0) {
        return true;
      }
    } catch {
      // Truncated/invalid JSON — still suspicious if it has tool-parameter-like keys
      if (/\b(?:action|command|path|content|pattern|query|url)\b/i.test(bareStripped)) {
        return true;
      }
    }
  }
  // Function-call style: tool_name({...})
  // Unlike fenced code block language tags, this pattern rarely appears in normal
  // text — only exclude JS control-flow keywords that could theoretically precede ({...}).
  const funcCallMatch = text.match(/\b(\w+)\s*\(\s*\{/);
  if (funcCallMatch && !JS_CONTROL_FLOW.has(funcCallMatch[1].toLowerCase())) {
    return true;
  }
  return false;
}
