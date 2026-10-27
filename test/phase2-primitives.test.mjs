import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSemver, compareSemver } from '../scripts/lib/semver.mjs';
import { treeDigest } from '../scripts/lib/digest.mjs';

test('SemVer precedence and strict syntax', () => {
  const versions = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 1; i < versions.length; i++) assert.equal(compareSemver(versions[i - 1], versions[i]), -1);
  assert.equal(compareSemver('1.0.0+a', '1.0.0+b'), 0);
  assert.equal(compareSemver('999999999999999999999.0.0', '2.0.0'), 1);
  for (const v of ['01.0.0', '1.0.0-01', '1.0', 'v1.0.0', '1.0.0+']) assert.equal(parseSemver(v), null);
});

test('tree digest matches documented vector and enforces file limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'market-digest-'));
  try {
    await mkdir(join(dir, 'skills/x'), {recursive:true});
    await writeFile(join(dir, 'a.txt'), 'hello\n'); await writeFile(join(dir, 'B.txt'), ''); await writeFile(join(dir, 'skills/x/SKILL.md'), 'x\n');
    const result = await treeDigest(dir);
    assert.equal(result.sha256, '1647808cd303bfaa69fc1f4b7ca4152628d21507e06afd4a0ce507cb16b24120');
    assert.equal(result.fileCount, 3);
    await assert.rejects(treeDigest(dir, {maxFileBytes: 2}), /limit/);
  } finally { await rm(dir, {recursive:true, force:true}); }
});

test('ZIP extraction accepts ordinary archive and rejects unsafe names, links, collisions and limits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'market-zip-'));
  const helper = resolve('scripts/lib/zip.py');
  try {
    const script = `import zipfile,sys,stat\np=sys.argv[1]; kind=sys.argv[2]\nwith zipfile.ZipFile(p,'w') as z:\n if kind=='good': z.writestr('pkg/skills/a/SKILL.md','hello')\n if kind=='traversal': z.writestr('pkg/../escape','x')\n if kind=='link':\n  i=zipfile.ZipInfo('pkg/link'); i.create_system=3; i.external_attr=(stat.S_IFLNK|0o777)<<16; z.writestr(i,'target')\n if kind=='collision':\n  z.writestr('pkg/A/x','x'); z.writestr('pkg/a/y','y')\n if kind=='large': z.writestr('pkg/a','123456')\n`;
    for (const kind of ['good','traversal','link','collision','large']) {
      const archive = join(dir, kind + '.zip'), dest = join(dir, kind);
      assert.equal(spawnSync('python3', ['-c',script,archive,kind]).status, 0);
      const r = spawnSync('python3', [helper, archive, dest, '--root','pkg/', '--max-artifact','10000','--max-expanded','100','--max-file','5','--max-entries','10']);
      assert.equal(r.status, kind === 'good' ? 0 : 1, r.stderr.toString());
      if (kind === 'good') assert.equal(await readFile(join(dest,'skills/a/SKILL.md'),'utf8'), 'hello');
      else await assert.rejects(readFile(join(dest,'a')), {code:'ENOENT'});
    }
  } finally { await rm(dir, {recursive:true, force:true}); }
});

test('ZIP rejects CRC corruption, encryption, truncated archives, total and entry limits without retaining output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'market-zip-errors-'));
  try {
    const make = `import zipfile,sys,struct\np=sys.argv[1]; mode=sys.argv[2]\nwith zipfile.ZipFile(p,'w',compression=zipfile.ZIP_STORED) as z:\n z.writestr('root/a','abcdef'); z.writestr('root/b','ghijkl')\nb=bytearray(open(p,'rb').read())\nif mode=='crc':\n i=b.index(b'abcdef'); b[i]=ord('X')\nif mode=='encrypted':\n i=b.index(b'PK\\x03\\x04'); b[i+6]|=1\n i=b.index(b'PK\\x01\\x02'); b[i+8]|=1\nif mode=='truncated': b=b[:-10]\nopen(p,'wb').write(b)\n`;
    for (const kind of ['crc','encrypted','truncated','expanded','entries','artifact']) {
      const archive=join(dir, `${kind}.zip`), target=join(dir, kind);
      assert.equal(spawnSync('python3',['-c',make,archive,kind]).status,0);
      const r=spawnSync('python3',[resolve('scripts/lib/zip.py'),archive,target,'--root','root/','--max-artifact',kind==='artifact'?'10':'10000','--max-expanded',kind==='expanded'?'10':'100','--max-file','20','--max-entries',kind==='entries'?'1':'10']);
      assert.notEqual(r.status,0,kind);
      await assert.rejects(readFile(join(target,'a')), {code:'ENOENT'});
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
});
