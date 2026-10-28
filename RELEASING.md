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
| 5. GitHub workflows | Ingest/App, release-PR validate and post-merge Linux/macOS validate passed |
| 6. Publication | Knowledgebase 0.1.2 published; public first install/unchanged refresh passed in both CLIs |

## Publication prerequisites

The unchecked items remain publication gates; external actions need explicit authorization.

- [x] **Redistribution and notices.**
  - On 2026-10-27 the owner added an MIT `LICENSE` to the Knowledgebase repository
    (upstream commit `a13ae23`).
  - Public Knowledgebase 0.1.2 was fetched and ingested on 2026-10-27. Both manifests
    declare `"license": "MIT"`, and both rendered ZIPs include the full MIT `LICENSE`,
    byte-identical to this repository's notice naming Jacob Chase-Lubitz.
    Public main now packages 0.1.2 after release PR #1 merged.
  - Ingest never relabels or adds notices.
  - On 2026-10-27 the owner authorized MIT licensing for this repository's original
    tooling and documentation. The root `LICENSE` carries the full text and
    `package.json` declares `MIT`. Redistributed plugins retain their upstream terms
    and notices; the root license does not relabel them.
- [ ] **Acceptance gates.** The final acceptance objective runs the complete Phases 2–5
      matrix. Host support is claimed only for gates that pass (see
      [Last verified](#last-verified)).
- [x] **Remote.** `https://github.com/cooperativ-labs/overlord-marketplace.git`. On
      2026-10-27 its `main` was freshly verified at `2f825a7` (packaging 0.1.2).
      Recheck with `git ls-remote` before pushing. Build on the remote history; never
      force-push over it.
- [x] **Activation.** Workflows are present on public main; the owner ran ingest and
      merged its release PR. Client ID and private-key configuration produced the bot PR.
      Additional agent dispatches or configuration changes still need authorization.

### Publication setup (after authorization)

1. **Publish through a PR.** Preserve current remote history and leave
   `.overlord/project.json` as Overlord manages it. Publish a review branch and merge
   its PR after `validate` passes. Initial publication is complete; direct pushes to
   `main` are protected by the ruleset.
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
5. **Ruleset for `main`.** The owner selected a solo-maintainer policy: require a PR
   with zero mandatory approvals, the status check `validate`,
   up-to-date branches and linear history. Block force pushes and deletion, with no
   bypass actors:

   ```sh
   gh api -X POST repos/cooperativ-labs/overlord-marketplace/rulesets --input - <<'JSON'
   {"name": "main", "target": "branch", "enforcement": "active",
    "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
    "bypass_actors": [],
    "rules": [
      {"type": "deletion"}, {"type": "non_fast_forward"}, {"type": "required_linear_history"},
      {"type": "pull_request", "parameters": {"required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false, "require_code_owner_review": false,
        "require_last_push_approval": false, "required_review_thread_resolution": false}},
      {"type": "required_status_checks", "parameters": {"strict_required_status_checks_policy": true,
        "required_status_checks": [{"context": "validate"}]}}]}
   JSON
   ```

   The maintainer reviews the diff and merges manually after CI passes. A second person
   is not required. Keep the bypass list empty. The required check is the aggregate
   `validate` check; requiring CodeQL results is a separate policy that needs an actual
   CodeQL setup. The live ruleset matches the solo policy (stale-approval dismissal
   remains enabled but does not require a reviewer when mandatory approvals are zero).
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

### Public Knowledgebase 0.1.2, 2026-10-27

[Release PR #1](https://github.com/cooperativ-labs/overlord-marketplace/pull/1) merged
at 17:39:37 UTC as `2f825a7968c232d091b95c44d49566321d1c5765`. Its Linux/macOS
[validate run](https://github.com/cooperativ-labs/overlord-marketplace/actions/runs/40548374114)
and the App-backed
[ingest run](https://github.com/cooperativ-labs/overlord-marketplace/actions/runs/40548286911)
passed. Post-merge [validate](https://github.com/cooperativ-labs/overlord-marketplace/actions/runs/40552681776)
passed, including Linux/macOS checks, distribution scan and the aggregate `validate` job.

Independently registered `cooperativ-labs/overlord-marketplace` in disposable profiles
with Codex CLI 0.164.0 and Claude Code 2.1.311. Both installed/enabled
`knowledgebase@Overlord` 0.1.2. Full installed trees, all three skill files and the exact
Knowledgebase MCP endpoint matched the published lock. Native refresh against public
GitHub left version/content unchanged. A fresh ingest in the public clone reported
`up-to-date` with no ZIP changes. No real user plugin configuration or credentials were
copied or modified.

The owner separately reports successful installation in Claude and ChatGPT and that
agents can reach Knowledgebase. This is owner-reported connectivity evidence; automated
checks here do not prove authenticated skill invocation or add desktop/ChatGPT to the
formally tested CLI scope. A genuine public version-transition refresh remains pending;
local 0.1.1-to-0.1.2 upgrade evidence is separate.

After explicit owner approval, the post-merge hosted
[ingest check](https://github.com/cooperativ-labs/overlord-marketplace/actions/runs/40553374416)
succeeded on the published commit: `prepare` passed, `publish` was skipped and no new
release PR was opened. This confirms the expected no-op independently of the local run.

### Earlier Knowledgebase 0.1.2 candidate verification

Fetched the public release through the normal ingest path, with no private source access.
Both manifests report 0.1.2/MIT and both package roots contain the complete MIT license.
The lock records:

| Item | SHA-256 |
| --- | --- |
| Index | `951fbf9f197b33c378550734dd0a238030052fd29ab9767a4319ede55a1edfd8` |
| Codex ZIP | `e70c26460383442c47cc79922fb0397106793bd88209e9801f50e22bafb33be3` |
| Codex tree | `de62dd824072ec5f0f53671038d676da196fe38836386e72ea012caef65fedf1` |
| Claude Code ZIP | `5baa369ce0fe20c6c0eb099f90689e25ea8dc838dc29f6e2dbf180a32748f810` |
| Claude Code tree | `a44a23c205bb67b31aba7008a1cb84ac8dc9350b8615c9e6d647dfe7672b1ecb` |

All 98 tests, released validation, immutable comparison with public `main`, personal-path/
email audit and disposable native-host first-install/refresh/migration checks passed.
The disposable two-host upgrade from public 0.1.1 to candidate 0.1.2 also passed,
including active versions/trees, repeat refresh and unrelated-state preservation.
Gitleaks 8.30.1 (temporary Darwin arm64 binary, checked against its release checksum)
scanned the distribution with the repository configuration and found no leaks.

Fresh remote refs show `main` at `620d9b6cec84bffd2bb4cf17d755c04c27babb29`;
its Knowledgebase package/lock remain at 0.1.1. The GitHub-hosted
[validate run](https://github.com/cooperativ-labs/overlord-marketplace/actions/runs/40541426950)
passed for that commit, not for the local 0.1.2 candidate. The corrected candidate has not
been committed or pushed by this session. Authenticated fresh-session skill invocation,
read-only MCP/OAuth, desktop, public 0.1.2 first install and live 0.1.2 refresh remain
unverified. Read-only repository API checks found no repository rulesets. Secret names
include `MARKETPLACE_APP_ID` and `MARKETPLACE_APP_PRIVATE_KEY`, but there are no repository
variables: the workflow requires the missing `MARKETPLACE_APP_CLIENT_ID` variable,
not the older App ID secret. No secret values were read. A no-op ingest dispatch remains
pending; the recent Actions listing contains only the successful validate run.

### Earlier 0.1.1 acceptance rerun

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

Public main now includes the unmodified Knowledgebase 0.1.2 host packages and lock.
It excludes Overlord and Scribe. The local README/RELEASING updates record current
publication evidence and the owner's solo-maintainer policy; they are not yet published.
Preserve public history at `2f825a7968c232d091b95c44d49566321d1c5765` and recheck
refs before any subsequent publication. Do not include `.overlord/` in authored changes.

Licensing/notices, local secret scan, App-backed ingest, release-PR CI and public CLI
first-install/unchanged-refresh are evidenced. Owner-reported agent connectivity does
not independently prove all fresh-session skills. Desktop and a genuine public-release
upgrade remain separate observations. Local native-host smoke is not authenticated
runtime acceptance.

Initial public CLI installation evidence and the successful hosted no-op ingest check
are now available to dependent objective per:214.fp80; that
Knowledgebase objective owns onboarding updates. Further documentation publication or
configuration changes require authorization. Real user plugin migration remains outside
this work.

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
