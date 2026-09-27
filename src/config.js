import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { recoveryLimits } from './recovery.js';

export function loadConfig(file) {
  const full = path.resolve(file);
  const config = JSON.parse(fs.readFileSync(full, 'utf8'));
  for (const tier of ['light', 'standard', 'advanced']) {
    if (!config.models?.[tier]?.model || !config.models?.[tier]?.reasoning) {
      throw new Error(`config: models.${tier} needs model and reasoning`);
    }
  }
  recoveryLimits(config);
  return { config, baseDir: path.dirname(full) };
}

export function loadLocalCatalog() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const file = path.join(home, 'models_cache.json');
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { fetchedAt: data.fetched_at || null, models: data.models || [] };
  } catch {
    return null;
  }
}

export function checkModel(choice, catalog) {
  if (!catalog) return 'Local model catalog unavailable; model access will be checked by Codex at execution.';
  const entry = catalog.models.find(m => m.slug === choice.model);
  if (!entry) throw new Error(`Model ${choice.model} is not in the local Codex catalog.`);
  const efforts = entry.supported_reasoning_levels?.map(e => e.effort) || [];
  if (!efforts.includes(choice.reasoning)) {
    throw new Error(`Reasoning ${choice.reasoning} is not listed for ${choice.model}. Supported: ${efforts.join(', ')}`);
  }
  return null;
}
