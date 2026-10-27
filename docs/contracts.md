# Source, lock and catalog contract

This is the v1 contract the marketplace tooling implements. Ingest (`scripts/ingest.mjs`),
validation (`scripts/validate.mjs`) and smoke tests (`scripts/smoke.sh`) must agree with it.
Fixed values live in [`scripts/lib/policy.mjs`](../scripts/lib/policy.mjs); the JSON
schemas live in [`schemas/`](../schemas). Changing either is a reviewed policy change, not
part of a release.

Authoritative plan: Overlord `planning/feature-plans/coo-1232-git-plugin-marketplace.md`.

## Scope

| Item | v1 value |
| --- | --- |
| Marketplace name | `Overlord` in both catalogs. Case-sensitive: `@overlord` does not resolve. |
| Hosts | `codex` (Codex CLI; desktop unverified) and `claude-code` (Claude Code CLI). |
| Plugins | `knowledgebase` only. Overlord's own plugin and Scribe are out of scope. |
| Plugin ids | `knowledgebase@Overlord` in both hosts. |
| Surface policy | `remote-http-mcp-only`: skills, static assets and remote HTTPS MCP servers. |

## Ownership

Every path has exactly one writer. `npm run validate` rejects generated paths and catalog
entries that no source or legacy record owns.

| Path | Contents | Written by |
| --- | --- | --- |
| `sources/<id>.json` | Source pointer: where releases come from and the policy they must meet | Human, reviewed PR |
| `sources/<id>.lock.json` | What ingest fetched: version and digests | `npm run ingest` only |
| `plugins/codex/<id>/` | Codex package, byte-identical to the ZIP below `zipRoot` | `npm run ingest` only |
| `plugins/claude-code/<id>/` | Claude Code package, byte-identical to its ZIP | `npm run ingest` only |
| `.agents/plugins/marketplace.json` | Codex catalog | Ingest (its own entry); humans for top-level fields |
| `.claude-plugin/marketplace.json` | Claude Code catalog | Ingest (its own entry); humans for top-level fields |
| `policy/legacy-entries.json` | Catalog entries not owned by a source | Human, separately scoped PR |
| `schemas/`, `scripts/`, `test/`, docs | Tooling and policy | Human, reviewed PR |
| `.github/workflows/`, `.gitleaks.toml` | CI and scanner policy | Human, reviewed PR; never staged by ingest |
| Branch `sync/<id>` | Pending release PR for one plugin | `ingest.yml` App bot only (see below) |
| `.overlord/` | Overlord project metadata | Overlord only; never edit or commit changes |
| `.tmp/`, `.smoke/` | Ingest staging/journal and smoke homes | Tools; ignored by Git |

Source ids are discovered from file names: `sources/<id>.json` where `<id>` is bounded
kebab-case (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, at most 64 characters). Any other file in
`sources/` is an error. Ingest accepts only a discovered id; there is no URL override.

## Source pointer

Schema: [`schemas/source.schema.json`](../schemas/source.schema.json). Rules the schema
cannot express are in `checkSourceSemantics` ([`scripts/lib/sources.mjs`](../scripts/lib/sources.mjs)).

- `plugin` equals the file id.
- `deploymentUrl` is a canonical HTTPS origin: lowercase host, no path, trailing slash,
  port, query, fragment or userinfo. The index and every artifact URL must share it.
- `index` is an absolute path on that origin with no `.`/`..` segments or query.
- `hosts` has exactly `codex` and `claude-code`:
  - `indexField`: dotted path in the index to the host's ZIP URL
    (`codex.plugin_package`, `claude.claude_code.plugin_package`).
  - `zipRoot`: archive prefix stripped exactly once; `""` or one directory segment
    ending in `/`. Entries outside it are rejected.
  - `target`: exactly `plugins/<host>/<plugin>`.
  - `manifest`: Codex `plugin.json` or `.codex-plugin/plugin.json`; Claude
    `.claude-plugin/plugin.json`.
  - `catalogEntry`: the reviewed catalog fields (below). It cannot set `name`, `source`
    or `version`.
- `allowedMcpOrigins`, `allowedMcpUrls`, `expectedMcpServers`: the exact MCP identity.
  Each URL must be exact HTTPS with no userinfo, port, query or fragment, on an allowed
  origin.
- Limits: `maxArtifactBytes`, `maxExpandedBytes`, `maxFileBytes`, `maxEntries`, each an
  integer under the ceilings in `LIMIT_CEILINGS`, and `maxFileBytes <= maxExpandedBytes`.

The lock records `sourceSha256` over the exact pointer bytes. Any pointer edit therefore
fails validation until it lands with an ingest, and ingest refuses a changed pointer at the
same release version. A deployment URL change needs a higher upstream version
(see [RELEASING.md](../RELEASING.md)).

### Knowledgebase values

| Field | Value |
| --- | --- |
| Deployment | `https://knowledge.chaselubitz.com`, index `/plugins/index.json` |
| Codex artifact | index `codex.plugin_package`, ZIP root `knowledgebase/`, manifest `plugin.json` |
| Claude artifact | index `claude.claude_code.plugin_package`, ZIP root `""`, manifest `.claude-plugin/plugin.json` |
| MCP server | name `knowledgebase`, URL `https://knowledge.chaselubitz.com/mcp` |
| Limits | artifact 5,000,000 B; expanded 20,000,000 B; file 2,000,000 B; 500 entries |

## MCP identity

Each package must register exactly the `expectedMcpServers` names, each with a URL from
`allowedMcpUrls`, and nothing else. The validator takes the union of every place a host can
read servers from, so an override in a second file cannot slip past.

| Host | Where servers may be declared | Required transport |
| --- | --- | --- |
| Codex | Portable root `mcp.json` (discovered by convention), manifest `mcpServers` (path or inline), `extensions.com.openai` overrides | `streamable-http` |
| Claude Code | `.mcp.json` (default or via manifest `mcpServers` path), inline manifest `mcpServers` | `http` |

For Knowledgebase both hosts must resolve to exactly
`knowledgebase → https://knowledge.chaselubitz.com/mcp`. No headers, credentials or
environment interpolation are admitted.

Under `remote-http-mcp-only` the following are rejected, never silently admitted: stdio
servers or any `command`, hooks, scripts, `headersHelper`, installer commands, LSP servers,
remote package sources and registered app mappings. A plugin that needs one (for example
Scribe's local server) needs a new surface policy first.

## Catalog entries

Catalog entries omit `version`; each host reads it from the package manifest.

A source-owned entry must equal `expectedEntry(host, source)`
([`scripts/lib/catalog.mjs`](../scripts/lib/catalog.mjs)):

```json
{ "name": "knowledgebase",
  "source": { "source": "local", "path": "./plugins/codex/knowledgebase" },
  "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
  "category": "Productivity" }
```

```json
{ "name": "knowledgebase",
  "source": "./plugins/claude-code/knowledgebase",
  "description": "Search, read, and write your Knowledgebase knowledge graph.",
  "category": "productivity" }
```

Codex `policy.installation` may be `AVAILABLE` or `NOT_AVAILABLE`; `INSTALLED_BY_DEFAULT`
is excluded so users opt in to every plugin. `authentication` is `ON_INSTALL` or `ON_USE`.

Ingest updates only its own entry with `mergeEntry`: replaced in place when present,
appended otherwise. Top-level fields and every other entry keep their values and order.
A source-owned plugin appears in both catalogs or neither.

### Legacy entries

[`policy/legacy-entries.json`](../policy/legacy-entries.json) lists entries not owned by a
source, such as entries that already existed on the remote. Each listed entry must stay in
its catalog with exactly the recorded value. Removing or rewriting one needs a separately
scoped change that edits this file as well. Legacy entries may not point into `plugins/` or
reuse a source id. The list is empty: the remote held no catalog when this scaffold was
written.

## Lock and digests

Schema: [`schemas/lock.schema.json`](../schemas/lock.schema.json).

| Field | Encoding |
| --- | --- |
| `version` | Strict SemVer 2.0.0; equals the index version and both manifests |
| `sourceSha256` | SHA-256 of the exact `sources/<id>.json` bytes |
| `indexSha256` | SHA-256 of the exact index response body that was accepted |
| `hosts.<h>.zipSha256` | SHA-256 of the downloaded ZIP bytes |
| `hosts.<h>.advertisedSha256` | Optional; the index's checksum for the ZIP. Must equal `zipSha256` |
| `hosts.<h>.treeSha256` | Tree digest of the extracted package (below) |
| `hosts.<h>.fileCount` | Number of regular files in the package |
| `releaseId` | Optional upstream release/source id when the index advertises one |
| `fetchedAt` | UTC `YYYY-MM-DDTHH:MM:SS[.sss]Z`; excluded from every digest |

All hashes are lowercase hex.

**Tree digest.** For every regular file in the package, form the line
`<path> NUL <sha256-hex> LF`, where `<path>` is the plugin-relative POSIX path in UTF-8.
Sort the lines by the UTF-8 bytes of the path, concatenate them and take SHA-256.
Directories, ZIP timestamps, entry order, compression and archive modes do not
contribute. Names with control characters are rejected before hashing. Extracted
directories are 0755 and files 0644.

Test vector: files `a.txt` = `hello\n`, `B.txt` = empty, `skills/x/SKILL.md` = `x\n` sort as
`B.txt`, `a.txt`, `skills/x/SKILL.md` and give
`1647808cd303bfaa69fc1f4b7ca4152628d21507e06afd4a0ce507cb16b24120`.

These digests detect drift between the lock and the packages. They are not evidence of
where the bytes came from: a lock and a package can be changed together in one commit.
Provenance comes from HTTPS, the reviewed PR, and upstream checksums or release ids when
offered.

A verified no-op ingest (same version, same trees, same source) leaves the lock byte for
byte as it was, including `fetchedAt`. A changed ZIP hash with an unchanged tree is
reported in diagnostics only.

## Release rules

| Candidate vs lock | Result |
| --- | --- |
| No lock (first ingest) | Addition: first-install checks |
| Same version, same trees and source | Up to date; no changes |
| Same version, different tree or source bytes | Fail: "artifact changed without a version bump" |
| Lower SemVer precedence | Fail |
| Build metadata differs only | Fail; not an increase |
| Higher SemVer precedence (prereleases compared per SemVer 2.0.0) | Upgrade |

Both host manifests must carry the index version; ingest refetches the index after both
downloads and fails if release fields change. Optional checksum fields use the artifact
field name with `_sha256` appended (for example `codex.plugin_package_sha256`); an
optional release identifier is `release_id`. These fields are verified when present.
The current upstream index advertises neither; another upstream checksum format needs
a reviewed mapping before it can be treated as verified.

## Ingest limits

| Limit | Value |
| --- | --- |
| Request deadline | 15 s per request, including redirects |
| Redirects | At most 3; each hop HTTPS, same origin, no userinfo |
| Index body | 256 KiB, JSON media type |
| Artifact body | `maxArtifactBytes`, counted on the stream (not `Content-Length`) |
| Archive | `maxEntries`, `maxExpandedBytes`, `maxFileBytes`, checked against metadata and actual output |

Ingest stages, journals and backs up under `.tmp/ingest/` and holds `.tmp/ingest.lock` as
its single writer lock. Both live inside the checkout so replacements are same-filesystem
renames. A set of renames is not one atomic operation: the journal lets the next run
restore the last good release after an interruption, and the reviewed Git commit is the
publication boundary for users.

## Validation states

`npm run validate` reports one of two states:

- `bootstrap`: no source has a lock. Catalogs hold only legacy entries (none in v1), and
  `plugins/` holds nothing. Each declared source is listed as awaiting its first ingest.
  This is an accepted state, not a skipped check: catalogs, sources, the legacy policy and
  ownership are fully validated.
- `released`: at least one locked source. Its packages, MCP identity, hygiene and tree
  digests must verify.

Released-state validation checks both package trees and their lock digests, manifests, skill identity and bytes, MCP declarations, local references and v1 hygiene. `node scripts/validate.mjs --base <full-commit-sha>` also compares actual package bytes and source pointers with an immutable Git baseline; additions, unchanged releases and version increases are reported separately, while removals, downgrades and same-precedence content changes fail. The package verifier deliberately admits only the documented v1 manifest subset and rejects unsupported surfaces.

The ZIP helper `scripts/lib/zip.py` extracts into a new staging directory using explicit artifact, expanded, per-file and entry limits. It does not publish packages; ingest must invoke it and validate the complete candidate before any live replacement.

## Release PRs (ingest.yml)

`scripts/ci.mjs` implements the automated path; `RELEASING.md` explains it for maintainers.

- **Request.** `workflow_dispatch` takes `plugin` as `all` or one discovered source id.
  A schedule means all sources. `repository_dispatch` (`plugin-release`) requires
  `client_payload.plugin` to be one discovered id. Anything else fails before ingest runs.
- **Prepare (no credentials).** Each id is ingested in a fresh worktree of the `main`
  commit. A plugin may change only its owned paths: `plugins/codex/<id>`,
  `plugins/claude-code/<id>`, `sources/<id>.lock.json` and the two catalogs. The bundle
  holds `manifest.json` (`bundleVersion`, `base`, per-plugin status) and, per updated
  plugin, `payload.tar`, `report.json`, `title.txt` and `body.md`.
- **Publish.** The bundle must name the checked-out base. Its payload may contain only
  regular files and directories under that plugin's owned paths. After applying it the
  repository must validate. The commit author and committer are the App bot
  (`<slug>[bot]`, `<id>+<slug>[bot]@users.noreply.github.com`). The branch is
  `sync/<id>`, rebuilt on the base and pushed with `--force-with-lease`. Any non-bot commit
  or non-bot open PR on it stops publication for that plugin.
- **PR marker.** The PR body and commit message carry
  `<!-- overlord-ingest:v1 plugin=<id> version=<version> -->`. A closed, unmerged PR with
  the same marker is not reopened.

## Observed live release (informational)

Fetched 2026-10-27 without credentials. This is not a lock; the endpoints are mutable.

| Item | Value |
| --- | --- |
| Index version | `0.1.1` (`cache-control: public, max-age=300`, `application/json`) |
| Index body SHA-256 | `ef8f8d8c3827c76d9d5c76d3cc154c9a2ec6cef67d6d64acbba783d45e044348` |
| Codex ZIP | 260,979 B, SHA-256 `d8e16d43995ff016d90a3807311849deac2289bffc4e123a7ad3ff824f916a93`, 7 files, tree `1b8163de370c25490a4ea21a67f1cc197b421b4191a19af636eac1722d43bf69` |
| Claude Code ZIP | 33,377 B, SHA-256 `e1ce2349e6064ac8a10e386bb8ea4e2cbeaf66bf22a83b3cb6af2987b8184a03`, 5 files, tree `cb89d28689a9c627d0eab729db900512a29ea002bfa1a66fdd0f39eacf4ab560` |
| Archive shape | Stored (no compression), no directory entries, external mode bits 0 |
| Manifests | Both `license: "UNLICENSED"`; Codex uses the agent-plugins.org root `plugin.json` with `extensions.com.openai` |
| Index advertises checksums or release id | No |
