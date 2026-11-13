import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './types.ts';

export const DEFAULT_CONFIG: AppConfig = {
  password: '',
  outputDir: '',
  volumeSizeMB: null,
  enginePath: '',
  autoTest: true
};

export function loadConfig(configPath: string): AppConfig {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return sanitize(parsed);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function sanitize(input: Partial<AppConfig>): AppConfig {
  const volumeSizeMB =
    typeof input.volumeSizeMB === 'number' && Number.isFinite(input.volumeSizeMB) && input.volumeSizeMB >= 1 && input.volumeSizeMB <= 1048576
      ? Math.floor(input.volumeSizeMB)
      : null;
  return {
    password: typeof input.password === 'string' ? input.password : '',
    outputDir: typeof input.outputDir === 'string' ? input.outputDir : '',
    volumeSizeMB,
    enginePath: typeof input.enginePath === 'string' ? input.enginePath : '',
    autoTest: typeof input.autoTest === 'boolean' ? input.autoTest : true
  };
}

export function saveConfig(configPath: string, config: AppConfig): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmpPath, configPath);
}

export function mergeConfig(current: AppConfig, patch: Partial<AppConfig>): AppConfig {
  return sanitize({ ...current, ...patch });
}