export interface AppConfig {
  password: string;
  outputDir: string;
  volumeSizeMB: number | null;
  enginePath: string;
  autoTest: boolean;
}

export interface FileEntry {
  path: string;
  size: number;
}

export interface ScanResult {
  files: FileEntry[];
  totalBytes: number;
  errors: string[];
}

export interface VolumePlan {
  totalBytes: number;
  volumeBytes: number;
  source: 'auto' | 'manual';
  reason: string;
  estimatedVolumes: number;
}

export type TestCategory = 'wrong-password' | 'missing-volume' | 'corrupt' | 'unknown';

export interface TestOutcome {
  status: 'passed' | 'failed';
  category: TestCategory | null;
  message: string;
  raw: string;
}

export interface TaskResult {
  archiveBase: string;
  volumes: string[];
  volumeCount: number;
  compression: 'success' | 'warning' | 'failed' | 'n/a';
  test: 'passed' | 'failed' | 'untested';
  testMessage: string;
  warnings: string[];
}

export type TaskPhase = 'waiting' | 'scanning' | 'compressing' | 'splitting' | 'testing' | 'done';

export interface TaskSnapshot {
  id: number;
  kind: 'compress' | 'test';
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  phase: TaskPhase;
  progress: number;
  log: string[];
  startedAt: number;
  finishedAt: number | null;
  fileCount: number;
  totalBytes: number;
  plan: VolumePlan | null;
  result: TaskResult | null;
  error: string | null;
}

export interface EngineInfo {
  path: string;
  version: string;
}