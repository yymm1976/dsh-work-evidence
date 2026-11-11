// RFC 6901 tokens are all validated before traversal, including missing branches.
export function resolveJsonPointer(root, pointer) {
  const invalid = () => Object.assign(new Error('Invalid JSON pointer'), {code:'INVALID_JSON_POINTER'});
  if (typeof pointer !== 'string' || pointer.length > 2048 || pointer && pointer[0] !== '/') throw invalid();
  const raw = pointer === '' ? [] : pointer.slice(1).split('/');
  if (raw.length > 64) throw invalid();
  const segments = raw.map(segment => {
    if (/~(?:[^01]|$)/u.test(segment)) throw invalid();
    return segment.replaceAll('~1','/').replaceAll('~0','~');
  });
  let value = root;
  for (const segment of segments) {
    if (value === null || typeof value !== 'object') return {found:false};
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) return {found:false};
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= value.length) return {found:false};
    }
    if (!Object.hasOwn(value,segment)) return {found:false};
    value = value[segment];
  }
  return {found:true,value};
}
