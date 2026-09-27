const TIERS = ['light', 'standard', 'advanced'];
const MAX_TEXT = 1600;

function clip(value, limit = MAX_TEXT) { return String(value || '').slice(-limit); }
function evidenceText(result) {
  return [result.error, result.stderr, ...(result.commands || []).flatMap(c => [c.command, c.output]), result.finalMessage].filter(Boolean).join('\n');
}
function failedCommands(result) { return (result.commands || []).filter(c => Number.isInteger(c.exitCode) && c.exitCode !== 0); }
function validationKind(command) {
  if (/\b(test|pytest|jest|vitest)\b/i.test(command || '')) return 'test';
  if (/\b(build|tsc)\b/i.test(command || '')) return 'build';
  if (/\blint\b/i.test(command || '')) return 'lint';
  return null;
}

export function validateResult(result) {
  const commands = result.commands || [];
  const latestChecks = new Map();
  for (const command of commands) if (validationKind(command.command)) latestChecks.set(validationKind(command.command), command);
  const lastSuccessfulCheck = commands.findLastIndex(c => validationKind(c.command) && c.exitCode === 0);
  const failed = failedCommands(result).filter(c => validationKind(c.command) ? latestChecks.get(validationKind(c.command)) === c : commands.indexOf(c) > lastSuccessfulCheck);
  if (result.exitCode !== 0 || result.turnFailed || failed.length || result.error) {
    return { status: 'FAILURE', reason: result.error || (failed.length ? `Command failed: ${clip(failed.at(-1).command, 200)}` : `Codex exited ${result.exitCode}`), evidence: failed.map(c => ({ command: c.command, exitCode: c.exitCode })) };
  }
  const checked = [...latestChecks.values()].filter(c => c.exitCode === 0);
  if (checked.length) return { status: 'SUCCESS', reason: 'Validation command completed successfully.', evidence: checked.map(c => ({ command: c.command, exitCode: 0 })) };
  return { status: 'UNCERTAIN', reason: 'Codex completed without a recorded test, build, or lint result.', evidence: [] };
}

export function classifyFailure(result, validation) {
  if (validation.status !== 'FAILURE') return null;
  const text = evidenceText(result);
  const rules = [
    ['PERMISSION_ERROR', /permission denied|access denied|access is denied|readonly database|read-only database|\bEACCES\b|\bEPERM\b|unauthorized|forbidden|액세스.{0,12}거부|권한.{0,12}(없|거부|부족)/i, .95, 'Access was denied.'],
    ['DEPENDENCY_ERROR', /cannot find module|module not found|package .* not found|missing dependency|dependency conflict|\bERESOLVE\b|sdk.{0,30}(missing|not installed)|패키지.{0,20}(없|누락)/i, .9, 'A required package or module is missing.'],
    ['ENVIRONMENT_ERROR', /network unavailable|\bENETUNREACH\b|\bECONNREFUSED\b|compiler (not found|not installed)|command not found|\bENOENT\b|tool.{0,40}(unavailable|not available)|(?:cannot|can't|unable to|no access to).{0,100}(?:read|access).{0,40}(?:file|repository|repo)|도구.{0,40}(없|제공되지|사용할 수 없)|파일.{0,40}(읽|접근).{0,40}(못|불가|없)/i, .9, 'An environment or tool is unavailable.'],
    ['CONTEXT_INSUFFICIENT', /interface.{0,70}(not (read|checked|found)|missing|unknown)|need to (inspect|read|see).{0,80}(interface|config|module)|관련.{0,20}(인터페이스|설정|모듈).{0,30}(확인|읽).{0,20}(못|필요)/i, .8, 'A referenced interface or module was not inspected.'],
    ['ARCHITECTURE_PROBLEM', /architecture.{0,70}(conflict|incompatible|redesign)|structural (conflict|problem)|아키텍처.{0,30}(충돌|문제|재설계)/i, .85, 'The failure concerns the existing architecture.'],
    ['REASONING_INSUFFICIENT', /reasoning (insufficient|failed)|complex logic.{0,60}(failed|incorrect)|추론.{0,20}(부족|실패)/i, .8, 'The attempted reasoning did not resolve the problem.'],
    ['CODE_ERROR', /syntaxerror|syntax error|type error|typeerror|invalid import|unexpected token|구문 오류|타입 오류/i, .95, 'The code has a concrete syntax or type error.'],
    ['TEST_FAILURE', /tests? failed|failed tests?|assertionerror|assertion failed|\bFAIL\b.{0,80}\btest\b|테스트.{0,20}실패/i, .85, 'A test failed after execution.']
  ];
  for (const [category, pattern, confidence, reason] of rules) if (pattern.test(text)) return { category, confidence, reason };
  if (failedCommands(result).some(c => /\b(test|pytest|jest|vitest)\b/i.test(c.command || '') && c.exitCode !== 0)) return { category: 'TEST_FAILURE', confidence: .85, reason: 'A recorded test command failed.' };
  return { category: 'UNKNOWN', confidence: .3, reason: 'No reliable failure signature was found.' };
}

export function recoveryLimits(config) {
  const defaults = { maxRetriesPerTier: 1, maxEscalations: 2, maxTotalAttempts: 4, escalationConfidence: .75 };
  const limits = { ...defaults, ...config.recovery };
  for (const key of ['maxRetriesPerTier', 'maxEscalations', 'maxTotalAttempts']) {
    if (!Number.isInteger(limits[key]) || limits[key] < 0 || (key === 'maxTotalAttempts' && limits[key] < 1)) throw new Error(`Invalid recovery.${key}`);
  }
  if (typeof limits.escalationConfidence !== 'number' || limits.escalationConfidence < 0 || limits.escalationConfidence > 1) throw new Error('Invalid recovery.escalationConfidence');
  for (const action of Object.values(config.recovery?.strategies || {})) if (!['STOP', 'RETRY_SAME_MODEL', 'EXPAND_CONTEXT', 'ESCALATE'].includes(action)) throw new Error(`Invalid recovery strategy: ${action}`);
  return limits;
}

export function decideRecovery({ choice, classification, validation, attempts, config }) {
  const limits = recoveryLimits(config);
  if (validation.status !== 'FAILURE') return { action: 'STOP', reason: validation.status === 'SUCCESS' ? 'Validated success.' : 'Outcome uncertain; human review required.' };
  if (attempts.length >= limits.maxTotalAttempts) return { action: 'STOP', reason: 'Total attempt limit reached.' };
  const category = classification.category;
  const tierAttempts = attempts.filter(a => a.selectedTier === choice.tier).length;
  const retries = Math.max(0, tierAttempts - 1);
  const escalations = attempts.filter(a => a.escalatedTo).length;
  const nextTier = TIERS[TIERS.indexOf(choice.tier) + 1];
  const policy = config.recovery?.strategies?.[category] || ({
    CODE_ERROR: 'RETRY_SAME_MODEL', CONTEXT_INSUFFICIENT: 'EXPAND_CONTEXT',
    REASONING_INSUFFICIENT: 'ESCALATE', ENVIRONMENT_ERROR: 'STOP',
    DEPENDENCY_ERROR: 'STOP', PERMISSION_ERROR: 'STOP', TEST_FAILURE: 'RETRY_SAME_MODEL',
    ARCHITECTURE_PROBLEM: 'ESCALATE', UNKNOWN: 'RETRY_SAME_MODEL'
  })[category];
  if (['ENVIRONMENT_ERROR', 'DEPENDENCY_ERROR', 'PERMISSION_ERROR'].includes(category)) return { action: 'STOP', reason: `${category} is not solved by a stronger model.` };
  if (category === 'UNKNOWN' && retries >= limits.maxRetriesPerTier) return { action: 'STOP', reason: 'Repeated unknown failures do not justify escalation.' };
  if (category === 'CONTEXT_INSUFFICIENT' && retries === 0) return retries < limits.maxRetriesPerTier ? { action: 'EXPAND_CONTEXT', tier: choice.tier, reason: 'Inspect relevant context before considering escalation.' } : { action: 'STOP', reason: 'Context expansion retry is disabled.' };
  if (policy === 'STOP') return { action: 'STOP', reason: `${category} is not solved by a stronger model.` };
  if ((policy === 'RETRY_SAME_MODEL' || policy === 'EXPAND_CONTEXT') && retries < limits.maxRetriesPerTier) {
    return { action: policy, tier: choice.tier, reason: `Retry ${category} with the current model.` };
  }
  if (!config.routing?.escalation || !nextTier || escalations >= limits.maxEscalations) return { action: 'STOP', reason: 'No eligible higher tier or escalation limit reached.' };
  const repeated = retries >= limits.maxRetriesPerTier && category === 'CODE_ERROR';
  if ((policy !== 'ESCALATE' && !repeated) || classification.confidence < limits.escalationConfidence) return { action: 'STOP', reason: 'Insufficient evidence for escalation.' };
  return { action: 'ESCALATE', tier: nextTier, reason: repeated ? `Repeated ${category} after a bounded retry.` : classification.reason };
}

export function contextPrompt(task, classification, result) {
  const lastFailure = failedCommands(result).at(-1);
  return `Continue this task with the same model: ${task}\nPrevious failure: ${classification.category}: ${clip(result.error || lastFailure?.output || lastFailure?.command)}\nInspect only relevant interfaces, adjacent modules, configuration, and tests. Exclude generated files, build output, and lock files unless needed. Fix the remaining problem and run targeted validation.`;
}

export function handoffPrompt(task, choice, classification, decision, result) {
  const commands = (result.commands || []).slice(-5);
  const files = [...new Set((evidenceText(result).match(/(?:[\w.-]+[\\/])+[\w.-]+\.[\w]+/g) || []).filter(p => !/node_modules|\.lock$|dist[\\/]|build[\\/]/i.test(p)))].slice(0, 10);
  return [
    'Continue the task in this workspace. This is a new Codex session; inspect the current files and git diff before editing.',
    `Original Task: ${clip(task, 3000)}`, `Previous Tier / Model: ${choice.tier.toUpperCase()} / ${choice.model}`,
    `Relevant Files: ${files.join(', ') || 'Not observed; discover narrowly from the task.'}`,
    'Changes Attempted: Inspect git diff; structured edit history was not available.',
    `Commands Executed: ${commands.map(c => `${clip(c.command, 180)} (exit ${c.exitCode})`).join('; ') || 'Not recorded.'}`,
    `Observed Errors: ${clip(result.error || commands.filter(c => c.exitCode !== 0).map(c => c.output).join('\n')) || 'Not recorded.'}`,
    `Tests / Build Results: ${commands.filter(c => /\b(test|pytest|jest|vitest|build|lint|tsc)\b/i.test(c.command)).map(c => `${clip(c.command, 180)} (exit ${c.exitCode})`).join('; ') || 'Not recorded.'}`,
    `Important Findings: ${clip(result.finalMessage, 500) || 'Not recorded.'}`,
    `Failure Classification: ${classification.category} (${classification.confidence})`,
    `Reason for Escalation: ${decision.reason}`,
    `Remaining Problem: ${clip(task, 1000)}. Validate the result with relevant tests or build.`
  ].join('\n');
}
