// Catalog contract: the exact entry each host gets for a source-owned plugin, the
// structural rules for both catalog files, and the merge ingest uses to update one
// entry while preserving every other entry, field and position.

import { HOSTS, MARKETPLACE_NAME } from './policy.mjs';
import { isObject } from './schema.mjs';

const ENTRY_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

// The catalog entry for a source-owned plugin. name and source are derived from the
// source id and fixed target; the remaining fields come from the reviewed source
// pointer. version is deliberately absent: each host reads it from the manifest.
export function expectedEntry(host, source) {
  const spec = source.hosts[host];
  const path = `./${spec.target}`;
  if (host === 'codex') {
    return {
      name: source.plugin,
      source: { source: 'local', path },
      policy: { ...spec.catalogEntry.policy },
      category: spec.catalogEntry.category,
    };
  }
  if (host === 'claude-code') {
    return {
      name: source.plugin,
      source: path,
      description: spec.catalogEntry.description,
      category: spec.catalogEntry.category,
    };
  }
  throw new Error(`unknown host "${host}"`);
}

// Returns a new catalog with `entry` replacing the same-named entry in place, or
// appended when absent. Top-level fields and all other entries are kept as-is.
export function mergeEntry(catalog, entry) {
  const plugins = catalog.plugins.map((p) => (p?.name === entry.name ? entry : p));
  if (!plugins.includes(entry)) plugins.push(entry);
  return { ...catalog, plugins };
}

export function entrySourcePath(host, entry) {
  if (host === 'codex') return isObject(entry.source) && entry.source.source === 'local' ? entry.source.path : null;
  return typeof entry.source === 'string' ? entry.source : null;
}

// Structural checks shared by both hosts. Ownership and per-entry equality are
// checked by the caller against sources and the legacy policy.
export function checkCatalog(host, catalog) {
  const errors = [];
  const at = HOSTS[host].catalog;
  if (!isObject(catalog)) return [`${at}: must be a JSON object`];
  if (catalog.name !== MARKETPLACE_NAME) {
    errors.push(`${at}: name must be exactly "${MARKETPLACE_NAME}" (case-sensitive), found ${JSON.stringify(catalog.name)}`);
  }
  if (!Array.isArray(catalog.plugins)) {
    errors.push(`${at}: plugins must be an array`);
    return errors;
  }
  if (host === 'codex') {
    if (catalog.interface !== undefined && (!isObject(catalog.interface) || typeof catalog.interface.displayName !== 'string')) {
      errors.push(`${at}: interface.displayName must be a string when interface is present`);
    }
  } else if (!isObject(catalog.owner) || typeof catalog.owner.name !== 'string' || !catalog.owner.name) {
    errors.push(`${at}: owner.name is required`);
  }
  const seen = new Set();
  catalog.plugins.forEach((entry, i) => {
    const where = `${at}: plugins[${i}]`;
    if (!isObject(entry)) {
      errors.push(`${where} must be an object`);
      return;
    }
    if (typeof entry.name !== 'string' || !ENTRY_NAME.test(entry.name)) {
      errors.push(`${where}.name must be kebab-case`);
    } else if (seen.has(entry.name)) {
      errors.push(`${where}: duplicate plugin name "${entry.name}"`);
    } else {
      seen.add(entry.name);
    }
    if ('version' in entry) errors.push(`${where}: version must not be set in the catalog; hosts read it from the manifest`);
    if (host === 'codex') {
      if (!isObject(entry.policy) || !entry.policy.installation || !entry.policy.authentication) {
        errors.push(`${where}: policy.installation and policy.authentication are required`);
      }
      if (typeof entry.category !== 'string' || !entry.category) errors.push(`${where}: category is required`);
    }
    const local = entrySourcePath(host, entry);
    if (local !== null) {
      const problem = localPathProblem(local);
      if (problem) errors.push(`${where}: source path ${JSON.stringify(local)} ${problem}`);
    }
  });
  return errors;
}

// A catalog-relative local path must start with ./ and stay inside the repository.
export function localPathProblem(path) {
  if (typeof path !== 'string' || !path.startsWith('./')) return 'must start with "./"';
  if (/[\\\u0000-\u001f\u007f]/u.test(path)) return 'contains a backslash or control character';
  const segments = path.slice(2).split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return 'must be a normalized path inside the repository';
  return null;
}
