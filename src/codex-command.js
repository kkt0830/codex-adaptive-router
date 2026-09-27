import fs from 'node:fs';
import path from 'node:path';

function exists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function npmEntrypoint(shim) {
  const script = path.join(path.dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  return exists(script) ? script : null;
}

/** Resolve Windows npm command shims without a shell, so task/config values are never shell-interpreted. */
export function resolveCodexCommand(codex = 'codex', { platform = process.platform, env = process.env, cwd = process.cwd() } = {}) {
  if (platform !== 'win32') return { command: codex, argsPrefix: [] };

  const hasPath = path.isAbsolute(codex) || codex.includes('/') || codex.includes('\\');
  const candidates = hasPath ? [path.resolve(cwd, codex)] : [];
  if (!hasPath) {
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
    for (const directory of String(pathKey ? env[pathKey] : '').split(';').filter(Boolean)) {
      for (const extension of ['.exe', '.cmd']) candidates.push(path.join(directory, codex + extension));
    }
  }

  for (const candidate of candidates) {
    if (!exists(candidate)) continue;
    if (candidate.toLowerCase().endsWith('.cmd')) {
      const script = npmEntrypoint(candidate);
      if (script) return { command: process.execPath, argsPrefix: [script] };
      if (hasPath) throw new Error(`Unsupported Codex .cmd shim: ${candidate}. Pass a Codex .exe path instead.`);
      continue;
    }
    if (candidate.toLowerCase().endsWith('.exe')) return { command: candidate, argsPrefix: [] };
    if (candidate.toLowerCase().endsWith('.js')) return { command: process.execPath, argsPrefix: [candidate] };
  }
  throw new Error(`Codex CLI executable not found: ${codex}. Check codex --version and PATH.`);
}
