import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { select } from './router.js';
import { checkModel, loadLocalCatalog } from './config.js';
import { appendLog, execute } from './execute.js';
import { validateResult, classifyFailure, decideRecovery, contextPrompt, handoffPrompt } from './recovery.js';

export function continuationPrompt(originalTask, switched, automatic = false) {
  const situation = automatic ? 'after the previous model explicitly reported inability to complete it' : `after an intentional interruption${switched ? ' and approved model change' : ''}`;
  return `Continue the original task ${situation}. Original task: ${originalTask}\nInspect the current workspace and conversation state, avoid repeating completed edits, finish remaining work, and validate the result.`;
}

export async function supervise(initialChoice, { config, baseDir, cwd, sandbox = 'workspace-write', input = process.stdin, output = process.stdout, codex = 'codex', executeFn = execute, interactive = true } = {}) {
  if (interactive && !input.isTTY) throw new Error('Interactive mode requires a terminal (TTY).');
  const rl = interactive ? readline.createInterface({ input, output, terminal: true }) : null;
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
  let finalMessage = '';
  const taskId = randomUUID();
  const attempts = [];

  function write(value) { output.write(value + '\n'); }
  rl?.on('line', line => {
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
  rl?.on('close', () => { answer?.('n'); answer = null; });

  try {
    write(`Running ${choice.model} (${choice.reasoning}).${interactive ? ' Type /switch <tier> to interrupt and request approval, or /stop.' : ''}`);
    while (true) {
      state = 'running';
      request = null;
      const result = await executeFn(choice, {
        cwd, codex, sandbox, resumeThreadId: threadId, prompt,
        onChild: process => { child = process; },
        onEvent: event => {
          if (event.type === 'thread.started' && event.thread_id) {
            threadId = event.thread_id;
            write(interactive ? 'Session started. /switch is ready.' : 'Session started.');
          }
          if (interactive && event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) write(event.item.text);
        }
      });
      child = null;
      finalMessage = result.finalMessage || '';
      if (result.threadId) threadId = result.threadId;
      const validation = validateResult(result);
      const failureClassification = classifyFailure(result, validation);
      const attempt = {
        taskId, attempt: attempts.length + 1, timestamp: new Date().toISOString(), task: initialChoice.task,
        classification: initialChoice.analysis.classification, selectedTier: choice.tier,
        selectedModel: choice.model, selectedReasoning: choice.reasoning,
        interrupted: Boolean(request), durationMs: result.durationMs, success: validation.status === 'SUCCESS',
        validation, failureClassification, exitCode: result.exitCode, threadId, usage: result.usage, error: result.error
      };
      attempts.push(attempt);
      const recovery = request ? null : decideRecovery({ choice, classification: failureClassification, validation, attempts, config });
      attempt.recoveryAction = request?.type === 'switch' ? 'MANUAL_SWITCH' : request?.type === 'stop' ? 'STOP' : recovery.action;
      attempt.recoveryReason = request ? 'User requested an interruption.' : recovery.reason;
      const action = request || (recovery.action === 'ESCALATE' ? { type: 'switch', tier: recovery.tier, automatic: true } : null);

      if (action && validation.status === 'SUCCESS') {
        write('The task completed before the interruption; no switch is needed.');
        break;
      }

      if (!action && (recovery.action === 'RETRY_SAME_MODEL' || recovery.action === 'EXPAND_CONTEXT')) {
        if (!threadId) { attempt.recoveryAction = 'STOP'; attempt.recoveryReason = 'Codex did not report a session ID.'; write('Cannot retry: Codex did not report a session ID.'); break; }
        write(`${failureClassification.category}: ${recovery.action}. Retrying ${choice.model} (${attempts.length}/${config.recovery?.maxTotalAttempts || 4}).`);
        prompt = contextPrompt(initialChoice.task, failureClassification, result);
        continue;
      }
      if (!action || action.type === 'stop') {
        interrupted = action?.type === 'stop';
        write(`Validation: ${validation.status}. ${recovery?.reason || ''}`);
        if (result.error && !action) write(`Codex error: ${result.error}`);
        break;
      }
      if (!threadId && !action.automatic) {
        attempt.recoveryAction = 'STOP'; attempt.recoveryReason = 'Codex did not report a session ID.';
        write('Cannot resume: Codex did not report a session ID.');
        break;
      }
      const proposed = select(initialChoice.task, config, { tier: action.tier });
      checkModel(proposed, loadLocalCatalog());
      state = 'approval';
      if (action.automatic) write(`Failure classified as ${failureClassification.category} (${failureClassification.confidence}). ${recovery.reason}`);
      write(`Proposed switch: ${choice.model} (${choice.reasoning}) → ${proposed.model} (${proposed.reasoning})`);
      write(`Reason for original classification: ${initialChoice.analysis.reason}`);
      if (!interactive) { attempt.recoveryReason = 'Switch proposed but interactive approval is unavailable.'; write('Switch requires interactive approval. Rerun with --interactive.'); break; }
      output.write('Approve switch? [y/N; s to stop] ');
      const decision = await new Promise(resolve => { answer = resolve; });
      if (decision === 's' || decision === 'stop') { interrupted = true; attempt.recoveryAction = 'STOP'; attempt.recoveryReason = 'User stopped at approval.'; break; }
      const approved = decision === 'y' || decision === 'yes';
      if (approved) {
        if (action.automatic) { attempt.escalatedFrom = choice.tier; attempt.escalatedTo = proposed.tier; }
        choice = proposed;
        switches++;
        if (action.automatic) automaticSwitches++;
        write(action.automatic ? `Approved. Starting a new session with ${choice.model} using a compact handoff.` : `Approved. Resuming session ${threadId} with ${choice.model}.`);
      } else if (action.automatic) {
        attempt.recoveryReason = 'User declined the proposed escalation.';
        write('Automatic escalation declined. The task remains incomplete.');
        break;
      } else write(`Switch declined. Resuming session ${threadId} with ${choice.model}.`);
      if (action.automatic && approved) {
        prompt = handoffPrompt(initialChoice.task, { tier: attempt.selectedTier, model: attempt.selectedModel }, failureClassification, recovery, result);
        threadId = null;
      } else prompt = continuationPrompt(initialChoice.task, approved, false);
    }
  } finally {
    state = 'done';
    rl?.close();
  }
  const logPath = appendLog(baseDir, config, {
    taskId, timestamp: new Date().toISOString(), task: initialChoice.task,
    classification: initialChoice.analysis.classification, initialModel: initialChoice.model,
    finalModel: choice.model, switchCount: switches, automaticEscalationCount: automaticSwitches, stoppedByUser: interrupted,
    attempts
  });
  write(`Log: ${logPath}`);
  return { success: !interrupted && attempts.at(-1)?.success === true, validation: attempts.at(-1)?.validation?.status, finalMessage, threadId, switches, automaticSwitches, attempts, logPath };
}
