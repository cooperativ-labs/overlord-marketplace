// Fixed distribution policy shared by validate, ingest and smoke.
// Values here are the v1 contract described in docs/contracts.md. Changing one is a
// reviewed policy change, never a per-release edit.

export const MARKETPLACE_NAME = 'Overlord';

// Supported v1 hosts. Each host has its own catalog file and its own unmodified
// copy of the upstream render under plugins/<host>/<plugin>.
export const HOSTS = Object.freeze({
  codex: Object.freeze({
    catalog: '.agents/plugins/marketplace.json',
    targetPrefix: 'plugins/codex',
    manifests: Object.freeze(['plugin.json', '.codex-plugin/plugin.json']),
    mcpTransport: 'streamable-http',
  }),
  'claude-code': Object.freeze({
    catalog: '.claude-plugin/marketplace.json',
    targetPrefix: 'plugins/claude-code',
    manifests: Object.freeze(['.claude-plugin/plugin.json']),
    mcpTransport: 'http',
  }),
});

export const HOST_IDS = Object.freeze(Object.keys(HOSTS));

export const SOURCES_DIR = 'sources';
export const PLUGINS_DIR = 'plugins';
export const LEGACY_POLICY_PATH = 'policy/legacy-entries.json';
export const SOURCE_SCHEMA_PATH = 'schemas/source.schema.json';
export const LOCK_SCHEMA_PATH = 'schemas/lock.schema.json';
export const LEGACY_SCHEMA_PATH = 'schemas/legacy-entries.schema.json';

// Source ids are discovered from sources/<id>.json. Bounded kebab-case; no path
// separators, dots or uppercase, so an id can never name another path.
export const SOURCE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const SOURCE_ID_MAX_LENGTH = 64;

// Ingest network and transaction limits (Phase 2). Per-source artifact limits live in
// the source pointer but may never exceed these ceilings.
export const INGEST = Object.freeze({
  requestDeadlineMs: 15_000,
  maxIndexBytes: 256 * 1024,
  maxRedirects: 3,
  workDir: '.tmp/ingest',
  lockFile: '.tmp/ingest.lock',
});

export const LIMIT_CEILINGS = Object.freeze({
  maxArtifactBytes: 50_000_000,
  maxExpandedBytes: 200_000_000,
  maxFileBytes: 2_000_000,
  maxEntries: 5_000,
});

// Admitted file modes after extraction. Archive-supplied modes are never preserved.
export const FILE_MODE = 0o644;
export const DIR_MODE = 0o755;

// The only surface policy in v1: remote HTTPS MCP servers plus skills and static
// assets. Everything below is rejected for such a source.
export const SURFACE_POLICIES = Object.freeze(['remote-http-mcp-only']);
export const FORBIDDEN_SURFACES = Object.freeze([
  'stdio MCP servers / command',
  'hooks',
  'scripts',
  'headersHelper',
  'installer commands',
  'LSP servers',
  'remote package sources',
  'registered app mappings',
]);
