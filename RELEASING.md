# Releasing

How plugin releases enter this marketplace, what CI checks, and what remains before
publication. The contract the tooling enforces is in [docs/contracts.md](docs/contracts.md).
The full plan is Overlord `planning/feature-plans/coo-1232-git-plugin-marketplace.md`
(mission coo:1232).

## Release boundaries

- **Upstream release.** A plugin release starts in the plugin's own project, which
  publishes rendered packages for each host. For Knowledgebase these are
  `/plugins/index.json` and two ZIPs on its deployment. This repository never renders
  packages or reads private source.
- **Ingest.** `npm run ingest -- --plugin <id>` fetches those public artifacts, validates
  them and rewrites only that plugin's generated paths, lock and catalog entries.
  Automated ingest opens a pull request. It never pushes to `main`.
- **Release.** Merging the reviewed PR into `main` is the release. There is no other
  publication step and no automatic merge in v1.
- **Delivery.** Users get the release the next time they run the explicit update commands
  in [README.md](README.md). Nothing is pushed to installed clients.

## Supported scope

The v1 candidate targets Knowledgebase for Codex CLI and Claude Code CLI under the
marketplace name `Overlord`. Authenticated runtime acceptance is still pending for both;
desktop support is unverified, and no public installation is claimed yet.
Adding a plugin needs:

- a reviewed `sources/<id>.json`;
- native smoke coverage (`SMOKE_PLUGINS` in `scripts/ci.mjs` makes an uncovered released
  plugin fail CI);
- a new surface policy if its package contains anything beyond skills and remote HTTPS
  MCP servers.

Overlord's own plugin and Scribe are out of scope until they publish release artifacts and
their policies exist.

## Release workflow

1. **Release upstream.** Bump the plugin version (Knowledgebase: `serverInfo().version`)
   and deploy. Every content change needs a higher version: ingest refuses changed
   packages, or a changed source pointer, at the same version.
2. **Ingest.** [`ingest.yml`](.github/workflows/ingest.yml) opens or updates the PR
   `knowledgebase <old> → <new>` from branch `sync/knowledgebase`. Triggers:
   - the scheduled poll, every 6 hours (best effort; not a delivery guarantee);
   - *Actions → ingest → Run workflow* with `plugin` set to a source id or `all`;
   - a `repository_dispatch` of type `plugin-release` with `{"plugin": "knowledgebase"}`.

   A failed or delayed poll leaves the previous release in place and reports the failure
   in the job summary.
3. **Review.** The PR body lists the version, index/source/ZIP/tree hashes and the changed
   files per host. Read the skill diffs. [`validate.yml`](.github/workflows/validate.yml)
   must pass. It runs the upgrade from the PR base on Linux and macOS.
4. **Merge.** Squash or rebase onto an up-to-date `main`. If `main` moved after the PR
   was opened, the next ingest run rebuilds the branch; you can also dispatch ingest
   manually. Merging releases the update.

### Bot branch rules

- `sync/<plugin>` belongs to the App bot. Ingest rebuilds it from current `main` and
  updates it with `--force-with-lease` only if every commit on it, and the open PR, are the
  bot's.
- **A human commit or a human-opened PR on that branch stops automation for that plugin.**
  The workflow reports an error and leaves the branch alone. To hand the branch back to
  the bot, delete it.
- Reruns are idempotent. An unchanged candidate is not pushed again, and an existing open
  PR is edited rather than duplicated.
- **A release PR closed without merging is not reopened for the same version.** Publish a
  higher upstream version, or reopen the PR yourself.
- Ingest stages only the plugin's two host directories, its lockfile and the two catalogs.
  It never commits source pointers, workflows or tooling.

### Recover a bad release

1. Pause ingest if needed: `gh workflow disable ingest.yml --repo cooperativ-labs/overlord-marketplace`.
2. Publish a **higher** upstream version containing the last good content, and let its PR
   pass review and merge.
3. Users refresh as usual. A Git revert alone is not a tested client rollback, and hosts
   are not assumed to downgrade.

The README describes a separate, user-owned emergency reinstall from a pinned commit.

### Change the deployment URL (rehost)

1. Deploy a **higher** plugin version at the new host.
2. In one PR, edit `sources/<id>.json` (`deploymentUrl`, `allowedMcpOrigins`,
   `allowedMcpUrls`). Then run `npm run ingest -- --plugin <id>` locally so the PR
   carries both host packages, the lock and the catalogs.
3. Complete the new origin's OAuth/consent checks before advertising it.

A pointer edit at the same version fails validation, and ingest never rewrites endpoints.
Pointer changes are human PRs; the ingest bot never stages them.

## CI

All workflows pin third-party actions by commit SHA. They pass event text only through
environment variables, never as shell code. Each runs repository code only from `main`
or from the candidate under test.

| Workflow | Runs on | Permissions | What it checks or does |
| --- | --- | --- | --- |
| `validate.yml` | `pull_request`, push to `main` | `contents: read`; no secrets | See below |
| `ingest.yml` | schedule, dispatch, `repository_dispatch` | `contents: read`; App token only in the publish step | See below |
| `cli-drift.yml` | Weekly, manual | Smoke job `contents: read`; report job `issues: write` only | See below |

**`validate.yml`** runs the matrix job `checks` on `ubuntu-24.04` and `macos-15`:

- `npm test`;
- `validate.mjs`, with `--base <immutable PR base SHA>` on PRs;
- the pinned CLIs (`CODEX_VERSION`, `CLAUDE_CODE_VERSION`);
- `claude plugin validate` on the marketplace and every Claude package;
- the synthetic A→B smoke (upgrade, first addition and docs-only) on every run;
- the released-plugin smoke, chosen by `ci.mjs smoke-plan`:
  - `compare` on PRs runs `smoke.sh . --upgrade-from <base>`, which covers a first
    addition, an upgrade or an unchanged refresh;
  - `fresh` on `main`;
  - `bootstrap` when nothing is released yet.

A separate `distribution-scan` job runs pinned Gitleaks in directory mode with
[`.gitleaks.toml`](.gitleaks.toml), then the personal path/email audit. The required check
is the aggregate job **`validate`**. It fails on any failed, cancelled or skipped
dependency.

**`ingest.yml`** runs only from `main`, and every trigger shares one concurrency group:

- **`prepare`** (no credentials) resolves the requested ids against `sources/`. It ingests
  each plugin in a clean worktree, rejects changes outside that plugin's generated paths,
  and uploads a bundle.
- **`publish`** checks out the same `main` commit and re-verifies the bundle. Only then
  does it mint the scoped App token. It commits as the App bot, pushes `sync/<plugin>`
  and opens or edits the PR.

GitHub keeps only the newest pending run in a concurrency group. A superseded dispatch is
picked up by the next poll.

**`cli-drift.yml`** installs the latest CLIs on both operating systems and records the
resolved versions. It runs the synthetic smoke, plus the released-plugin smoke once a
release exists. The report job keeps one open issue titled "CLI drift: native smoke fails
with the latest host CLIs", comments on it while drift continues, and closes it on
recovery.

**Moving the CLI pins.** Update `CODEX_VERSION` and `CLAUDE_CODE_VERSION` in
`validate.yml` only after `cli-drift.yml` passes with those versions. Update the Gitleaks
version and its SHA-256 together from the release checksums file.

## Local commands

```sh
npm run prereqs            # Node >= 22, Python 3 (zipfile), git; add -- --hosts for codex/claude
npm test                   # unit, policy, ingest, CI-helper and workflow-policy tests
npm run validate           # offline repository validation; add -- --base <sha> to compare
npm run ingest -- --plugin knowledgebase [--dry-run]
npm run smoke -- <repo-dir> [--upgrade-from <commit>]  # native install/refresh in isolated homes
node scripts/synthetic-smoke.mjs [--matrix]            # fixture A -> B; matrix adds first-addition and docs-only
node scripts/ci.mjs audit                              # personal paths and email addresses
```

The workflow-policy test parses the workflows with Ruby's standard YAML library. It skips
locally when Ruby is missing and fails in CI.

## Implementation status

| Phase | State |
| --- | --- |
| 1. Scaffold: catalogs, source pointer, schemas, ownership checks | Done locally |
| 2. Validator, ZIP helper, ingest | Done locally |
| 3–4. First ingest, isolated two-version smoke tests | Automated CLI checks done locally; authenticated and desktop gates pending |
| 5. GitHub workflows | Authored and checked locally; **not activated** (nothing pushed) |
| 6. Publication | Not authorized |

## Publication prerequisites

The unchecked items remain publication gates; external actions need explicit authorization.

- [ ] **Redistribution and notices.**
  - On 2026-10-27 the owner added an MIT `LICENSE` to the Knowledgebase repository
    (upstream commit `a13ae23`).
  - The released packages do not reflect it yet. Both 0.1.1 manifests still declare
    `"license": "UNLICENSED"`, and neither ZIP includes license text. MIT requires the
    copyright and permission notice to accompany copies.
  - **Recommended:** an upstream Knowledgebase release (0.1.2 or later) that sets
    `"license": "MIT"` in `packages/plugins/chatgpt/plugin.json` and
    `packages/plugins/claude-code/.claude-plugin/plugin.json`, and ships `LICENSE` in
    both rendered ZIPs. Ingest that release before publishing. Coordinate it through
    per:214.
  - **Alternative:** the owner records written permission here, with date and scope, to
    publish 0.1.1 as shipped.
  - Ingest never relabels or adds notices.
  - On 2026-10-27 the owner authorized MIT licensing for this repository's original
    tooling and documentation. The root `LICENSE` carries the full text and
    `package.json` declares `MIT`. Redistributed plugins retain their upstream terms
    and notices; the root license does not relabel them.
- [ ] **Acceptance gates.** The final acceptance objective runs the complete Phases 2–5
      matrix. Host support is claimed only for gates that pass (see
      [Last verified](#last-verified)).
- [ ] **Remote.** `https://github.com/cooperativ-labs/overlord-marketplace.git`. On
      2026-10-27 its `main` was `66600f8` ("git init"), the base of this checkout.
      Recheck with `git ls-remote` before pushing. Build on the remote history; never
      force-push over it.
- [ ] **Activation.** Pushing `.github/workflows/` enables the 6-hourly ingest schedule
      and the weekly drift issue writer. Authorize that together with the push.

### Publication setup (after authorization)

1. **Push.** Commit the reviewed candidate on top of `66600f8`, leaving
   `.overlord/project.json` as Overlord manages it. Then run
   `git push origin main` (no force).
2. **Create the GitHub App.** In *GitHub → cooperativ-labs → Settings → Developer
   settings → GitHub Apps → New GitHub App*:
   - name it, for example, "Overlord Marketplace Bot";
   - disable the webhook;
   - grant repository permissions **Contents: Read and write**, **Pull requests: Read and
     write** and **Metadata: Read** (mandatory), and nothing else;
   - set "Only on this account".

   Then:
   - Install it on **only** `cooperativ-labs/overlord-marketplace`. This is enough even
     though plugins come from other accounts: ingest reads their public release artifacts
     over HTTPS and needs no access to their repositories.
   - Generate a private key.
3. **Store the credentials** (the Client ID is not secret; the key is):

   ```sh
   gh variable set MARKETPLACE_APP_CLIENT_ID --repo cooperativ-labs/overlord-marketplace --body '<client id>'
   gh secret set MARKETPLACE_APP_PRIVATE_KEY --repo cooperativ-labs/overlord-marketplace < <downloaded-key>.pem
   ```

   Delete the local key file afterwards. Earlier plans named `MARKETPLACE_APP_ID`. The
   pinned `actions/create-github-app-token` v3.3.0 deprecates `app-id` in favor of
   `client-id`, so the workflow reads the Client ID variable instead.
4. **Actions settings.** Set default workflow permissions to read-only, and keep approval
   required for fork PRs from first-time contributors. "Allow GitHub Actions to create
   pull requests" is not needed, because the App opens the PRs.
5. **Ruleset for `main`.** Require a PR with one approval, the status check `validate`,
   up-to-date branches and linear history. Block force pushes and deletion, with no
   bypass actors:

   ```sh
   gh api -X POST repos/cooperativ-labs/overlord-marketplace/rulesets --input - <<'JSON'
   {"name": "main", "target": "branch", "enforcement": "active",
    "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
    "bypass_actors": [],
    "rules": [
      {"type": "deletion"}, {"type": "non_fast_forward"}, {"type": "required_linear_history"},
      {"type": "pull_request", "parameters": {"required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true, "require_code_owner_review": false,
        "require_last_push_approval": true, "required_review_thread_resolution": false}},
      {"type": "required_status_checks", "parameters": {"strict_required_status_checks_policy": true,
        "required_status_checks": [{"context": "validate"}]}}]}
   JSON
   ```

   One approval cannot come from the PR's author. A single maintainer can approve bot
   release PRs but not their own tooling PRs. Decide on a second reviewer before
   enabling this ruleset; removing review or adding a bypass weakens the release gate.
6. **First runs.** Confirm `validate` passes on `main`. Then run
   `gh workflow run ingest.yml --repo cooperativ-labs/overlord-marketplace -f plugin=all`.
   Expect `up-to-date` in the job summary unless upstream has released since the
   committed lock.
7. **Public first install.** In disposable Codex and Claude profiles (never the
   maintainer's real ones):
   - register `cooperativ-labs/overlord-marketplace`;
   - confirm the available entry, then install `knowledgebase@Overlord`;
   - check the installed and enabled version, tree hashes, endpoint and fresh-session
     behavior.

   Only then remove the README status notice. A public repository alone is not an
   installable release.
8. **Live upgrade.** Claim this only after a genuine later upstream release has been
   ingested and merged, and the native refresh commands load it in a fresh session.

## Last verified

Final local acceptance rerun, 2026-10-27: Node 26.12.1, Codex CLI 0.164.0 and
Claude Code 2.1.311 on macOS. The 98 tests and released-state validation passed,
including extraction, ingest failure and interruption recovery, baseline comparisons,
and workflow policy and disposable bot-publish fixtures. The immutable base
`66600f8ec567ae9fbb8c8d7923cf326f27e099fc` reports a first addition; local
marketplace and Claude package validation, personal-path/email audit, and the isolated
released-candidate first-install/migration/refresh smoke passed. The synthetic matrix
checks A → B, addition and unchanged baseline paths in both hosts.

This rerun could not fetch the live index (`index: fetch failed`) or query remote refs
(proxy CONNECT returned 403). The live ingest and remote ref observations below are
earlier evidence, not fresh verification. Gitleaks is unavailable locally, so the full
distribution secret scan remains an unsatisfied publication gate; the structural package
checks and path/email audit are not a substitute. GitHub-hosted Linux/macOS workflow
execution also remains pending. No isolated authenticated host credentials were available
for fresh-session skill inventory and actual invocation or authorized read-only MCP/OAuth;
both CLI runtime gates remain pending. Desktop is separately unverified. These gaps
preclude advertising either host as fully accepted.

### Publication handoff

The review candidate is the local marketplace tooling, workflows, policies, two catalogs,
and the unmodified Knowledgebase 0.1.1 host packages and lock described below; it excludes
Overlord and Scribe. Its local base is `66600f8ec567ae9fbb8c8d7923cf326f27e099fc`;
the last successful remote observation found `main` at that same commit. Recheck all
remote refs before publication, since this rerun could not reach GitHub. Candidate files
are uncommitted; prepare and review their exact content without including `.overlord/`.

Publication is blocked until the owner establishes redistribution permission and required
notices for both rendered packages, completes the full secret
scan and authenticated acceptance for each host to be advertised, and rechecks live
release and remote refs. A higher upstream release with MIT notices is the recommended
path; do not edit the generated packages to add them. The public first-install, desktop,
and later real-release upgrade observations are separate gates as described above.

After those prerequisites, explicit authorization is still needed to commit and push the
reviewed candidate to the existing remote without rewriting its history, activate the
scheduled ingest and issue-writing workflows, create/install the repository-scoped App,
store its Client ID variable and private-key secret, and configure the no-bypass `main`
ruleset requiring `validate` and review. The exact settings and first validation and
no-op ingest dispatch commands are in Publication setup above. GitHub-hosted workflow
results and public first-install evidence must be obtained after those actions; per:214
onboarding waits for the latter. Real user plugin migration is not authorized.

### Earlier local evidence

2026-10-27, local macOS, Codex CLI 0.164.0 and Claude Code 2.1.311:

- **Live release.** A fresh public ingest and isolated first install of Knowledgebase
  **0.1.1** passed in both CLIs.

  | | SHA-256 |
  | --- | --- |
  | Index | `ef8f8d8c3827c76d9d5c76d3cc154c9a2ec6cef67d6d64acbba783d45e044348` |
  | Codex ZIP | `d8e16d43995ff016d90a3807311849deac2289bffc4e123a7ad3ff824f916a93` |
  | Codex tree | `1b8163de370c25490a4ea21a67f1cc197b421b4191a19af636eac1722d43bf69` |
  | Claude ZIP | `e1ce2349e6064ac8a10e386bb8ea4e2cbeaf66bf22a83b3cb6af2987b8184a03` |
  | Claude tree | `cb89d28689a9c627d0eab729db900512a29ea002bfa1a66fdd0f39eacf4ab560` |

- **Synthetic releases.** **1.0.0 → 1.1.0**, first-addition and unchanged/docs-only cases
  passed native install and refresh. The checks covered changed skill bytes, active
  package tree digests, repeated refresh, unrelated state and legacy/standalone migration.

  | Tree SHA-256 | Codex | Claude |
  | --- | --- | --- |
  | A (1.0.0) | `e7b978c8b36da462fd717ad1e1081f88731197e905c6a45a4c468c00e633e728` | `ea46564d489e336729689ade76a51ba80b3046d58298210dd87dd6a1d65288d2` |
  | B (1.1.0) | `93655ae9df2005ab0f7e1678e8463c19573d167f07abe5c96759834215212f3e` | `250287ff07b3b3fa68c1d4171e909cd92d0bb6c3dd1c4ee212da064b42334d59` |

  Migration observations:
  - Codex's inventory merged the two enabled legacy/new plugin-owned servers into one
    named entry. Both plugin records and their endpoint declarations were checked.
  - The standalone server appeared separately. After migration one endpoint remained.
  - Codex removed the old version cache; Claude kept both folders with one active record.

  These are disposable fixture releases, not public upgrade evidence.
- **Workflow commands.** Each locally executable command the workflows run passed against
  this checkout:
  - `npm test` (98 tests, including CI-helper and workflow-policy tests);
  - `ci.mjs baseline` and `validate.mjs --base 66600f8…` (first addition);
  - `ci.mjs smoke-plan` (`compare`) and `ci.mjs audit`;
  - `claude plugin validate` for the marketplace and the Claude package;
  - `smoke.sh . --upgrade-from 66600f8…`;
  - `synthetic-smoke.mjs --matrix`.

  The CI helper's prepare/verify/publish flow was exercised against a disposable bare
  remote with a fake `gh`. It covered idempotent reruns, human-commit and human-PR stops,
  closed-PR handling and tampered bundles. **Not run locally:** Gitleaks and actionlint
  (running downloaded binaries was not permitted in this session), and GitHub-hosted
  execution of any workflow. Workflow syntax was checked by parsing the YAML and running
  `bash -n` on every `run` block.
- **Not verified:**
  - Authenticated fresh-session skill inventory/invocation and read-only MCP/OAuth.
  - Desktop.
  - Static cache and MCP inventory, which do not establish runtime skill loading.
  - OS credential-store effects. One earlier disposable migration run used
    `codex mcp add`, which started OAuth and reported a successful login. The harness now
    seeds static configuration and does not run that command.

No production publication, real installation migration, or public upgrade has been verified.
