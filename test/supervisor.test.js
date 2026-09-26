import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { select } from '../src/router.js';
import { supervise } from '../src/supervisor.js';

const config = loadConfig(fileURLToPath(new URL('../config.json', import.meta.url))).config;

for (const [decision, expectedModel, switchCount] of [
  ['y', 'gpt-6-astra', 1],
  ['n', 'gpt-6-luna', 0]
]) {
  test(`interactive switch ${decision === 'y' ? 'approved' : 'declined'} resumes same session`, async () => {
    const task = 'README의 오타 하나 수정해줘.';
    const initial = select(task, config);
    const input = new PassThrough();
    input.isTTY = true;
    const output = new PassThrough();
    output.isTTY = true;
    let written = '';
    let first = true;
    let resumed = null;
    output.on('data', data => {
      written += data.toString();
      if (written.includes('Approve switch?') && !written.includes('__answered__')) {
        written += '__answered__';
        queueMicrotask(() => input.write(`${decision}\n`));
      }
    });
    const executeFn = async (choice, options) => {
      if (first) {
        first = false;
        options.onEvent({ type: 'thread.started', thread_id: 'test-session-123' });
        return new Promise(resolve => {
          options.onChild({ kill: () => {
            resolve({ success: false, exitCode: 1, threadId: 'test-session-123', durationMs: 1, usage: null, error: 'interrupted' });
            return true;
          } });
          queueMicrotask(() => input.write('/switch advanced\n'));
        });
      }
      resumed = { choice, options };
      return { success: true, exitCode: 0, threadId: 'test-session-123', durationMs: 2, usage: { input_tokens: 12 }, error: null };
    };
    const result = await supervise(initial, {
      config, baseDir: os.tmpdir(), input, output, executeFn
    });
    assert.equal(result.success, true);
    assert.equal(result.switches, switchCount);
    assert.equal(result.attempts.length, 2);
    assert.equal(resumed.options.resumeThreadId, 'test-session-123');
    assert.equal(resumed.choice.model, expectedModel);
    assert.match(resumed.options.prompt, /Continue the original task/);
  });
}
