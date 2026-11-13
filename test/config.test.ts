import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, mergeConfig, sanitize, saveConfig } from '../src/config.ts';

const tempDirs: string[] = [];

function tempConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compress-config-'));
  tempDirs.push(dir);
  return path.join(dir, 'config.json');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('配置持久化', () => {
  it('配置文件不存在时返回默认值', () => {
    const config = loadConfig(path.join(os.tmpdir(), `missing-${Date.now()}.json`));
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(config.autoTest).toBe(true);
  });

  it('保存后重启加载能恢复密码（密码记忆）', () => {
    const configPath = tempConfigPath();
    const config = { ...DEFAULT_CONFIG, password: '我的密码P@ss123', outputDir: 'X:\\out' };
    saveConfig(configPath, config);
    const loaded = loadConfig(configPath);
    expect(loaded.password).toBe('我的密码P@ss123');
    expect(loaded.outputDir).toBe('X:\\out');
  });

  it('密码以明文保存，不做额外加密', () => {
    const configPath = tempConfigPath();
    saveConfig(configPath, { ...DEFAULT_CONFIG, password: 'plain-secret-42' });
    const raw = fs.readFileSync(configPath, 'utf8');
    expect(raw).toContain('plain-secret-42');
    expect(JSON.parse(raw).password).toBe('plain-secret-42');
  });

  it('修改密码后新配置生效，旧值被替换', () => {
    const configPath = tempConfigPath();
    saveConfig(configPath, { ...DEFAULT_CONFIG, password: 'old-pass' });
    const merged = mergeConfig(loadConfig(configPath), { password: 'new-pass' });
    saveConfig(configPath, merged);
    expect(loadConfig(configPath).password).toBe('new-pass');
    expect(merged.outputDir).toBe(DEFAULT_CONFIG.outputDir);
  });

  it('损坏的配置文件回退为默认值', () => {
    const configPath = tempConfigPath();
    fs.writeFileSync(configPath, '{broken json');
    expect(loadConfig(configPath)).toEqual(DEFAULT_CONFIG);
  });
});

describe('sanitize 输入校验', () => {
  it('非法字段回退默认', () => {
    const result = sanitize({ volumeSizeMB: -5, autoTest: 'yes' } as never);
    expect(result.volumeSizeMB).toBeNull();
    expect(result.autoTest).toBe(true);
  });

  it('合法分卷覆盖值向下取整', () => {
    expect(sanitize({ volumeSizeMB: 64.9 }).volumeSizeMB).toBe(64);
  });
});