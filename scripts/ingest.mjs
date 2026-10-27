#!/usr/bin/env node
// Ingest one reviewed source. All network and publication work stays under a writer lock.
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { HOSTS, HOST_IDS, INGEST } from './lib/policy.mjs';
import { discoverSources, readSource, sha256Hex, checkSourceSemantics } from './lib/sources.mjs';
import { compileSchema } from './lib/schema.mjs';
import { treeDigest } from './lib/digest.mjs';
import { compareSemver, parseSemver } from './lib/semver.mjs';
import { expectedEntry, mergeEntry, entrySourcePath, localPathProblem } from './lib/catalog.mjs';
import { validateRepo } from './validate.mjs';

const codeRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const exists = async p => !!(await stat(p).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e)));
const jsonBytes = x => `${JSON.stringify(x, null, 2)}\n`;
const at = (obj, path) => path.split('.').reduce((x, k) => x?.[k], obj);
function safeUrl(raw, origin) {
  let u; try { u = new URL(raw); } catch { throw new Error('invalid release URL'); }
  if (u.protocol !== 'https:' || u.origin !== origin || u.username || u.password || u.search || u.hash || u.href !== raw) throw new Error('release URL must be canonical HTTPS on the reviewed origin without credentials, query or fragment');
  return u.href;
}
async function request(raw, origin, max, kind, fetcher = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INGEST.requestDeadlineMs);
  try {
    let url = safeUrl(raw, origin);
    for (let hop = 0; ; hop++) {
      const res = await fetcher(url, { redirect: 'manual', signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        if (hop >= INGEST.maxRedirects) throw new Error('redirect limit exceeded');
        const location = res.headers.get('location');
        if (!location) throw new Error('redirect missing location');
        url = safeUrl(new URL(location, url).href, origin); continue;
      }
      if (!res.ok) throw new Error(`HTTP status ${res.status}`);
      const media = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (kind === 'index' ? !(media === 'application/json' || media.endsWith('+json')) : !['application/zip', 'application/octet-stream', 'application/x-zip-compressed'].includes(media)) throw new Error(`unexpected ${kind} media type`);
      if (!res.body) throw new Error('empty response body');
      const chunks = []; let size = 0;
      for await (const chunk of res.body) { size += chunk.length; if (size > max) { controller.abort(); throw new Error(`${kind} body limit exceeded`); } chunks.push(Buffer.from(chunk)); }
      return Buffer.concat(chunks);
    }
  } finally { clearTimeout(timer); }
}
function release(index, source) {
  if (!index || typeof index !== 'object' || Array.isArray(index) || !parseSemver(index.version)) throw new Error('index version is not strict SemVer');
  const hosts = {};
  for (const host of HOST_IDS) {
    const field = source.hosts[host].indexField;
    const url = safeUrl(at(index, field), source.deploymentUrl);
    const checksum = at(index, `${field}_sha256`);
    if (checksum !== undefined && (typeof checksum !== 'string' || !/^[0-9a-f]{64}$/.test(checksum))) throw new Error(`invalid ${host} advertised checksum`);
    hosts[host] = { url, ...(checksum === undefined ? {} : { advertisedSha256: checksum }) };
  }
  const releaseId = index.release_id;
  if (releaseId !== undefined && (typeof releaseId !== 'string' || !/^[A-Za-z0-9._:+-]{1,128}$/.test(releaseId))) throw new Error('invalid release id');
  return { version: index.version, ...(releaseId === undefined ? {} : { releaseId }), hosts };
}
async function indexRequest(source, fetcher) {
  const bytes = await request(source.deploymentUrl + source.index, source.deploymentUrl, INGEST.maxIndexBytes, 'index', fetcher);
  let index; try { index = JSON.parse(bytes); } catch { throw new Error('invalid index JSON'); }
  return { bytes, fields: release(index, source) };
}
// Backups are copied, never consumed by recovery. A crash during rollback can be retried.
async function recover(root, work) {
  const journal = join(work, 'journal.json');
  if (!(await exists(journal))) return;
  const entries = JSON.parse(await readFile(journal, 'utf8'));
  if (!Array.isArray(entries) || entries.some(e => typeof e.path !== 'string' || !/^(plugins\/(codex|claude-code)\/[a-z0-9-]+|sources\/[a-z0-9-]+\.lock\.json|\.agents\/plugins\/marketplace\.json|\.claude-plugin\/marketplace\.json)$/.test(e.path) || typeof e.existed !== 'boolean')) throw new Error('invalid transaction journal');
  for (let i = 0; i < entries.length; i++) {
    const target = join(root, entries[i].path), backup = join(work, 'backup', String(i));
    await rm(target, {recursive:true, force:true});
    if (entries[i].existed) { await mkdir(dirname(target), {recursive:true}); await cp(backup, target, {recursive:true}); }
  }
  await rm(journal, {force:true});
  await rm(join(work, 'backup'), {recursive:true, force:true});
}
async function acquire(root) {
  const lock = join(root, INGEST.lockFile);
  await mkdir(dirname(lock), {recursive:true});
  // The kernel releases the advisory lock if either process dies. The lock file is
  // deliberately persistent: unlinking it could let two processes lock different inodes.
  const child = spawn('python3', ['-u', '-c', "import fcntl,sys\nf=open(sys.argv[1], 'a')\ntry: fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(3)\nprint('locked', flush=True)\nsys.stdin.buffer.read()", lock], {stdio:['pipe','pipe','pipe']});
  await new Promise((resolveLock, reject) => {
    child.once('error', reject);
    child.stdout.once('data', data => data.toString().trim() === 'locked' ? resolveLock() : reject(new Error('writer lock failed')));
    child.once('exit', code => reject(new Error(`writer lock unavailable (${code})`)));
  });
  return async () => { child.stdin.end(); await new Promise(resolveExit => child.once('exit', resolveExit)); };
}
export async function ingest(root, id, {dryRun = false, fetcher = fetch, beforeReplace = async () => {}} = {}) {
  root = resolve(root); let stage = 'lock';
  const unlock = await acquire(root);
  const work = join(root, INGEST.workDir);
  let candidate;
  try {
    await mkdir(work, {recursive:true});
    stage = 'recovery'; await recover(root, work);
    stage = 'source';
    const found = await discoverSources(root);
    if (found.errors.length || !found.sources.includes(id)) throw new Error('unknown source or invalid source directory');
    const {json:source, bytes:sourceBytes} = await readSource(root, id);
    const schema = compileSchema(JSON.parse(await readFile(join(codeRoot, 'schemas/source.schema.json'), 'utf8')));
    const errors = schema(source); if (errors.length) throw new Error(errors.join('; '));
    const semantics = checkSourceSemantics(id, source); if (semantics.length) throw new Error(semantics.join('; '));
    const oldPath = join(root, 'sources', `${id}.lock.json`);
    const old = await exists(oldPath) ? JSON.parse(await readFile(oldPath, 'utf8')) : null;
    if (!old) { const baseline = await validateRepo(root); if (!baseline.ok) throw new Error(`existing repository invalid: ${baseline.errors.join('; ')}`); }
    else if (old.sourceSha256 === sha256Hex(sourceBytes)) { const baseline = await validateRepo(root); if (!baseline.ok) throw new Error(`existing release invalid: ${baseline.errors.join('; ')}`); }
    else { for (const host of HOST_IDS) { const tree = await treeDigest(join(root, source.hosts[host].target), source); if (tree.sha256 !== old.hosts[host].treeSha256 || tree.fileCount !== old.hosts[host].fileCount) throw new Error(`existing ${host} tree does not match lock`); } }
    candidate = await mkdtemp(join(work, 'candidate-'));
    for (const dir of ['sources', 'policy', '.agents', '.claude-plugin', 'plugins']) if (await exists(join(root, dir))) await cp(join(root, dir), join(candidate, dir), {recursive:true});
    stage = 'index'; const initial = await indexRequest(source, fetcher);
    const lock = { lockVersion:1, plugin:id, version:initial.fields.version, ...(initial.fields.releaseId ? {releaseId:initial.fields.releaseId} : {}), sourceSha256:sha256Hex(sourceBytes), indexSha256:sha256Hex(initial.bytes), fetchedAt:new Date().toISOString(), hosts:{} };
    const changedPaths = {};
    for (const host of HOST_IDS) {
      stage = `download ${host}`; const spec = source.hosts[host], fields = initial.fields.hosts[host];
      const bytes = await request(fields.url, source.deploymentUrl, source.maxArtifactBytes, 'artifact', fetcher);
      const hash = sha256Hex(bytes);
      if (fields.advertisedSha256 && fields.advertisedSha256 !== hash) throw new Error(`${host} checksum mismatch`);
      const archive = join(work, `${host}-${process.pid}.zip`); await writeFile(archive, bytes);
      const target = join(candidate, spec.target); await rm(target, {recursive:true, force:true}); await mkdir(dirname(target), {recursive:true});
      try { execFileSync('python3', [join(codeRoot, 'scripts/lib/zip.py'), archive, target, '--root', spec.zipRoot, '--max-artifact', String(source.maxArtifactBytes), '--max-expanded', String(source.maxExpandedBytes), '--max-file', String(source.maxFileBytes), '--max-entries', String(source.maxEntries)], {stdio:'pipe'}); }
      catch (e) { throw new Error(`ZIP extraction failed: ${String(e.stderr ?? e.message).slice(0, 1000)}`); }
      finally { await rm(archive, {force:true}); }
      const tree = await treeDigest(target, source);
      const previous = old ? await treeDigest(join(root, spec.target)) : {files:[]};
      const oldFiles = new Map(previous.files.map(f => [f.path, f.hash]));
      const newFiles = new Map(tree.files.map(f => [f.path, f.hash]));
      const changed = [...new Set([...oldFiles.keys(), ...newFiles.keys()])].filter(p => oldFiles.get(p) !== newFiles.get(p)).sort();
      changedPaths[host] = {count:changed.length, paths:changed.slice(0, 50).map(p => p.slice(0, 256))};
      lock.hosts[host] = {...fields, zipSha256:hash, treeSha256:tree.sha256, fileCount:tree.fileCount};
      const catalogPath = join(candidate, HOSTS[host].catalog);
      const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
      const merged = mergeEntry(catalog, expectedEntry(host, source));
      for (const entry of merged.plugins) {
        const local = entrySourcePath(host, entry);
        if (!local || localPathProblem(local)) continue;
        const destination = join(candidate, local);
        if (!(await exists(destination)) && await exists(join(root, local))) {
          const actual = await realpath(join(root, local)), base = await realpath(root);
          if (!actual.startsWith(base + '/')) throw new Error('legacy catalog source escapes repository');
          await mkdir(dirname(destination), {recursive:true}); await cp(join(root, local), destination, {recursive:true});
        }
      }
      await writeFile(catalogPath, jsonBytes(merged));
    }
    stage = 'race guard'; const later = await indexRequest(source, fetcher);
    if (JSON.stringify(initial.fields) !== JSON.stringify(later.fields)) throw new Error('release fields changed during download');
    stage = 'version';
    if (old) {
      const cmp = compareSemver(lock.version, old.version);
      if (cmp < 0) throw new Error('release version decreased');
      if (cmp === 0 && (lock.version !== old.version || lock.sourceSha256 !== old.sourceSha256 || HOST_IDS.some(h => lock.hosts[h].treeSha256 !== old.hosts[h].treeSha256))) throw new Error('artifact changed without a version bump');
      if (cmp === 0) {
        const current = await validateRepo(root); if (!current.ok) throw new Error(`existing release invalid: ${current.errors.join('; ')}`);
        // Validate the freshly fetched trees and manifests too, using their new digests.
        await writeFile(join(candidate, 'sources', `${id}.lock.json`), jsonBytes(lock));
        const checked = await validateRepo(candidate); if (!checked.ok) throw new Error(`candidate invalid: ${checked.errors.join('; ')}`);
        return {status:'up-to-date', version:lock.version, hosts:lock.hosts, zipChanged:HOST_IDS.filter(h => lock.hosts[h].zipSha256 !== old.hosts[h].zipSha256)};
      }
    }
    await writeFile(join(candidate, 'sources', `${id}.lock.json`), jsonBytes(lock));
    stage = 'candidate validation'; const checked = await validateRepo(candidate); if (!checked.ok) throw new Error(checked.errors.join('; '));
    const paths = [...HOST_IDS.map(h => source.hosts[h].target), ...HOST_IDS.map(h => HOSTS[h].catalog), `sources/${id}.lock.json`];
    const report = {status:dryRun ? 'dry-run' : 'updated', oldVersion:old?.version ?? null, version:lock.version, sourceSha256:lock.sourceSha256, indexSha256:lock.indexSha256, hosts:lock.hosts, changedPaths, paths};
    if (dryRun) return report;
    stage = 'backup'; const entries = [];
    await rm(join(work, 'backup'), {recursive:true, force:true}); await mkdir(join(work, 'backup'));
    for (const [i, path] of paths.entries()) {
      const present = await exists(join(root, path)); entries.push({path, existed:present});
      if (present) await cp(join(root, path), join(work, 'backup', String(i)), {recursive:true});
    }
    // Write the journal atomically only after every backup exists, before any replacement.
    await writeFile(join(work, 'journal.new'), jsonBytes(entries)); await rename(join(work, 'journal.new'), join(work, 'journal.json'));
    stage = 'replacement';
    try {
      for (const [i, path] of paths.entries()) {
        await beforeReplace(i, path);
        await mkdir(dirname(join(root, path)), {recursive:true});
        await rm(join(root, path), {recursive:true, force:true});
        await rename(join(candidate, path), join(root, path));
      }
      await beforeReplace(paths.length, null);
      stage = 'post-write validation'; const live = await validateRepo(root); if (!live.ok) throw new Error(live.errors.join('; '));
      await rm(join(work, 'journal.json')); await rm(join(work, 'backup'), {recursive:true, force:true});
    } catch (e) { await recover(root, work); throw e; }
    return report;
  } catch (e) { throw new Error(`${stage}: ${e.message}`); }
  finally { if (candidate) await rm(candidate, {recursive:true, force:true}); await unlock(); }
}
async function main(args) {
  if (!(args.length === 2 || args.length === 3) || args[0] !== '--plugin' || (args.length === 3 && args[2] !== '--dry-run')) { console.error('usage: node scripts/ingest.mjs --plugin <id> [--dry-run]'); return 2; }
  try { const result = await ingest(process.cwd(), args[1], {dryRun:args.length === 3}); console.log(JSON.stringify(result, null, 2)); return 0; }
  catch (e) { console.error(JSON.stringify({status:'error', error:e.message.slice(0, 4000)})); return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
