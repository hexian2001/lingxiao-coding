import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLanguage } from './index.js';

test('normalizeLanguage accepts the same variant set as the server (unified locale contract)', () => {
  // zh family
  assert.equal(normalizeLanguage('zh'), 'zh');
  assert.equal(normalizeLanguage('zh-CN'), 'zh');
  assert.equal(normalizeLanguage('zh_CN'), 'zh');
  assert.equal(normalizeLanguage('cn'), 'zh');
  assert.equal(normalizeLanguage('ZH'), 'zh');
  // en family
  assert.equal(normalizeLanguage('en'), 'en');
  assert.equal(normalizeLanguage('en-US'), 'en');
  assert.equal(normalizeLanguage('us'), 'en');
  assert.equal(normalizeLanguage('EN'), 'en');
  // unknown / non-string → null (容错，不抛)
  assert.equal(normalizeLanguage('fr'), null);
  assert.equal(normalizeLanguage(''), null);
  assert.equal(normalizeLanguage(null), null);
  assert.equal(normalizeLanguage(undefined), null);
  assert.equal(normalizeLanguage(123), null);
});
