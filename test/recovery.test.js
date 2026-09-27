import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { select } from '../src/router.js';
import { validateResult, classifyFailure, decideRecovery, handoffPrompt } from '../src/recovery.js';

const config = loadConfig(fileURLToPath(new URL('../config.json', import.meta.url))).config;
const task = 'README의 오타 하나 수정해줘.';
const choice = tier => select(task, config, { tier });
function assess(tier, error, attempts = 1, commands = []) {
  const result = { exitCode: 1, error, commands, finalMessage: '' };
  const validation = validateResult(result);
  const classification = classifyFailure(result, validation);
  const recovery = decideRecovery({ choice: choice(tier), classification, validation, attempts: Array.from({ length: attempts }, () => ({ selectedTier: tier })), config });
  return { validation, classification, recovery, result };
}

test('A: syntax error retries the same model', () => {
  const { classification, recovery } = assess('light', 'SyntaxError: unexpected token');
  assert.equal(classification.category, 'CODE_ERROR');
  assert.equal(recovery.action, 'RETRY_SAME_MODEL');
});

test('B: missing interface context expands before a same-tier retry', () => {
  const { classification, recovery } = assess('light', 'Need to inspect the interface definition in src/user.ts');
  assert.equal(classification.category, 'CONTEXT_INSUFFICIENT');
  assert.equal(recovery.action, 'EXPAND_CONTEXT');
  assert.equal(recovery.tier, 'light');
});

test('C: reasoning failure escalates one tier', () => {
  const { classification, recovery } = assess('light', 'reasoning insufficient for complex logic');
  assert.equal(classification.category, 'REASONING_INSUFFICIENT');
  assert.equal(recovery.action, 'ESCALATE');
  assert.equal(recovery.tier, 'standard');
});

test('D: architecture failure proposes advanced from standard', () => {
  const { classification, recovery } = assess('standard', 'architecture conflict requires redesign');
  assert.equal(classification.category, 'ARCHITECTURE_PROBLEM');
  assert.equal(recovery.tier, 'advanced');
});

test('E: missing SDK does not escalate', () => {
  const { classification, recovery } = assess('standard', 'module not found: sdk');
  assert.equal(classification.category, 'DEPENDENCY_ERROR');
  assert.equal(recovery.action, 'STOP');
});

test('read-only Codex state database is a permission error', () => {
  const { classification, recovery } = assess('standard', 'failed to open state DB: attempt to write a readonly database; 액세스가 거부되었습니다.');
  assert.equal(classification.category, 'PERMISSION_ERROR');
  assert.equal(recovery.action, 'STOP');
});

test('F: advanced cannot escalate further', () => {
  const { recovery } = assess('advanced', 'reasoning insufficient');
  assert.equal(recovery.action, 'STOP');
});

test('G: total attempt cap stops further execution', () => {
  const { recovery } = assess('standard', 'syntax error', 4);
  assert.equal(recovery.action, 'STOP');
  assert.match(recovery.reason, /attempt limit/);
});

test('unknown failure receives one retry and never blind escalation', () => {
  assert.equal(assess('light', 'opaque failure').recovery.action, 'RETRY_SAME_MODEL');
  assert.equal(assess('light', 'opaque failure', 2).recovery.action, 'STOP');
});

test('repeated generic test or context failure does not trigger blind escalation', () => {
  assert.equal(assess('light', 'tests failed', 2).recovery.action, 'STOP');
  assert.equal(assess('light', 'need to inspect interface', 2).recovery.action, 'STOP');
});

test('configured strategies cannot turn environment errors into escalation', () => {
  const { validation, classification } = assess('light', 'network unavailable');
  const altered = structuredClone(config);
  altered.recovery.strategies.ENVIRONMENT_ERROR = 'ESCALATE';
  assert.equal(decideRecovery({ choice: choice('light'), classification, validation, attempts: [{ selectedTier: 'light' }], config: altered }).action, 'STOP');
});

test('successful test is deterministic success, no check is uncertain', () => {
  assert.equal(validateResult({ exitCode: 0, commands: [{ command: 'npm test', exitCode: 0, output: 'pass' }] }).status, 'SUCCESS');
  assert.equal(validateResult({ exitCode: 0, commands: [] }).status, 'UNCERTAIN');
  assert.equal(validateResult({ exitCode: 0, commands: [{ command: 'npm test', exitCode: 1, output: 'failed' }] }).status, 'FAILURE');
});

test('later passing test supersedes a repaired earlier failure', () => {
  const result = { exitCode: 0, commands: [{ command: 'npm test', exitCode: 1, output: 'failed' }, { command: 'npm test', exitCode: 0, output: 'pass' }] };
  assert.equal(validateResult(result).status, 'SUCCESS');
});

test('handoff contains structured observed facts without claiming unobserved edits', () => {
  const { classification, recovery, result } = assess('light', 'reasoning insufficient in src/auth/token.ts', 1, [{ command: 'npm test', exitCode: 1, output: 'failed' }]);
  const prompt = handoffPrompt(task, choice('light'), classification, recovery, result);
  assert.match(prompt, /Relevant Files: src\/auth\/token.ts/);
  assert.match(prompt, /Changes Attempted: Inspect git diff/);
  assert.match(prompt, /Failure Classification: REASONING_INSUFFICIENT/);
});
