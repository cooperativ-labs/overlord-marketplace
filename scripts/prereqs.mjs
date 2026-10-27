#!/usr/bin/env node
// Checks tool prerequisites before any command mutates the repository or a test home.
// Usage: node scripts/prereqs.mjs [--hosts] [--json]
//   --hosts also requires the codex and claude CLIs (needed by smoke.sh only).

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIN_NODE = [22, 0, 0];
export const MIN_PYTHON = [3, 9, 0];

export function parseVersion(text) {
  const match = String(text).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

export function atLeast(version, minimum) {
  for (let i = 0; i < 3; i += 1) {
    if (version[i] !== minimum[i]) return version[i] > minimum[i];
  }
  return true;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15_000 });
  if (result.error || result.status !== 0) return null;
  return `${result.stdout}${result.stderr}`.trim();
}

export function checkPrerequisites({ hosts = false } = {}) {
  const checks = [];
  const node = parseVersion(process.versions.node);
  checks.push({
    tool: 'node',
    version: process.versions.node,
    ok: atLeast(node, MIN_NODE),
    fix: `Node.js >= ${MIN_NODE.join('.')} is required (package.json engines).`,
  });
  // The ZIP helper uses only the standard library zipfile module.
  const python = run('python3', ['-I', '-c', 'import sys, zipfile; print("%d.%d.%d" % sys.version_info[:3])']);
  checks.push({
    tool: 'python3',
    version: python,
    ok: python !== null && atLeast(parseVersion(python), MIN_PYTHON),
    fix: `Python >= ${MIN_PYTHON.join('.')} with the standard zipfile module must be on PATH as python3; scripts/lib/zip.py inspects and extracts release ZIPs.`,
  });
  const git = run('git', ['--version']);
  checks.push({ tool: 'git', version: git, ok: git !== null, fix: 'git is required for --base comparison and smoke tests.' });
  if (hosts) {
    const codex = run('codex', ['--version']);
    checks.push({ tool: 'codex', version: codex, ok: codex !== null, fix: 'Install the Codex CLI (npm i -g @openai/codex) to run smoke tests.' });
    const claude = run('claude', ['--version']);
    checks.push({ tool: 'claude', version: claude, ok: claude !== null, fix: 'Install Claude Code (npm i -g @anthropic-ai/claude-code) to run smoke tests.' });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--hosts' && a !== '--json');
  if (unknown.length) {
    console.error(`prereqs: unknown argument ${JSON.stringify(unknown[0])}\nusage: node scripts/prereqs.mjs [--hosts] [--json]`);
    process.exit(2);
  }
  const result = checkPrerequisites({ hosts: args.includes('--hosts') });
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const c of result.checks) {
      console.log(`${c.ok ? 'ok  ' : 'MISSING'} ${c.tool}${c.version ? ` (${c.version.split('\n')[0]})` : ''}${c.ok ? '' : ` — ${c.fix}`}`);
    }
  }
  process.exitCode = result.ok ? 0 : 1;
}
