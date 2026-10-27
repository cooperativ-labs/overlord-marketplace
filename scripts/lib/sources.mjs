// Source pointer and lock contract: discovery of sources/<id>.json, semantic checks
// beyond the JSON schema, and the source digest binding recorded in the lock.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  HOSTS, HOST_IDS, SOURCES_DIR, SOURCE_ID_MAX_LENGTH, SOURCE_ID_PATTERN,
} from './policy.mjs';

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function isSourceId(id) {
  return typeof id === 'string' && id.length <= SOURCE_ID_MAX_LENGTH && SOURCE_ID_PATTERN.test(id);
}

// Lists source ids and lock ids under sources/. Any other file name is an error, so a
// stray file can never be mistaken for a source or silently ignored.
export async function discoverSources(root) {
  const errors = [];
  const sources = [];
  const locks = [];
  let names = [];
  try {
    names = (await readdir(join(root, SOURCES_DIR), { withFileTypes: true }));
  } catch (error) {
    if (error.code === 'ENOENT') return { sources, locks, errors: [`${SOURCES_DIR}/: directory is missing`] };
    throw error;
  }
  for (const dirent of names) {
    const name = dirent.name;
    if (!dirent.isFile()) {
      errors.push(`${SOURCES_DIR}/${name}: only regular source and lock files are allowed`);
      continue;
    }
    const lock = name.match(/^(.+)\.lock\.json$/);
    const source = name.match(/^(.+)\.json$/);
    const id = lock ? lock[1] : source?.[1];
    if (!id || !isSourceId(id)) {
      errors.push(`${SOURCES_DIR}/${name}: not a valid source (<id>.json) or lock (<id>.lock.json) name`);
    } else if (lock) {
      locks.push(id);
    } else {
      sources.push(id);
    }
  }
  sources.sort();
  locks.sort();
  return { sources, locks, errors };
}

export async function readSource(root, id) {
  const path = `${SOURCES_DIR}/${id}.json`;
  const bytes = await readFile(join(root, path));
  return { path, bytes, json: JSON.parse(bytes.toString('utf8')) };
}

// Checks the rules a JSON schema cannot express. Assumes the schema already passed.
export function checkSourceSemantics(id, source) {
  const at = `${SOURCES_DIR}/${id}.json`;
  const errors = [];
  if (source.plugin !== id) errors.push(`${at}: plugin "${source.plugin}" must equal the file id "${id}"`);

  const deployment = canonicalOrigin(source.deploymentUrl);
  if (!deployment) errors.push(`${at}: deploymentUrl must be a canonical HTTPS origin`);

  const segments = source.index.split('/').slice(1);
  if (segments.some((s) => s === '.' || s === '..')) errors.push(`${at}: index must not contain "." or ".." segments`);

  const targets = new Set();
  for (const host of HOST_IDS) {
    const spec = source.hosts[host];
    const expected = `${HOSTS[host].targetPrefix}/${id}`;
    if (spec.target !== expected) errors.push(`${at}: hosts.${host}.target must be "${expected}"`);
    if (targets.has(spec.target)) errors.push(`${at}: hosts.${host}.target duplicates another host`);
    targets.add(spec.target);
    if (!HOSTS[host].manifests.includes(spec.manifest)) {
      errors.push(`${at}: hosts.${host}.manifest must be one of ${HOSTS[host].manifests.join(', ')}`);
    }
  }

  const origins = new Set();
  for (const origin of source.allowedMcpOrigins) {
    if (!canonicalOrigin(origin)) errors.push(`${at}: allowedMcpOrigins entry ${origin} must be a canonical HTTPS origin`);
    origins.add(origin);
  }
  for (const raw of source.allowedMcpUrls) {
    const url = safeUrl(raw);
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.href !== raw) {
      errors.push(`${at}: allowedMcpUrls entry ${raw} must be an exact HTTPS URL with no userinfo, port, query or fragment`);
    } else if (!origins.has(url.origin)) {
      errors.push(`${at}: allowedMcpUrls entry ${raw} is not on an allowed MCP origin`);
    }
  }

  if (source.maxFileBytes > source.maxExpandedBytes) errors.push(`${at}: maxFileBytes must not exceed maxExpandedBytes`);
  return errors;
}

// Checks a lock against its source. Integrity of the generated trees is verified
// separately (tree digests), since that requires reading the packages.
export function checkLockBinding(id, lock, source, sourceBytes) {
  const at = `${SOURCES_DIR}/${id}.lock.json`;
  const errors = [];
  if (lock.plugin !== id) errors.push(`${at}: plugin "${lock.plugin}" must equal the file id "${id}"`);
  if (lock.sourceSha256 !== sha256Hex(sourceBytes)) {
    errors.push(`${at}: sourceSha256 does not match ${SOURCES_DIR}/${id}.json; a source edit must land with an ingest of a higher release`);
  }
  for (const host of HOST_IDS) {
    const url = safeUrl(lock.hosts[host].url);
    if (!url || url.origin !== source.deploymentUrl || url.username || url.password || url.search || url.hash) {
      errors.push(`${at}: hosts.${host}.url must be an HTTPS URL on ${source.deploymentUrl} with no userinfo, query or fragment`);
    }
    const advertised = lock.hosts[host].advertisedSha256;
    if (advertised !== undefined && advertised !== lock.hosts[host].zipSha256) {
      errors.push(`${at}: hosts.${host}.advertisedSha256 differs from zipSha256`);
    }
  }
  return errors;
}

function safeUrl(raw) {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

// Returns the origin when `raw` is exactly a canonical https origin (no path,
// trailing slash, port, query, fragment or userinfo), otherwise null.
export function canonicalOrigin(raw) {
  const url = safeUrl(raw);
  if (!url || url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  return url.origin === raw ? raw : null;
}
