import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function appendLog(baseDir, config, entry) {
  const target = path.resolve(baseDir, config.logging?.path || 'logs/runs.jsonl');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, JSON.stringify(entry) + '\n', 'utf8');
  return target;
}

export async function execute(choice, { cwd, codex = 'codex', sandbox = 'workspace-write', resumeThreadId = null, prompt = choice.task, onChild, onEvent } = {}) {
  const args = resumeThreadId
    ? ['exec', 'resume', '--model', choice.model, '--config', `model_reasoning_effort="${choice.reasoning}"`, '--config', `sandbox_mode="${sandbox}"`, '--json', '--skip-git-repo-check', resumeThreadId, '-']
    : ['exec', '--model', choice.model, '--config', `model_reasoning_effort="${choice.reasoning}"`, '--sandbox', sandbox, '--json', '--cd', path.resolve(cwd || process.cwd()), '--skip-git-repo-check', '-'];
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const home = os.homedir();
    const env = { ...process.env, HOME: process.env.HOME || home, CODEX_HOME: process.env.CODEX_HOME || path.join(home, '.codex') };
    const child = spawn(codex, args, { cwd: cwd || process.cwd(), env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    onChild?.(child);
    let buffer = '';
    let stderr = '';
    let usage = null;
    let finalMessage = '';
    let threadId = null;
    let failure = null;
    child.on('error', error => resolve({
      success: false, exitCode: null, threadId: null,
      durationMs: Date.now() - started, usage: null, finalMessage: '', error: error.message
    }));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          onEvent?.(event);
          if (event.type === 'thread.started') threadId = event.thread_id;
          if (event.type === 'turn.completed' && event.usage) usage = event.usage;
          if (event.type === 'turn.failed') failure = typeof event.error === 'string' ? event.error : JSON.stringify(event.error || 'turn failed');
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') finalMessage = event.item.text || finalMessage;
        } catch { /* Ignore non-JSON diagnostics, never invent usage. */ }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.on('close', code => resolve({
      success: code === 0 && !failure, exitCode: code, threadId,
      durationMs: Date.now() - started, usage, finalMessage,
      error: failure || (code === 0 ? null : stderr.trim() || `Codex exited ${code}`)
    }));
  });
}
