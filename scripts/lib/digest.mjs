import { createHash } from 'node:crypto';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';

// Reject links and non-regular files, so hashing cannot leave the package root.
export async function treeDigest(root, limits = {}) {
  const files = [];
  let expanded = 0;
  let entries = 0;
  const names = new Set();
  async function walk(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++entries > (limits.maxEntries ?? Infinity)) throw new Error('tree entry limit exceeded');
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (/[\x00-\x1f\x7f\\]/.test(name)) throw new Error(`unsafe path: ${name}`);
      const folded = name.normalize('NFC').toLowerCase();
      if (names.has(folded)) throw new Error(`normalized path collision: ${name}`);
      names.add(folded);
      if (entry.isDirectory()) await walk(join(dir, entry.name), name);
      else if (entry.isFile()) {
        const stat = await lstat(join(dir, entry.name));
        if (!stat.isFile() || stat.size > (limits.maxFileBytes ?? Infinity) || expanded + stat.size > (limits.maxExpandedBytes ?? Infinity)) throw new Error('tree size limit or non-regular file');
        const bytes = await readFile(join(dir, entry.name));
        expanded += bytes.length;
        if (bytes.length > (limits.maxFileBytes ?? Infinity) || expanded > (limits.maxExpandedBytes ?? Infinity)) throw new Error('tree size limit exceeded');
        files.push({ path: name, bytes, hash: createHash('sha256').update(bytes).digest('hex') });
        if (files.length > (limits.maxEntries ?? Infinity)) throw new Error('tree entry limit exceeded');
      } else throw new Error(`non-regular entry: ${name}`);
    }
  }
  await walk(root);
  files.sort((a,b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const hash = createHash('sha256');
  for (const f of files) hash.update(f.path).update('\0').update(f.hash).update('\n');
  return { sha256: hash.digest('hex'), fileCount: files.length, files };
}
