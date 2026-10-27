#!/usr/bin/env node
// Offline repository validator.
//
// Validates bootstrap and released candidates offline. Optional immutable baseline
// comparison checks actual package bytes and version precedence.
// Usage: node scripts/validate.mjs [--root <dir>] [--base <full-commit-sha>] [--json]

import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { verifyPackage } from './lib/package.mjs';
import { treeDigest } from './lib/digest.mjs';
import { compareSemver } from './lib/semver.mjs';
import { fileURLToPath } from 'node:url';
import { checkCatalog, entrySourcePath, expectedEntry } from './lib/catalog.mjs';
import {
  HOSTS, HOST_IDS, LEGACY_POLICY_PATH, LEGACY_SCHEMA_PATH, LOCK_SCHEMA_PATH, PLUGINS_DIR,
  SOURCE_SCHEMA_PATH, SOURCES_DIR,
} from './lib/policy.mjs';
import { compileSchema, deepEqual } from './lib/schema.mjs';
import { checkLockBinding, checkSourceSemantics, discoverSources } from './lib/sources.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function validateRepo(root) {
  const errors = [];
  const notes = [];
  const readJson = async (path) => {
    let text;
    try {
      text = await readFile(join(root, path), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        errors.push(`${path}: file is missing`);
        return undefined;
      }
      throw error;
    }
    try {
      return { json: JSON.parse(text), bytes: Buffer.from(text, 'utf8') };
    } catch (error) {
      errors.push(`${path}: invalid JSON (${error.message})`);
      return undefined;
    }
  };

  // Schemas are part of the reviewed contract; they are always read from the
  // validator's own checkout, never from the candidate being validated.
  const schema = async (path) => compileSchema(JSON.parse(await readFile(join(REPO_ROOT, path), 'utf8')));
  const validateSource = await schema(SOURCE_SCHEMA_PATH);
  const validateLock = await schema(LOCK_SCHEMA_PATH);
  const validateLegacy = await schema(LEGACY_SCHEMA_PATH);

  // Catalogs.
  const catalogs = {};
  for (const host of HOST_IDS) {
    const loaded = await readJson(HOSTS[host].catalog);
    if (!loaded) continue;
    const problems = checkCatalog(host, loaded.json);
    errors.push(...problems);
    if (problems.length === 0) catalogs[host] = loaded.json;
  }

  // Legacy entries: catalog entries owned outside source ingest, kept as they are.
  const legacy = { codex: new Map(), 'claude-code': new Map() };
  const legacyFile = await readJson(LEGACY_POLICY_PATH);
  if (legacyFile) {
    const schemaErrors = validateLegacy(legacyFile.json);
    errors.push(...schemaErrors.map((e) => `${LEGACY_POLICY_PATH}: ${e}`));
    if (schemaErrors.length === 0) {
      for (const item of legacyFile.json.entries) {
        if (legacy[item.host].has(item.entry.name)) {
          errors.push(`${LEGACY_POLICY_PATH}: duplicate ${item.host} entry "${item.entry.name}"`);
        }
        const local = entrySourcePath(item.host, item.entry);
        if (local !== null && (local === `./${PLUGINS_DIR}` || local.startsWith(`./${PLUGINS_DIR}/`))) {
          errors.push(`${LEGACY_POLICY_PATH}: ${item.host} entry "${item.entry.name}" may not point into ${PLUGINS_DIR}/, which holds only source-owned generated packages`);
        }
        legacy[item.host].set(item.entry.name, item.entry);
      }
    }
  }

  // Sources and locks.
  const discovered = await discoverSources(root);
  errors.push(...discovered.errors);
  const sources = new Map();
  for (const id of discovered.sources) {
    const loaded = await readJson(`${SOURCES_DIR}/${id}.json`);
    if (!loaded) continue;
    const schemaErrors = validateSource(loaded.json);
    errors.push(...schemaErrors.map((e) => `${SOURCES_DIR}/${id}.json: ${e}`));
    if (schemaErrors.length) continue;
    const semantic = checkSourceSemantics(id, loaded.json);
    errors.push(...semantic);
    if (semantic.length === 0) sources.set(id, loaded);
  }
  const locked = new Set();
  const locks = new Map();
  for (const id of discovered.locks) {
    const path = `${SOURCES_DIR}/${id}.lock.json`;
    if (!discovered.sources.includes(id)) {
      errors.push(`${path}: lock has no source pointer ${SOURCES_DIR}/${id}.json`);
      continue;
    }
    const loaded = await readJson(path);
    if (!loaded) continue;
    const schemaErrors = validateLock(loaded.json);
    errors.push(...schemaErrors.map((e) => `${path}: ${e}`));
    const source = sources.get(id);
    if (schemaErrors.length === 0 && source) {
      errors.push(...checkLockBinding(id, loaded.json, source.json, source.bytes));
    }
    locked.add(id);
    if (schemaErrors.length === 0) locks.set(id, loaded.json);
  }
  for (const host of HOST_IDS) {
    for (const name of legacy[host].keys()) {
      if (discovered.sources.includes(name)) {
        errors.push(`${LEGACY_POLICY_PATH}: ${host} entry "${name}" collides with source ${SOURCES_DIR}/${name}.json`);
      }
    }
  }

  // Generated paths: plugins/<host>/<id> must be owned by a locked source.
  const present = new Set();
  const pluginsRoot = join(root, PLUGINS_DIR);
  const pluginsStat = await lstat(pluginsRoot).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (pluginsStat && !pluginsStat.isDirectory()) errors.push(`${PLUGINS_DIR}: must be a directory`);
  if (pluginsStat?.isDirectory()) {
    const hostDirs = new Map(HOST_IDS.map((h) => [HOSTS[h].targetPrefix.slice(PLUGINS_DIR.length + 1), h]));
    for (const dirent of await readdir(pluginsRoot, { withFileTypes: true })) {
      const host = hostDirs.get(dirent.name);
      if (!host || !dirent.isDirectory()) {
        errors.push(`${PLUGINS_DIR}/${dirent.name}: unexpected entry; only ${[...hostDirs.keys()].join(' and ')} host directories are allowed`);
        continue;
      }
      for (const child of await readdir(join(pluginsRoot, dirent.name), { withFileTypes: true })) {
        const path = `${HOSTS[host].targetPrefix}/${child.name}`;
        if (!child.isDirectory()) {
          errors.push(`${path}: unexpected non-directory entry`);
        } else if (!sources.has(child.name) || !locked.has(child.name)) {
          errors.push(`${path}: generated directory is not owned by a locked source (${SOURCES_DIR}/${child.name}.json and .lock.json); run npm run ingest instead of adding files by hand`);
        } else {
          present.add(`${host}/${child.name}`);
        }
      }
    }
  }

  // Catalog entries: each is either source-owned (exact expected entry) or legacy.
  for (const host of HOST_IDS) {
    const catalog = catalogs[host];
    if (!catalog) continue;
    const at = HOSTS[host].catalog;
    const names = new Set();
    for (const entry of catalog.plugins) {
      names.add(entry.name);
      const local = entrySourcePath(host, entry);
      if (local && !local.split('/').some(x => x === '..')) {
        try {
          const target = await realpath(join(root, local));
          const base = await realpath(root);
          if (target !== base && !target.startsWith(base + '/')) errors.push(`${at}: local source escapes repository`);
        } catch { errors.push(`${at}: local source ${local} does not exist`); }
      }
      const source = sources.get(entry.name);
      if (source) {
        if (!locked.has(entry.name)) {
          errors.push(`${at}: entry "${entry.name}" has no lock; catalog entries for a source are written only by ingest`);
        } else if (!deepEqual(entry, expectedEntry(host, source.json))) {
          errors.push(`${at}: entry "${entry.name}" differs from the entry derived from ${SOURCES_DIR}/${entry.name}.json`);
        }
      } else if (legacy[host].has(entry.name)) {
        if (!deepEqual(entry, legacy[host].get(entry.name))) {
          errors.push(`${at}: legacy entry "${entry.name}" was changed; legacy entries are preserved as recorded in ${LEGACY_POLICY_PATH}`);
        }
      } else if (!discovered.sources.includes(entry.name)) {
        errors.push(`${at}: entry "${entry.name}" is owned by neither a source nor ${LEGACY_POLICY_PATH}`);
      }
    }
    for (const name of legacy[host].keys()) {
      if (!names.has(name)) errors.push(`${at}: legacy entry "${name}" was removed without a scoped retirement`);
    }
    for (const id of locked) {
      if (sources.has(id) && !names.has(id)) errors.push(`${at}: locked source "${id}" has no catalog entry`);
    }
  }

  // Verify both host trees before accepting any released source.
  for (const id of locked) {
    if (!sources.has(id) || !locks.has(id)) continue;
    const results = [];
    for (const host of HOST_IDS) {
      if (!present.has(`${host}/${id}`)) {
        errors.push(`${HOSTS[host].targetPrefix}/${id}: locked source has no generated package`);
        continue;
      }
      const result = await verifyPackage(join(root, sources.get(id).json.hosts[host].target), host, sources.get(id).json, locks.get(id));
      errors.push(...result.errors);
      results.push(result);
    }
    if (results.length === 2 && (results[0].skills.size !== results[1].skills.size || [...results[0].skills].some(([name, hash]) => results[1].skills.get(name) !== hash))) errors.push(`${id}: host skill bytes differ`);
  }

  const pending = [...sources.keys()].filter((id) => !locked.has(id));
  for (const id of pending) notes.push(`source "${id}" is declared and awaiting its first ingest`);
  const released = [...locked].filter((id) => sources.has(id));
  const state = released.length === 0 ? 'bootstrap' : 'released';
  if (state === 'bootstrap') {
    notes.push('bootstrap: no plugin has been ingested; both catalogs carry only legacy entries (if any)');
  }
  return { ok: errors.length === 0, state, sources: [...sources.keys()], released, pending, errors, notes };
}

// Read a committed immutable baseline into an isolated temporary directory. Compare
// actual tree bytes, not the baseline's self-reported digest.
export async function compareBase(root, sha) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) throw new Error('--base requires a full immutable commit SHA');
  const actual = execFileSync('git', ['rev-parse', '--verify', `${sha}^{commit}`], {cwd: root, encoding: 'utf8'}).trim();
  if (actual !== sha) throw new Error('--base must identify the exact commit');
  const dir = await mkdtemp(join(tmpdir(), 'marketplace-base-'));
  try {
    const archive = execFileSync('git', ['archive', '--format=tar', sha], {cwd: root, maxBuffer: 100_000_000});
    execFileSync('tar', ['-xf', '-', '-C', dir], {input: archive});
    const base = await discoverSources(dir);
    if (base.errors.length && !base.errors.every(e => e.includes('directory is missing'))) throw new Error(base.errors.join('; '));
    const current = await discoverSources(root);
    const errors = [], notes = [];
    for (const id of base.locks) {
      if (!current.locks.includes(id) || !current.sources.includes(id)) { errors.push(`${id}: removal of a released plugin is unsupported`); continue; }
      const oldLock = JSON.parse(await readFile(join(dir, SOURCES_DIR, `${id}.lock.json`), 'utf8'));
      const newLock = JSON.parse(await readFile(join(root, SOURCES_DIR, `${id}.lock.json`), 'utf8'));
      const oldSource = await readFile(join(dir, SOURCES_DIR, `${id}.json`));
      const newSource = await readFile(join(root, SOURCES_DIR, `${id}.json`));
      const source = JSON.parse(newSource);
      let changed = !oldSource.equals(newSource);
      for (const host of HOST_IDS) {
        const oldTree = await treeDigest(join(dir, HOSTS[host].targetPrefix, id));
        const newTree = await treeDigest(join(root, source.hosts[host].target));
        changed ||= oldTree.sha256 !== newTree.sha256;
      }
      const order = compareSemver(newLock.version, oldLock.version);
      if (order < 0 || (order === 0 && (changed || newLock.version !== oldLock.version))) errors.push(`${id}: package or source changed without an increased version, or version decreased`);
      else notes.push(`${id}: ${order > 0 ? 'upgrade' : 'unchanged'} compared with base`);
    }
    for (const id of current.locks) if (!base.locks.includes(id)) notes.push(`${id}: first addition compared with base`);
    return {errors, notes};
  } finally { await rm(dir, {recursive:true, force:true}); }
}

async function main(argv) {
  let root = process.cwd();
  let json = false;
  let base = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--root' && argv[i + 1] !== undefined) root = resolve(argv[(i += 1)]);
    else if (arg === '--base' && argv[i + 1] !== undefined) base = argv[++i];
    else {
      console.error(`validate: unknown argument ${JSON.stringify(arg)}\nusage: node scripts/validate.mjs [--root <dir>] [--json]`);
      return 2;
    }
  }
  const result = await validateRepo(root);
  if (base) {
    try { const comparison = await compareBase(root, base); result.errors.push(...comparison.errors); result.notes.push(...comparison.notes); result.ok = result.errors.length === 0; }
    catch (error) { console.error(`validate: base comparison failed: ${error.message}`); return 2; }
  }
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const note of result.notes) console.log(`note: ${note}`);
    for (const error of result.errors) console.error(`error: ${error}`);
    console.log(result.ok ? `validate: ok (${result.state})` : `validate: ${result.errors.length} error(s)`);
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
