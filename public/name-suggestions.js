/* 从文件或文件夹名称提取候选，不覆盖用户正在编辑的名称。 */
globalThis.archiveNameSuggestions = function (source) {
  const original = source.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  const stem = original.replace(/\.(?:7z(?:\.\d{3,})?|zip(?:\.\d{3,})?|rar|tar(?:\.gz)?|gz|bz2|xz|jpg|jpeg|png|webp|gif|mp4|mkv|pdf|txt)$/i, '');
  // 移除图片数量和容量，保留作品编号及其前导零。
  const cleaned = stem
    .replace(/(^|[_\s·（）()\[\]【】-])\d+(?:\.\d+)?\s*(?:[KMGT]i?B|[PV]|张|图)(?=$|[_\s·）)\]】-])/gi, '$1')
    .replace(/(^|[_\s·-])no[._\s-]*(\d+)(?=$|[_\s·（(\[【-])/gi, '$1No_$2')
    .replace(/[_\s-]+$/g, '').replace(/^[_\s-]+/g, '')
    .replace(/_{2,}/g, '_').replace(/[（(]\s*[）)]/g, '').trim();
  const match = /(?:^|[_\s·-])(No_\d+)(?=$|[_\s·（(\[【-])/i.exec(cleaned);
  const result = [];
  const seen = new Set();
  const add = (value) => {
    const name = value.replace(/[\\/:*?"<>|]/g, '_').replace(/[. ]+$/g, '').trim();
    if (!name || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    result.push(name);
  };
  if (match) {
    const prefix = cleaned.slice(0, match.index).replace(/[_\s·-]+$/g, '');
    if (prefix) add(`${prefix}_${match[1]}`);
    add(match[1]);
  }
  add(cleaned);
  const withoutNumber = cleaned.replace(/No_\d+/gi, ' ');
  for (const word of withoutNumber.split(/[_\s·.（）()\[\]【】,，、-]+/)) {
    if (/^\d+(?:\.\d+)?(?:[KMGT]i?B|[PV]|张|图)$/i.test(word)) continue;
    add(word);
  }
  return { original, names: result.slice(0, 16) };
};
