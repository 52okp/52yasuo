import { describe, expect, it } from 'vitest';
import {
  MB,
  computeSplitChunks,
  computeVolumePlan,
  listVolumeFiles,
  resolveArchiveName,
  volumeFileName
} from '../src/volumes.ts';

describe('computeVolumePlan 自动阶梯', () => {
  it('小任务使用 16 MB 档', () => {
    const plan = computeVolumePlan(10 * MB, null);
    expect(plan.volumeBytes).toBe(16 * MB);
    expect(plan.source).toBe('auto');
    expect(plan.estimatedVolumes).toBe(1);
  });

  it('各档位边界正确', () => {
    expect(computeVolumePlan(128 * MB, null).volumeBytes).toBe(16 * MB);
    expect(computeVolumePlan(128 * MB + 1, null).volumeBytes).toBe(64 * MB);
    expect(computeVolumePlan(1024 * MB, null).volumeBytes).toBe(64 * MB);
    expect(computeVolumePlan(1024 * MB + 1, null).volumeBytes).toBe(256 * MB);
    expect(computeVolumePlan(8 * 1024 * MB, null).volumeBytes).toBe(256 * MB);
    expect(computeVolumePlan(8 * 1024 * MB + 1, null).volumeBytes).toBe(1024 * MB);
    expect(computeVolumePlan(64 * 1024 * MB, null).volumeBytes).toBe(1024 * MB);
    expect(computeVolumePlan(64 * 1024 * MB + 1, null).volumeBytes).toBe(4096 * MB);
  });

  it('手动覆盖优先于自动阶梯', () => {
    const plan = computeVolumePlan(10 * MB, 100);
    expect(plan.volumeBytes).toBe(100 * MB);
    expect(plan.source).toBe('manual');
    expect(plan.reason).toContain('手动');
  });

  it('预计卷数按源大小向上取整', () => {
    const plan = computeVolumePlan(40 * MB, 16);
    expect(plan.estimatedVolumes).toBe(3);
  });
});

describe('computeSplitChunks 至少两卷保证', () => {
  it('数据大于每卷容量时按容量切分', () => {
    expect(computeSplitChunks(1000, 600)).toEqual([600, 400]);
  });

  it('数据不足两卷时强制切成至少两份', () => {
    expect(computeSplitChunks(1000, 5000)).toEqual([500, 500]);
    expect(computeSplitChunks(1001, 5000)).toEqual([501, 500]);
    expect(computeSplitChunks(1, 5000)).toEqual([1]);
  });

  it('切分总和恒等于原大小', () => {
    for (const size of [1, 2, 999, 4096, 1234567]) {
      const chunks = computeSplitChunks(size, 4096);
      expect(chunks.reduce((a, b) => a + b, 0)).toBe(size);
      expect(chunks.length).toBeGreaterThanOrEqual(Math.min(2, size));
    }
  });

  it('非法输入抛出错误', () => {
    expect(() => computeSplitChunks(0, 100)).toThrow();
    expect(() => computeSplitChunks(100, 0)).toThrow();
    expect(() => computeSplitChunks(-1, 100)).toThrow();
  });
});

describe('分卷文件命名与识别', () => {
  it('生成标准 .001 命名', () => {
    expect(volumeFileName('X:\\out\\a.7z', 0)).toBe('X:\\out\\a.7z.001');
    expect(volumeFileName('X:\\out\\a.7z', 11)).toBe('X:\\out\\a.7z.012');
  });

  it('只识别匹配的分卷并按序号排序', () => {
    const entries = ['a.7z.002', 'a.7z.001', 'a.7z.010', 'b.7z.001', 'a.7z', 'a.7z.txt', 'a.7z.003.tmp'];
    expect(listVolumeFiles(entries, 'a')).toEqual(['a.7z.001', 'a.7z.002', 'a.7z.010']);
  });

  it('名称含正则特殊字符时安全匹配', () => {
    expect(listVolumeFiles(['my+(1).7z.001', 'myX1.7z.001'], 'my+(1)')).toEqual(['my+(1).7z.001']);
  });
});

describe('resolveArchiveName 重名自动编号', () => {
  it('无冲突时保留原名', () => {
    expect(resolveArchiveName([], 'data')).toBe('data');
  });

  it('已有分卷时自动编号且不覆盖', () => {
    expect(resolveArchiveName(['data.7z.001', 'data.7z.002'], 'data')).toBe('data (2)');
    expect(resolveArchiveName(['data.7z.001', 'data (2).7z.001'], 'data')).toBe('data (3)');
  });

  it('已有单卷 7z 时也视为冲突', () => {
    expect(resolveArchiveName(['data.7z'], 'data')).toBe('data (2)');
  });

  it('大小写不敏感（Windows 文件系统）', () => {
    expect(resolveArchiveName(['DATA.7z.001'], 'data')).toBe('data (2)');
  });
});

describe('大批量与非法容量', () => {
  it('识别四位分卷编号且参与重名检查', () => {
    expect(listVolumeFiles(['a.7z.1000', 'a.7z.999'], 'a')).toEqual(['a.7z.999', 'a.7z.1000']);
    expect(resolveArchiveName(['a.7z.1000'], 'a')).toBe('a (2)');
  });
  it('拒绝小数、无限值及越界容量', () => {
    for (const value of [0.5, 1.5, Infinity, NaN, -1, 1048577]) {
      expect(() => computeVolumePlan(100, value)).toThrow();
    }
  });
});


describe('按计划卷数计算容量', () => {
  it('500 MB 默认每卷64 MB、预计8卷，选择2卷后每卷250 MB', () => {
    expect(computeVolumePlan(500 * MB, null).estimatedVolumes).toBe(8);
    expect(computeVolumePlan(500 * MB, null, 2).volumeBytes).toBe(250 * MB);
    expect(computeVolumePlan(500 * MB, null, 3).volumeBytes).toBe(Math.ceil(500 * MB / 3));
  });
  it('卷数优先于保存的容量，重新按实际总大小计算', () => {
    expect(computeVolumePlan(500 * MB, 64, 2).volumeBytes).toBe(250 * MB);
    expect(computeVolumePlan(600 * MB, 64, 2).volumeBytes).toBe(300 * MB);
  });
  it('极小文件每卷至少1 KB，不产生零容量', () => {
    expect(computeVolumePlan(0, null, 2).volumeBytes).toBe(1024);
    expect(computeVolumePlan(18, null, 10000).volumeBytes).toBe(1024);
  });
  it('拒绝非法卷数和非整数总大小', () => {
    for (const count of [0, 1, -1, 2.5, 10001, Infinity, NaN]) {
      expect(() => computeVolumePlan(500 * MB, null, count)).toThrow();
    }
    expect(() => computeVolumePlan(0.1, null, 2)).toThrow();
  });
});
