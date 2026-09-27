import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCodexCommand } from '../src/codex-command.js';
import { execute } from '../src/execute.js';

function fakeNpmInstall(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-router-shim-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const shim = path.join(directory, 'codex.cmd');
  const script = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(shim, '@echo off\r\n');
  fs.writeFileSync(script, `process.stdin.resume();
process.stdin.on('end', () => {
  for (const event of [
    { type: 'thread.started', thread_id: 'shim-session' },
    { type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 0, aggregated_output: 'pass' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Tests passed.' } },
    { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 3 } }
  ]) process.stdout.write(JSON.stringify(event) + '\\n');
});
`);
  return { directory, shim, script };
}

test('Windows npm .cmd shim resolves to its Node entrypoint without a shell', t => {
  const { directory, script } = fakeNpmInstall(t);
  const invocation = resolveCodexCommand('codex', { platform: 'win32', env: { Path: directory } });
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.argsPrefix, [script]);
});

test('explicit Windows executable remains a direct process launch', t => {
  const { directory } = fakeNpmInstall(t);
  const executable = path.join(directory, 'codex.exe');
  fs.writeFileSync(executable, '');
  assert.deepEqual(resolveCodexCommand(executable, { platform: 'win32' }), { command: executable, argsPrefix: [] });
});

test('execute runs an explicit npm Codex shim through Node and parses JSON events', async t => {
  const { directory, shim } = fakeNpmInstall(t);
  const result = await execute({ model: 'test-model', reasoning: 'low', task: 'run tests' }, { codex: shim, cwd: directory });
  assert.equal(result.success, true);
  assert.equal(result.threadId, 'shim-session');
  assert.equal(result.commands[0].exitCode, 0);
  assert.equal(result.finalMessage, 'Tests passed.');
});
