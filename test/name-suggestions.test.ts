import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
const context = vm.createContext({});
vm.runInContext(fs.readFileSync('public/name-suggestions.js', 'utf8'), context);
const suggest = context.archiveNameSuggestions as (name: string) => { original: string; names: string[] };

describe('名称关键词提取', () => {
  it('提取作者与编号组合、编号和主题，过滤张数及容量', () => {
    const { names } = suggest('X:\\作品\\屿鱼_No_092_碧蓝航线·安克雷奇（泳装·皮肤）38P_507MB.7z.001');
    expect(names[0]).toBe('屿鱼_No_092');
    for (const value of ['No_092', '屿鱼', '碧蓝航线', '安克雷奇', '泳装', '皮肤']) expect(names).toContain(value);
    expect(names.some(name => /38P|507MB|\.7z/.test(name))).toBe(false);
  });
  it('识别 No.、No空格和No连字符，保留前导零', () => {
    for (const number of ['No.092', 'no 092', 'NO-092', 'No092']) {
      expect(suggest(`作者_${number}_主题_20P_1.5GB`).names).toContain('作者_No_092');
    }
  });
  it('无编号可选择原名称或关键词，名称不重复', () => {
    expect(suggest('X:\\作品\\风景_海边\\').names).toEqual(['风景_海边', '风景', '海边']);
    expect(suggest('作者_作者.zip').names).toEqual(['作者_作者', '作者']);
  });
});
