# Overlord plugin marketplace

A Git-backed plugin marketplace for Codex and Claude Code, maintained by the Overlord
project. You install and explicitly refresh ecosystem plugins with each host's native
commands, without hand-editing a personal marketplace file or downloading ZIPs.

> **Status: not yet published.** Nothing here has been pushed to the public GitHub
> repository, and nothing below has been verified against it. Every command below
> describes the intended release. They have only been tested in disposable local profiles
> against a local copy of this repository. This notice is removed once a public first
> install succeeds; see [RELEASING.md](RELEASING.md#last-verified).

## Supported scope

| | v1 |
| --- | --- |
| Marketplace name | `Overlord` (case-sensitive; `@overlord` does not work) |
| Plugins | Knowledgebase (`knowledgebase@Overlord`) |
| Hosts | Codex CLI and Claude Code CLI |
| Not covered | Codex desktop app and Claude Desktop chat (not verified), claude.ai organization catalogs, Overlord's own plugin, Scribe |

The Overlord plugin itself is still installed with `ovld agent-setup`, not from this
marketplace. Knowledgebase also works as a plain MCP connection without any plugin. The
plugin is optional; it adds Knowledgebase's skills on top of the same MCP server.

Each host gets its own unmodified copy of the plugin, taken from the plugin's public
release artifacts. Nothing here is built from private source repositories or edited by
hand.

## Install

```sh
# Register the marketplace once (either host, or both)
codex plugin marketplace add cooperativ-labs/overlord-marketplace
claude plugin marketplace add cooperativ-labs/overlord-marketplace

# Install
codex plugin add knowledgebase@Overlord
claude plugin install knowledgebase@Overlord --scope user
```

To browse before installing, use `codex plugin list --available --json` or
`claude plugin list --available --json`. An available entry is not an installed copy.

**Start a fresh session after installing.** Start a new Codex session (restart the
desktop app if you use it) and restart Claude Code. Sessions that are already running
keep their previous skills and MCP configuration.

## Sign-in and what the plugin can reach

- The plugin registers one remote MCP server: `knowledgebase` at
  `https://knowledge.chaselubitz.com/mcp`. It contains skills and that server
  declaration only, with no hooks, scripts or local commands.
- Knowledgebase sign-in happens in the host's normal OAuth flow the first time a
  Knowledgebase tool is used. The host stores the resulting credentials, possibly in your
  OS credential store. They never pass through this repository or the plugin files.
- An installed plugin, a cache folder or an entry in `codex mcp list` does not mean you are
  signed in. Only a successful Knowledgebase request does.
- Reinstalling under a new plugin id can ask you to sign in or approve tools again.
  Per-tool approvals are not guaranteed to carry over from an old id.

## Update

Updates arrive only when you ask for them:

```sh
codex plugin marketplace upgrade Overlord

claude plugin marketplace update Overlord
claude plugin update knowledgebase@Overlord --scope user
```

- **Codex:** `marketplace upgrade` refreshes the catalog and moves the installed plugin to
  the catalog's version in one step.
- **Claude Code:** `marketplace update` refreshes only the catalog. `plugin update` moves
  the installed plugin and prints "Restart to apply changes".
- Afterwards, start a fresh Codex session or restart Claude Code.
- Running the commands again when nothing changed is safe and leaves the installation as
  it is.
- **No background updates.** This marketplace relies on these explicit commands. Codex has
  not been observed updating plugins in the background.
- **Claude auto-update is optional.** Claude Code can auto-update a marketplace if you
  turn it on for that marketplace in its plugin manager (off by default for third-party
  marketplaces). This marketplace does not depend on it. Leave it off when checking an
  installation against these instructions.

A release reaches you only after a reviewed change is merged here *and* you run the
commands above.

## Verify the installed version

```sh
# Codex: knowledgebase@Overlord installed, enabled, expected version
codex plugin list --json
# Codex: the knowledgebase server at the URL above
codex mcp list --json
ls "${CODEX_HOME:-$HOME/.codex}/plugins/cache/Overlord/knowledgebase/"

# Claude Code: knowledgebase@Overlord enabled, with version and installPath
claude plugin list --json
# Claude Code: three skills and the MCP server
claude plugin details knowledgebase
ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/Overlord/knowledgebase/"
```

- The released version is `version` in
  [`sources/knowledgebase.lock.json`](sources/knowledgebase.lock.json) on `main`.
- Codex removes the old version folder when it upgrades.
- Claude Code keeps old version folders. The active copy is the `installPath` reported by
  `claude plugin list --json`; an old folder is not a second registration.
- The three skills are `knowledgebase`, `feature-ranking` and `feature-handoff`. To confirm
  that skills actually loaded, invoke one in a fresh session. Do not rely on listings or on
  the model's own description of what it has.

**One server only.** Do not also add a standalone Knowledgebase MCP server (for example
`[mcp_servers.knowledgebase]` in Codex, or `claude mcp add`) while the plugin is installed.
The plugin already registers it, and a second registration duplicates every tool.

## Moving from an earlier install

You do this yourself. Nothing in this repository changes your installed plugins. These
steps keep every unrelated plugin, marketplace and server.

1. **Register and check.** Register the marketplace as above. Confirm
   `knowledgebase@Overlord` appears with `--available`.
2. **Inventory what you have.** Note each Knowledgebase plugin id, its version, its source
   and, in Claude Code, its scope (`user`, `project` or `local`). Also note any standalone
   server that points at `https://knowledge.chaselubitz.com/mcp`, whatever its name.

   ```sh
   codex plugin list --json
   codex mcp list --json
   claude plugin list --json
   claude mcp list
   ```

3. **Remove the old active copy** using its actual id and scope. These are common
   examples, not necessarily your ids:

   ```sh
   codex plugin remove knowledgebase@overlord-local
   claude plugin uninstall knowledgebase@knowledgebase --scope user
   ```

4. **Remove a standalone server, if you had one, by its exact name and scope**, for example
   `codex mcp remove <name>` or `claude mcp remove --scope <scope> <name>`. Leave every
   other server alone. If a managed or organization policy defines the server, resolve
   that policy first rather than adding a duplicate.
5. **Install** `knowledgebase@Overlord` as above.
6. **Verify.** Check that exactly one Knowledgebase endpoint is active in each host. Start
   a fresh session and sign in again if asked.

Notes:

- **Do not remove the old marketplace wholesale.** In Claude Code, removing a marketplace
  uninstalls every plugin installed from it.
- **The personal Codex catalog is unaffected.** `~/.agents/plugins/marketplace.json` and
  its other entries (such as `overlord` and `scribe`) stay as they are. Its unused
  Knowledgebase entry can remain; you do not need to edit the file.
- **Staying MCP-only is fine.** If you use Knowledgebase only as an MCP connection, keep
  that connection and skip the plugin.
- **If installing fails after removal,** reinstall the old source you recorded. Do not
  leave both routes enabled while you recover.

## If a release is bad

Fixes ship as a **higher** version, which you receive with the normal update commands.
Reverting this repository does not roll back an installed copy.

If you cannot wait for that release, Codex can register the marketplace at a known-good
commit. First remove the current registration, then add it again with `--ref`:

```sh
codex plugin marketplace remove Overlord
codex plugin marketplace add cooperativ-labs/overlord-marketplace --ref <commit>
```

Then reinstall, and verify in a fresh session. This emergency path has not been tested.

## Troubleshooting

- **`plugin not found` for `knowledgebase@overlord`:** the marketplace name is `Overlord`,
  with a capital O.
- **Every Knowledgebase tool appears twice:** two registrations are active (an old plugin
  id, or a standalone server). Repeat steps 2–4 of the migration.
- **New skills are missing after an update:** start a fresh session (Codex) or restart
  (Claude Code).

## Maintainers

See [RELEASING.md](RELEASING.md) for the release workflow, CI and publication setup, and
[docs/contracts.md](docs/contracts.md) for the source, lock and catalog contract.
