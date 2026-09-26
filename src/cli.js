#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, select } from './router.js';
import { loadConfig, loadLocalCatalog, checkModel } from './config.js';
import { appendLog, execute } from './execute.js';
import { supervise } from './supervisor.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const help = `Usage: node src/cli.js <dry-run|explain|run> [options] "task"
Options: --config FILE --tier auto|light|standard|advanced --model ID --reasoning LEVEL --cwd DIR --json
run also accepts --sandbox read-only|workspace-write (default: workspace-write).
Use run --interactive in a terminal to interrupt with /switch TIER, approve the change, and resume the same session.
dry-run never calls Codex. run starts a new Codex exec session and records its JSON usage when provided.`;

function parse(argv) {
  const [command, ...rest] = argv;
  if (!['dry-run', 'explain', 'run'].includes(command)) throw new Error(help);
  const opts = {};
  const task = [];
  const known = new Set(['config', 'tier', 'model', 'reasoning', 'cwd', 'sandbox']);
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i];
    if (value === '--json') opts.json = true;
    else if (value === '--interactive') opts.interactive = true;
    else if (value.startsWith('--')) {
      const key = value.slice(2);
      if (!known.has(key) || !rest[i + 1]) throw new Error(`Invalid option: ${value}`);
      opts[key] = rest[++i];
    } else task.push(value);
  }
  if (!task.length) throw new Error(help);
  if (opts.sandbox && !['read-only', 'workspace-write'].includes(opts.sandbox)) throw new Error('Invalid sandbox');
  if (opts.interactive && command !== 'run') throw new Error('--interactive is only valid for run');
  if (opts.interactive && opts.json) throw new Error('--interactive and --json cannot be combined');
  return { command, opts, task: task.join(' ') };
}

function printChoice(choice, warning, json) {
  if (json) return console.log(JSON.stringify({ ...choice, warning }, null, 2));
  console.log(`Classification: ${choice.analysis.classification.toUpperCase()}`);
  console.log(`Dimensions: ${JSON.stringify(choice.analysis.dimensions)}`);
  console.log(`Selected: ${choice.tier.toUpperCase()} → ${choice.model} (${choice.reasoning})`);
  console.log(`Reason: ${choice.analysis.reason}`);
  console.log(`Escalation: ${choice.escalationExpected}`);
  if (warning) console.log(`Catalog: ${warning}`);
}

export async function main(argv) {
  const { command, opts, task } = parse(argv);
  const { config, baseDir } = loadConfig(opts.config || path.join(root, 'config.json'));
  const choice = select(task, config, opts);
  const warning = checkModel(choice, loadLocalCatalog());
  printChoice(choice, warning, opts.json);
  if (command === 'dry-run' || command === 'explain') return 0;
  if (opts.interactive) {
    const result = await supervise(choice, { config, baseDir, cwd: opts.cwd, sandbox: opts.sandbox });
    return result.success ? 0 : 1;
  }
  const result = await execute(choice, { cwd: opts.cwd, sandbox: opts.sandbox });
  const logPath = appendLog(baseDir, config, {
    timestamp: new Date().toISOString(), task, classification: choice.analysis.classification,
    selectedTier: choice.tier, selectedModel: choice.model, selectedReasoning: choice.reasoning,
    override: choice.override, escalation: false, durationMs: result.durationMs,
    success: result.success, exitCode: result.exitCode, threadId: result.threadId, usage: result.usage,
    error: result.error
  });
  if (!opts.json) {
    if (result.finalMessage) console.log(`\n${result.finalMessage}`);
    console.log(`Log: ${logPath}`);
    if (result.error) console.error(result.error);
  } else console.log(JSON.stringify({ execution: result, logPath }, null, 2));
  return result.success ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
