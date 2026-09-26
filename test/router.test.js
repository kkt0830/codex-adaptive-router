import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { analyze, select } from '../src/router.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig(fileURLToPath(new URL('../config.json', import.meta.url))).config;

const cases = [
  ['README의 오타 하나 수정해줘.', 'light', 'clear, narrow text'],
  ['버튼 텍스트를 "Login"에서 "Sign in"으로 변경해줘.', 'light', 'clear, narrow text'],
  ['README의 내용을 한 문장으로 요약해줘.', 'standard', 'requires reading and synthesizing'],
  ['사용자 프로필 API endpoint를 추가하고 테스트를 작성해줘.', 'standard', 'source implementation'],
  ['현재 인증 시스템을 분석하고 refresh token rotation을 추가하되 기존 클라이언트 호환성을 유지해줘.', 'advanced', 'architecture or difficult debugging'],
  ['간헐적으로 발생하는 concurrency bug의 원인을 찾아라. 재현 조건이 명확하지 않으며 여러 subsystem이 관련되어 있다.', 'advanced', 'architecture or difficult debugging']
];

for (const [task, tier, reason] of cases) {
  test(`routes ${task.slice(0, 30)}`, () => {
    const result = select(task, config);
    assert.equal(result.analysis.classification, tier);
    assert.equal(result.tier, tier);
    assert.ok(result.analysis.reason.includes(reason), result.analysis.reason);
    for (const value of Object.values(result.analysis.dimensions)) assert.ok(value >= 0 && value <= 4);
  });
}

test('file count alone does not select Astra', () => {
  assert.equal(analyze('Update several files with the new API endpoint and tests.').classification, 'standard');
});

test('cross-subsystem concurrency bug has broad context and high risk', () => {
  const result = analyze('간헐적인 concurrency bug이며 여러 subsystem이 관련되어 있다.');
  assert.equal(result.dimensions.context, 3);
  assert.equal(result.dimensions.risk, 4);
});

test('override selects a tier and exact configured model', () => {
  const result = select('README의 오타 하나 수정해줘.', config, { tier: 'advanced', model: 'gpt-6-astra', reasoning: 'low' });
  assert.equal(result.tier, 'advanced');
  assert.equal(result.model, 'gpt-6-astra');
  assert.equal(result.reasoning, 'low');
  assert.equal(result.override, true);
});

test('lower-tier override explains possible escalation', () => {
  const result = select('README의 내용을 요약해줘.', config, { tier: 'light' });
  assert.equal(result.analysis.classification, 'standard');
  assert.equal(result.tier, 'light');
  assert.match(result.escalationExpected, /lower-tier override/);
});

test('empty tasks are rejected', () => {
  assert.throws(() => analyze('  '), /required/);
});
