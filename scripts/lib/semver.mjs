// Strict SemVer 2.0 parsing and precedence; build metadata never changes precedence.
export function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!m || (m[4] && m[4].split('.').some(x => /^\d+$/.test(x) && x.length > 1 && x[0] === '0'))) return null;
  return { core: m.slice(1, 4).map(BigInt), pre: m[4]?.split('.') ?? null, build: m[5] ?? null };
}
export function compareSemver(a, b) {
  a = parseSemver(a); b = parseSemver(b);
  if (!a || !b) throw new Error('invalid SemVer');
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.pre || !b.pre) return a.pre === b.pre ? 0 : a.pre ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
