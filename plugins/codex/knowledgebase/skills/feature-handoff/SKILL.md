---
name: feature-handoff
description: Use when the user asks to hand a ready Knowledgebase Feature to Overlord, send it to Overlord, or turn it into an Overlord mission, or to relink a Feature to its mission. Finds an existing mission by the Feature's canonical reference before creating one draft mission, then links it with a guarded write. Needs the knowledgebase MCP tools and authenticated Overlord MCP tools.
---

# Feature handoff

Turns one `ready` Feature into one **draft** Overlord mission and links them. It runs
through the Knowledgebase MCP server at `https://knowledge.chaselubitz.com/mcp` and the agent's own,
separately authenticated Overlord MCP tools. Knowledgebase never holds Overlord
credentials, and nothing here launches the mission. The `knowledgebase` skill's
"Feature ideas" section describes the Feature model; nightly status sync is in the
`feature-ranking` skill.

Run it only when a user asks for a specific Feature to be handed off. You write only
`overlord`, `overlord_url`, `status` and `live_at` on the Feature.

## Identity

Every handoff carries the Feature's **canonical reference** and link:

```
kb-feature:<origin>/<workspace slug>/<node uuid>
<origin>/n/<node uuid>
```

`<origin>` is the origin of `https://knowledge.chaselubitz.com` (scheme, host and non-default port, no path and
no trailing slash); `<workspace slug>` is the `workspace` argument you use; `<node uuid>`
is the Feature's node ID in lower case. Never identify a Feature by its title or path.
Matching in Overlord is exact, case-sensitive and whole-token.

## Procedure

### 1. Read and check the Feature

`get_related` the Feature: its `metadata` holds `properties`, `relations` and
`metadata_revision`. Keep that revision; it guards the link write in step 5. Stop and tell the user unless
`status` is `ready` and `overlord` is empty (missing, null or ""). For any other status,
apply "Where changes go" from the `knowledgebase` skill instead; a `live` Feature gets a
follow-up Feature, never a second mission.

### 2. Resolve the Project and its routing

- Use the Project the user or page named (a page opened from a Project carries
  `?project=<id>`). Check the Feature has an explicit `project` relation to it.
- No Project named: use the Feature's only Project. With several, ask which one; never
  pick one yourself.
- Read that Project's `overlord_project` property. If it is missing or empty, stop and
  ask the user to set it in the Project's properties. Never match an Overlord project by
  name.

### 3. Look for an existing mission, exhaustively

Call `overlord_search_missions` with `reference` = the canonical reference and
`projectId` = `overlord_project` (add `workspaceId` only if Overlord asks you to choose).
Pass each `nextCursor` back as `cursor` until a page has `complete: true`, and collect
every result. Only that complete scan proves anything:

- A failed call, an error such as `project_selection_required`, a timeout, or a scan you
  could not finish proves nothing. Stop, report it, and **create nothing**.
- Ranked search (`query`), a larger `limit`, or a fallback listing never proves absence.

Then decide from the complete set of matches by `statusType`, taking the first row that
applies (*active* means any status other than `cancelled` and `complete`):

| Matches | Do |
| --- | --- |
| Any `complete` | The work shipped. Create and link nothing; suggest a follow-up Feature that `follows` this one. |
| More than one active | Concurrent handoffs or a duplicate. List them (display IDs and status) and ask which to link; select or delete nothing yourself. |
| Exactly one active | Reuse it: skip step 4 and link it in step 5. This also recovers a handoff whose link write failed earlier. |
| Only `cancelled` | Reuse one only if the user asks (link it in step 5 and tell them to reopen it in Overlord). Otherwise ask; if they want a new mission, continue to step 4. |
| None | Continue to step 4. |

A user who removed the link and asks for a new handoff still gets the active match
reused: tell them which mission it is. If they want a fresh mission, they cancel the old
one in Overlord first; a later handoff then creates a new one.

### 4. Create one draft mission

Only after a complete scan found no usable match: `overlord_create_mission` with
`projectId` = `overlord_project`, `title` = the Feature title, and `objective` text that
contains, each reference on its own line:

```
<Feature title>

<description>

Evidence: <two to five lines summarising the citations and who requested it>

Knowledgebase Feature: kb-feature:<origin>/<workspace>/<node uuid>
Feature link: <origin>/n/<node uuid>

The Feature is the live specification; read it through the Knowledgebase MCP before
starting work.
```

Do not set `autoAdvance` and do not launch or queue the mission. Keep the returned mission
display ID (and its URL if the response has one) before writing anything else: this is
the creation receipt. If the create call's outcome is unknown (timeout, dropped
connection), do **not** call it again: repeat step 3 to find the mission it created.

### 5. Link the Feature with one guarded write

`set_properties` on the Feature with `expected_metadata_revision` = the revision from
step 1 and

```json
{"overlord": "<mission display id>", "overlord_url": "<mission url or null>",
 "status": "in_development", "live_at": null}
```

Use `null` for `overlord_url` when Overlord gave no URL; the Feature page then shows the
ID without a link. This one write removes the Feature from every Project's ranked list;
the next ranking run cleans its old rank attributes.

On `412`: reread the Feature and re-evaluate before anything else.

- It now links **this** mission: done.
- It links a different mission, or is no longer `ready`, or its Project routing changed:
  stop. Do not overwrite the newer decision, and do not create another mission; report
  the mission you created (it remains a draft in Overlord) so the user can link or
  cancel it.
- Otherwise (an unrelated key or relation moved the revision): send the same write with
  the new revision. At most three attempts, then report.

When the write's outcome is unknown, reread and check whether it landed before writing
again. A mission created without a successful link is recovered by rerunning this skill:
step 3 finds it and step 5 links it.

### 6. Report

Tell the user the mission display ID, whether it was created or reused, that it is a
draft (not launched), and the Feature's new status.

## Inside Overlord's assistant

Overlord's assistant follows the same procedure through its own Knowledgebase
connection: `overlord_find_feature_missions` performs step 3 (it derives the origin from
the connection), a proposal card the user confirms performs step 4, and its receipt
carries the mission ID into step 5. The rules for matches, conflicts and uncertainty are
identical.

## Example

Feature *Bulk export* (`ready`) belongs to *Clear Comply* and *Borealis*; the user asks
from the Clear Comply page. Clear Comply's `overlord_project` is `clear-comply`. The
reference scan over two pages finds nothing, so you create draft mission `cc:88`, then
write the link. The write returns `412` because a vote landed meanwhile; the reread shows
the Feature still `ready` and unlinked, so you resend and it succeeds. Rerunning the
handoff later stops at step 1 (`overlord` is set). Had the first link write failed, the
rerun's scan would find `cc:88` and link it instead of creating `cc:89`.
