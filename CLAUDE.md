<!-- OVERLORD PROJECT METADATA PROTECTION: START -->
## Overlord project metadata — do not edit

`.overlord/project.json` is exclusively managed by Overlord. Do not edit,
replace, stage, commit, delete, or revert it. If its link metadata needs to
change, use Overlord's resource-linking command instead.
<!-- OVERLORD PROJECT METADATA PROTECTION: END -->

## Marketplace repository rules

This repository is the `Overlord` plugin marketplace for Codex and Claude Code. Read
`docs/contracts.md` before changing sources, catalogs, schemas or tooling, and
`RELEASING.md` before anything that publishes.

- Never hand-edit generated files: `plugins/**`, `sources/*.lock.json`, or the
  source-owned entries in `.agents/plugins/marketplace.json` and
  `.claude-plugin/marketplace.json`. They change only through `npm run ingest`.
- `sources/<id>.json` pointers and `policy/legacy-entries.json` are reviewed by hand.
  Preserve every unrelated or legacy catalog entry.
- Run `npm test` and `npm run validate` after any change.
- Never commit credentials, tokens, private keys or personal paths. Test homes go under
  `.smoke/` or a temp directory, never real `~/.codex` or `~/.claude` state.
- Never push, force-push, activate workflows or migrate installed plugins without
  explicit authorization; never overwrite the remote with a fresh local history.
- `.overlord/` is managed by Overlord (see above).
