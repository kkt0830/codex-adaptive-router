import readline from 'node:readline';
import { select } from './router.js';
import { checkModel, loadLocalCatalog } from './config.js';
import { appendLog, execute } from './execute.js';

export function continuationPrompt(originalTask, switched, automatic = false) {
  const situation = automatic ? 'after the previous model explicitly reported inability to complete it' : `after an intentional interruption${switched ? ' and approved model change' : ''}`;
  return `Continue the original task ${situation}. Original task: ${originalTask}\nInspect the current workspace and conversation state, avoid repeating completed edits, finish remaining work, and validate the result.`;
}

export function automaticEscalation(choice, result, config) {
  if (!config.routing?.escalation || result.success || result.error !== 'Agent reported inability to complete the task.') return null;
  const tiers = ['light', 'standard', 'advanced'];
  const next = tiers[tiers.indexOf(choice.tier) + 1];
  return next ? { type: 'switch', tier: next, automatic: true } : null;
}

export async function supervise(initialChoice, { config, baseDir, cwd, sandbox = 'workspace-write', input = process.stdin, output = process.stdout, codex = 'codex', executeFn = execute } = {}) {
  if (!input.isTTY) throw new Error('Interactive mode requires a terminal (TTY).');
  const rl = readline.createInterface({ input, output, terminal: true });
  let state = 'running';
  let child = null;
  let threadId = null;
  let request = null;
  let answer = null;
  let choice = initialChoice;
  let prompt = choice.task;
  let interrupted = false;
  let switches = 0;
  let automaticSwitches = 0;
  const attempts = [];

  function write(value) { output.write(value + '\n'); }
  rl.on('line', line => {
    const command = line.trim();
    if (state === 'approval') {
      answer?.(command.toLowerCase());
      answer = null;
      return;
    }
    if (state !== 'running') return;
    if (command === '/help') {
      write('Commands: /switch light|standard|advanced, /stop, /help');
      return;
    }
    if (command === '/stop') {
      request = { type: 'stop' };
      child?.kill('SIGINT');
      return;
    }
    const match = /^\/switch\s+(light|standard|advanced)$/i.exec(command);
    if (match) {
      const tier = match[1].toLowerCase();
      if (tier === choice.tier) { write(`Already using ${tier.toUpperCase()}.`); return; }
      if (!threadId) { write('Codex session has not started yet. Try again shortly.'); return; }
      request = { type: 'switch', tier };
      write(`Interrupting this turn to consider ${tier.toUpperCase()}...`);
      child?.kill('SIGINT');
      return;
    }
    write('Unknown command. Type /help.');
  });

  try {
    write(`Running ${choice.model} (${choice.reasoning}). Type /switch <tier> to interrupt and request approval, or /stop.`);
    while (true) {
      state = 'running';
      request = null;
      const result = await executeFn(choice, {
        cwd, codex, sandbox, resumeThreadId: threadId, prompt,
        onChild: process => { child = process; },
        onEvent: event => {
          if (event.type === 'thread.started' && event.thread_id) {
            threadId = event.thread_id;
            write(`Session started. /switch is ready.`);
          }
          if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) write(event.item.text);
        }
      });
      child = null;
      if (result.threadId) threadId = result.threadId;
      const action = request || (threadId ? automaticEscalation(choice, result, config) : null);
      attempts.push({
        timestamp: new Date().toISOString(), task: initialChoice.task,
        classification: initialChoice.analysis.classification, selectedTier: choice.tier,
        selectedModel: choice.model, selectedReasoning: choice.reasoning,
        interrupted: Boolean(request), automaticEscalationProposed: Boolean(action?.automatic), durationMs: result.durationMs, success: result.success,
        exitCode: result.exitCode, threadId, usage: result.usage, error: result.error
      });

      if (action && result.success) {
        write('The task completed before the interruption; no switch is needed.');
        break;
      }

      if (!action || action.type === 'stop') {
        interrupted = action?.type === 'stop';
        if (result.error && !action) write(`Codex error: ${result.error}`);
        break;
      }
      if (!threadId) {
        write('Cannot resume: Codex did not report a session ID.');
        break;
      }
      const proposed = select(initialChoice.task, config, { tier: action.tier });
      checkModel(proposed, loadLocalCatalog());
      state = 'approval';
      if (action.automatic) write('The model reported it could not complete the task. A higher tier may help.');
      write(`Proposed switch: ${choice.model} (${choice.reasoning}) → ${proposed.model} (${proposed.reasoning})`);
      write(`Reason for original classification: ${initialChoice.analysis.reason}`);
      output.write('Approve switch? [y/N; s to stop] ');
      const decision = await new Promise(resolve => { answer = resolve; });
      if (decision === 's' || decision === 'stop') { interrupted = true; break; }
      const approved = decision === 'y' || decision === 'yes';
      if (approved) {
        choice = proposed;
        switches++;
        if (action.automatic) automaticSwitches++;
        write(`Approved. Resuming session ${threadId} with ${choice.model}.`);
      } else if (action.automatic) {
        write('Automatic escalation declined. The task remains incomplete.');
        break;
      } else write(`Switch declined. Resuming session ${threadId} with ${choice.model}.`);
      prompt = continuationPrompt(initialChoice.task, approved, Boolean(action.automatic));
    }
  } finally {
    state = 'done';
    rl.close();
  }
  const logPath = appendLog(baseDir, config, {
    timestamp: new Date().toISOString(), task: initialChoice.task,
    classification: initialChoice.analysis.classification, initialModel: initialChoice.model,
    finalModel: choice.model, switchCount: switches, automaticEscalationCount: automaticSwitches, stoppedByUser: interrupted,
    attempts
  });
  write(`Log: ${logPath}`);
  return { success: !interrupted && attempts.at(-1)?.success === true, threadId, switches, automaticSwitches, attempts, logPath };
}
