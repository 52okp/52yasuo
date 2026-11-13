import type { VolumePlan } from './types.ts';

export const MB = 1024 * 1024;

export interface VolumeTier {
  maxTotalBytes: number;
  volumeMB: number;
  label: string;
}

export const VOLUME_TIERS: VolumeTier[] = [
  { maxTotalBytes: 128 * MB, volumeMB: 16, label: '总大小 ≤ 128 MB' },
  { maxTotalBytes: 1024 * MB, volumeMB: 64, label: '总大小 ≤ 1 GB' },
  { maxTotalBytes: 8 * 1024 * MB, volumeMB: 256, label: '总大小 ≤ 8 GB' },
  { maxTotalBytes: 64 * 1024 * MB, volumeMB: 1024, label: '总大小 ≤ 64 GB' }
];

export const FALLBACK_VOLUME_MB = 4096;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 'B';
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

export function computeVolumePlan(totalBytes: number, overrideMB: number | null, targetVolumes: number | null = null): VolumePlan {
  if (overrideMB !== null && (!Number.isSafeInteger(overrideMB) || overrideMB < 1 || overrideMB > 1048576)) {
    throw new Error('每卷容量必须是 1 至 1048576 之间的整数（MB）');
  }
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) throw new Error('文件总大小必须是非负安全整数');
  if (targetVolumes !== null) {
    if (!Number.isSafeInteger(targetVolumes) || targetVolumes < 2 || targetVolumes > 10000) {
      throw new Error('计划卷数必须是 2 至 10000 之间的整数');
    }
    const volumeBytes = Math.max(1024, Math.ceil(totalBytes / targetVolumes));
    return {
      totalBytes, volumeBytes, source: 'manual',
      reason: `按源文件大小计划 ${targetVolumes} 卷，自动计算每卷容量（最低 1 KB）`,
      estimatedVolumes: Math.max(2, Math.ceil(totalBytes / volumeBytes))
    };
  }
  let volumeMB: number;
  let source: 'auto' | 'manual';
  let reason: string;

  if (overrideMB !== null && overrideMB > 0) {
    volumeMB = Math.floor(overrideMB);
    source = 'manual';
    reason = `手动指定每卷 ${volumeMB} MB`;
  } else {
    const tier = VOLUME_TIERS.find((t) => totalBytes <= t.maxTotalBytes);
    if (tier) {
      volumeMB = tier.volumeMB;
      reason = `自动阶梯：${tier.label} → 每卷 ${volumeMB} MB`;
    } else {
      volumeMB = FALLBACK_VOLUME_MB;
      reason = `自动阶梯：总大小 > 64 GB → 每卷 ${FALLBACK_VOLUME_MB} MB`;
    }
    source = 'auto';
  }

  const volumeBytes = volumeMB * MB;
  const estimatedVolumes = Math.max(1, Math.ceil(totalBytes / volumeBytes));
  return { totalBytes, volumeBytes, source, reason, estimatedVolumes };
}

/**
 * 7z 分卷是归档字节流的纯切分。当 7-Zip 只产出一个卷时，
 * 用该函数把实际压缩结果切成至少 minParts 份，保证最小卷数要求。
 */
export function computeSplitChunks(totalSize: number, preferredBytes: number, minParts = 2): number[] {
  if (!Number.isInteger(totalSize) || totalSize <= 0) {
    throw new Error('切分大小必须为正整数');
  }
  if (!Number.isInteger(preferredBytes) || preferredBytes <= 0) {
    throw new Error('每卷容量必须为正整数');
  }
  let chunkSize = preferredBytes;
  if (Math.ceil(totalSize / chunkSize) < minParts) {
    chunkSize = Math.ceil(totalSize / minParts);
  }
  const chunks: number[] = [];
  let remaining = totalSize;
  while (remaining > 0) {
    const size = Math.min(chunkSize, remaining);
    chunks.push(size);
    remaining -= size;
  }
  return chunks;
}

export function volumeFileName(archiveBase: string, index: number): string {
  return `${archiveBase}.${String(index + 1).padStart(3, '0')}`;
}

export function listVolumeFiles(dirEntries: string[], archiveName: string): string[] {
  const pattern = new RegExp(`^${escapeRegExp(archiveName)}\\.7z\\.(\\d{3,})$`, 'i');
  return dirEntries
    .filter((name) => pattern.test(name))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 输出重名时自动编号：name -> name (2) -> name (3)，不静默覆盖。 */
export function resolveArchiveName(dirEntries: string[], desiredName: string): string {
  const taken = new Set(dirEntries.map((n) => n.toLowerCase()));
  const isTaken = (name: string) =>
    taken.has(`${name}.7z`.toLowerCase()) ||
    dirEntries.some((n) => new RegExp(`^${escapeRegExp(name)}\\.7z\\.\\d{3,}$`, 'i').test(n));
  if (!isTaken(desiredName)) return desiredName;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${desiredName} (${i})`;
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error('输出目录重名文件过多，无法自动编号');
}