import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { select } from '../src/router.js';
import { supervise } from '../src/supervisor.js';

const config = loadConfig(fileURLToPath(new URL('../config.json', import.meta.url))).config;
const success = (threadId = 'session-123') => ({ exitCode: 0, threadId, durationMs: 2, usage: { input_tokens: 12 }, commands: [{ command: 'npm test', exitCode: 0, output: 'pass' }], error: null });

function terminal(answers = []) {
  const input = new PassThrough(); input.isTTY = true;
  const output = new PassThrough(); output.isTTY = true;
  let written = '';
  let count = 0;
  output.on('data', data => {
    written += data.toString();
    if (written.split('Approve switch?').length - 1 > count) {
      queueMicrotask(() => input.write(`${answers[count++] || 'n'}\n`));
    }
  });
  return { input, output, get written() { return written; } };
}

for (const [decision, expectedModel, switchCount] of [['y', 'gpt-6-astra', 1], ['n', 'gpt-6-luna', 0]]) {
  test(`manual switch ${decision} preserves the session`, async () => {
    const io = terminal([decision]);
    const initial = select('README의 오타 하나 수정해줘.', config);
    let count = 0;
    let resumed;
    const executeFn = async (choice, options) => {
      if (count++ === 0) {
        options.onEvent({ type: 'thread.started', thread_id: 'session-123' });
        return new Promise(resolve => {
          options.onChild({ kill: () => resolve({ exitCode: 1, threadId: 'session-123', durationMs: 1, error: 'interrupted', commands: [] }) });
          queueMicrotask(() => io.input.write('/switch advanced\n'));
        });
      }
      resumed = { choice, options };
      return success();
    };
    const result = await supervise(initial, { config, baseDir: os.tmpdir(), ...io, executeFn });
    assert.equal(result.success, true);
    assert.equal(result.switches, switchCount);
    assert.equal(resumed.choice.model, expectedModel);
    assert.equal(resumed.options.resumeThreadId, 'session-123');
  });
}

test('reasoning failure proposes escalation and starts a new session with compact handoff after approval', async () => {
  const io = terminal(['y']);
  const initial = select('README의 오타 하나 수정해줘.', config);
  let count = 0;
  let next;
  const executeFn = async (choice, options) => {
    if (count++ === 0) return { exitCode: 1, threadId: 'old-session', durationMs: 1, error: 'reasoning insufficient for complex logic', commands: [{ command: 'npm test', exitCode: 1, output: 'complex logic failed' }] };
    next = { choice, options };
    return success('new-session');
  };
  const result = await supervise(initial, { config, baseDir: os.tmpdir(), ...io, executeFn });
  assert.equal(result.success, true);
  assert.equal(result.automaticSwitches, 1);
  assert.equal(next.choice.model, 'gpt-6-sol');
  assert.equal(next.options.resumeThreadId, null);
  assert.match(next.options.prompt, /Failure Classification: REASONING_INSUFFICIENT/);
  assert.equal(result.attempts[0].escalatedFrom, 'light');
  assert.equal(result.attempts[0].escalatedTo, 'standard');
  assert.equal(result.attempts[0].taskId, result.attempts[1].taskId);
});

test('environment failure stops without escalation', async () => {
  const initial = select('README의 오타 하나 수정해줘.', config);
  let calls = 0;
  const result = await supervise(initial, { config, baseDir: os.tmpdir(), interactive: false, output: { write() {} }, executeFn: async () => { calls++; return { exitCode: 1, threadId: 'session', durationMs: 1, error: 'network unavailable', commands: [] }; } });
  assert.equal(calls, 1);
  assert.equal(result.attempts[0].failureClassification.category, 'ENVIRONMENT_ERROR');
  assert.equal(result.attempts[0].recoveryAction, 'STOP');
});

test('noninteractive code error retries once with same model and session', async () => {
  const initial = select('README의 오타 하나 수정해줘.', config);
  const calls = [];
  const result = await supervise(initial, { config, baseDir: os.tmpdir(), interactive: false, output: { write() {} }, executeFn: async (choice, options) => {
    calls.push({ choice, options });
    if (calls.length === 1) return { exitCode: 1, threadId: 'session', durationMs: 1, error: 'syntax error', commands: [] };
    return success();
  } });
  assert.equal(result.success, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].choice.model, initial.model);
  assert.equal(calls[1].options.resumeThreadId, 'session');
  assert.equal(result.attempts[0].recoveryAction, 'RETRY_SAME_MODEL');
});

test('noninteractive reasoning failure proposes but does not execute a model switch', async () => {
  const initial = select('README의 오타 하나 수정해줘.', config);
  let calls = 0;
  const result = await supervise(initial, { config, baseDir: os.tmpdir(), interactive: false, output: { write() {} }, executeFn: async () => { calls++; return { exitCode: 1, threadId: 'session', durationMs: 1, error: 'reasoning insufficient', commands: [] }; } });
  assert.equal(calls, 1);
  assert.equal(result.switches, 0);
  assert.equal(result.attempts[0].recoveryAction, 'ESCALATE');
  assert.equal(result.attempts[0].escalatedTo, undefined);
});

test('supervisor respects maxTotalAttempts during repeated failures', async () => {
  const initial = select('README의 오타 하나 수정해줘.', config);
  const limited = structuredClone(config);
  limited.recovery.maxTotalAttempts = 2;
  let calls = 0;
  const result = await supervise(initial, { config: limited, baseDir: os.tmpdir(), interactive: false, output: { write() {} }, executeFn: async () => { calls++; return { exitCode: 1, threadId: 'session', durationMs: 1, error: 'syntax error', commands: [] }; } });
  assert.equal(calls, 2);
  assert.equal(result.attempts.at(-1).recoveryAction, 'STOP');
});
