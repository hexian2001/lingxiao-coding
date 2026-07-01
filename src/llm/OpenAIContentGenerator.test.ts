import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIContentGenerator } from './OpenAIContentGenerator.js';

function makeGenerator(name: string): OpenAIContentGenerator {
  return new OpenAIContentGenerator({
    modelId: name,
    apiModelName: name,
    provider: 'openai',
    apiKey: 'test-key',
    baseUrl: `https://${name}.example.invalid/v1`,
  });
}

function stubCreate(generator: OpenAIContentGenerator, response: unknown): void {
  const mutable = generator as unknown as {
    client: {
      chat: {
        completions: {
          create: () => Promise<unknown>;
        };
      };
    };
  };
  mutable.client = {
    chat: {
      completions: {
        create: async () => response,
      },
    },
  };
}

test('OpenAIContentGenerator non-streaming treats undefined SDK response as retryable network_error', async () => {
  const generator = makeGenerator('openai-nonstream-undefined-response');
  stubCreate(generator, undefined);

  await assert.rejects(
    () => generator.generateContent({
      messages: [{ role: 'user', content: 'hello' }],
      model: 'openai-nonstream-undefined-response',
    }),
    (error: unknown) => {
      const candidate = error as { llmErrorKind?: string; retryable?: boolean; message?: string };
      assert.equal(candidate.llmErrorKind, 'network_error');
      assert.equal(candidate.retryable, true);
      assert.match(candidate.message ?? '', /Empty non-streaming response/);
      assert.doesNotMatch(candidate.message ?? '', /choices/);
      return true;
    },
  );
});

test('OpenAIContentGenerator non-streaming treats missing choices as retryable network_error', async () => {
  const generator = makeGenerator('openai-nonstream-missing-choices');
  stubCreate(generator, { id: 'chatcmpl-test', model: 'openai-nonstream-missing-choices' });

  await assert.rejects(
    () => generator.generateContent({
      messages: [{ role: 'user', content: 'hello' }],
      model: 'openai-nonstream-missing-choices',
    }),
    (error: unknown) => {
      const candidate = error as { llmErrorKind?: string; retryable?: boolean; message?: string };
      assert.equal(candidate.llmErrorKind, 'network_error');
      assert.equal(candidate.retryable, true);
      assert.match(candidate.message ?? '', /no choices returned/);
      return true;
    },
  );
});

test('OpenAIContentGenerator non-streaming parses valid completion response', async () => {
  const generator = makeGenerator('openai-nonstream-valid-response');
  stubCreate(generator, {
    id: 'chatcmpl-test',
    model: 'provider-model-id',
    choices: [
      {
        message: { role: 'assistant', content: 'pong' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });

  const response = await generator.generateContent({
    messages: [{ role: 'user', content: 'ping' }],
    model: 'openai-nonstream-valid-response',
  });

  assert.equal(response.content, 'pong');
  assert.equal(response.model, 'provider-model-id');
  assert.equal(response.finish_reason, 'stop');
  assert.equal(response.was_output_truncated, false);
  assert.equal(response.usage?.prompt_tokens, 3);
  assert.equal(response.usage?.completion_tokens, 2);
  assert.equal(response.usage?.total_tokens, 5);
});
