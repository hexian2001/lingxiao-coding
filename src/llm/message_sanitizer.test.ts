import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeMessageSequence, sanitizeOpenAIToolMessageSequence } from './message_sanitizer.js';
import type { ChatMessage } from './types.js';

const A = (ids: string[], content: ChatMessage['content'] = null): ChatMessage => ({
  role: 'assistant',
  content,
  tool_calls: ids.map((id) => ({ id, type: 'function', function: { name: 'echo', arguments: '{}' } })),
}) as ChatMessage;
const T = (id: string, content = 'result'): ChatMessage => ({ role: 'tool', content, tool_call_id: id }) as ChatMessage;
const U = (content = 'hi'): ChatMessage => ({ role: 'user', content }) as ChatMessage;
const S = (content = 'sys'): ChatMessage => ({ role: 'system', content }) as ChatMessage;

function assertToolPairingValid(messages: ChatMessage[]): void {
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    const responded = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j].role === 'tool') {
      const id = (messages[j] as { tool_call_id?: string }).tool_call_id;
      if (id) responded.add(id);
      j += 1;
    }
    for (const tc of m.tool_calls) {
      assert.ok(responded.has(tc.id), `assistant@${i} tool_call ${tc.id} not immediately followed (next non-tool at ${j})`);
    }
  }
}

test('defers user injected between tool_call and tool_result', () => {
  const out = sanitizeOpenAIToolMessageSequence([S(), U(), A(['A', 'B']), T('A'), U('injected'), T('B')]);
  assertToolPairingValid(out);
});

test('defers system event injected between tool_call and tool_result', () => {
  const out = sanitizeOpenAIToolMessageSequence([S(), U(), A(['A']), S('[Orch] status'), T('A')]);
  assertToolPairingValid(out);
});

test('tool_call with no result followed by user input', () => {
  const out = sanitizeOpenAIToolMessageSequence([S(), U(), A(['A']), U('next')]);
  assertToolPairingValid(out);
});

test('out-of-order tool results with interleaved user', () => {
  const out = sanitizeOpenAIToolMessageSequence([S(), U(), A(['A', 'B']), T('B'), U('mid'), T('A')]);
  assertToolPairingValid(out);
});

test('full pipeline user injected', () => {
  assertToolPairingValid(sanitizeMessageSequence([S(), U(), A(['A', 'B']), T('A'), U('inj'), T('B')]));
});

test('full pipeline system injected', () => {
  assertToolPairingValid(sanitizeMessageSequence([S(), U(), A(['A']), S('mid'), T('A')]));
});
