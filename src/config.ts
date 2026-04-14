import fs from 'fs';
import path from 'path';
import type { ProbeConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

/**
 * Load config from .probe/config.json, deep-merged with defaults.
 * Returns DEFAULT_CONFIG if no config file exists.
 */
export function loadConfig(root: string): ProbeConfig {
  const configPath = path.join(root, '.probe', 'config.json');
  if (!fs.existsSync(configPath)) return { ...DEFAULT_CONFIG };

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const userConfig = JSON.parse(raw);
    return deepMerge(DEFAULT_CONFIG, userConfig);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Write default config to .probe/config.json.
 */
export function writeDefaultConfig(root: string): string {
  const probeDir = path.join(root, '.probe');
  if (!fs.existsSync(probeDir)) {
    fs.mkdirSync(probeDir, { recursive: true });
  }

  const configPath = path.join(probeDir, 'config.json');
  const content = JSON.stringify(DEFAULT_CONFIG, null, 2);
  fs.writeFileSync(configPath, content, 'utf-8');
  return configPath;
}

/**
 * Deep merge: source values override target values.
 * Arrays are replaced, not concatenated.
 */
function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key of Object.keys(source) as Array<keyof T>) {
    const val = source[key];
    if (val === undefined) continue;

    if (
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key] as any, val as any);
    } else {
      result[key] = val as T[keyof T];
    }
  }

  return result;
}
