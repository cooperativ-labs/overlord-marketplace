---
name: knowledgebase
description: Use when the user asks about, wants to record, or wants to change anything kept in their Knowledgebase — notes, people, companies, projects, meetings, transcripts, decisions — or says "my notes", "my knowledgebase", "my wiki". Covers finding entities, reading pages and transcripts, writing linked notes, and following relations through the knowledgebase MCP tools.
---

# Knowledgebase

The Knowledgebase is a typed knowledge graph: Markdown pages that are also entities
(person, company, project, meeting, …) joined by typed relations. The MCP server at
`https://knowledge.chaselubitz.com/mcp` exposes it. Every tool acts as the signed-in user and can never do
more than they can.

## Read: find first, then open

1. Find the entity: `search` (full text), `query` (by type and properties), or
   `list_entities` (everything of one type).
2. `list_children` on the entity to see its pages and resources (for example a
   meeting's transcript).
3. `read_resource` in its default `text` format for agent-ready content. A transcript
   comes back with its meeting, time, speakers, and timestamped turns. Ask for
   `markdown` only for export-like rendering, `json` only for exact structured values.
4. `traverse` and `get_related` follow typed relations; `get_links` and
   `get_neighborhood` follow Markdown links; `list_changes` answers "what changed
   since…" (pass its `next_cursor` back as `since`).

Do not walk folders with `list_files` to answer questions; it is a storage-level view.
`read_file` is for exact Markdown when you intend to edit it.

## Write: create, then link every note

- `create_node` makes a page of a given entity type with `expected_version: "new"`.
- `edit_file` replaces exactly one text occurrence; pass the `expected_version` from
  `read_file` so a stale write is refused. To fill an empty page, pass `old_text: ""`.
- `add_resource` attaches a registered resource type (for example a transcript) to
  its parent entity; `get_registries` lists the types and their JSON Schemas.

A note nobody linked is invisible to the graph. Whenever you write a meeting note, a
call summary, or an import, relate it to what it is about with the `relations`
argument of the same `create_node` or `edit_file` call:

```json
{
  "path": "meetings/2026-03-04 sync.md",
  "expected_version": "new",
  "content": "# Meeting notes — 2026-03-04\n\nDana walked through the Q3 milestones…",
  "relations": [
    { "type": "about", "target": "Clear Comply" },
    { "type": "participant", "target": "Dana Reyes" },
    { "type": "reviewed_by", "target": "people/sam-lee.md",
      "description": "who checked this work" }
  ]
}
```

- `target` is the page's title, path or node ID; no IDs or `get_registries` call needed.
- `type` is a relation name. Reuse an existing one (the server instructions list them
  per workspace). A new name creates a relation type on first use; pass a one-line
  `description` so the vocabulary stays legible. The response names similar existing
  types with their usage, so switch to one of those if it means the same thing.
- The content saves first, then each relation succeeds or fails on its own. Read the
  response's `relations` block: an ambiguous or unknown target lists `candidates`;
  retry that relation with a path or node ID (`add_relation` or another `edit_file`).
  `create_stub: true` creates a placeholder page for an unknown title instead.
- Re-sending a relation that already exists reports `exists` and changes nothing, so
  retrying is safe.
- `add_relation` takes the same names and title or path targets (`from`, `to`) for a
  page you are not writing.
- Do not write `project:: [[Page]]`, `organization:: [[Page]]`, or
  `participant:: [[Person]]` body lines to create relations. A `key:: [[Page]]`
  line is only a wikilink mention: it never creates a typed relation, even when
  the target resolves. Use `relations` instead. Inline `key:: value` lines
  remain fine for literal properties.
- A `kb-inline-relation-ignored` warning means the body line did not create an
  edge; `resolved: true` only means its target was found. Check `get_related`,
  add the intended missing edge with `add_relation` (or `relations` on a write),
  and verify it exists. Remove obsolete inline declarations with a guarded edit
  when appropriate; preserve ordinary prose links and unrelated content.

## Workspaces and safety

- Every tool takes a `workspace` slug and fails without one. `list_workspaces` lists
  the ones this connection can reach; `get_current_actor` says who you act as.
- Deletes are soft: `delete_file` returns the ids `restore_file` needs. Prefer
  `move_file` over delete-and-recreate; it keeps ids, history, and links.
- Sharing (`grant_access`, share links) and schema changes (`create_entity_type`,
  `create_relation_type`) are refused with `403` until the user allows those
  capabilities on this connection in Settings → Connected agents. Tell the user
  rather than retrying.
- Web links like `https://knowledge.chaselubitz.com/w/<workspace>/<path>` map to `read_file` of
  `kb://<workspace>/<path>`; `https://knowledge.chaselubitz.com/agents.md?path=<page>` explains any page URL.

## Feature ideas

Workspaces with a `feature` entity type keep product ideas as Feature pages, each
linked to one or more Projects. A Feature holds `description`, `status` (`idea`,
`shaping`, `ready`, `in_development`, `live`, `declined`, `merged`), `tags`, and
`decline_reason`; evidence, requesters and related Features are relations
(`supported_by`, `requested_by`, `depends_on`, `follows`, `part_of`, `merged_into`).
The server maintains `content_updated_at`; never write it.

### Who writes what

| Writer | Writes |
| --- | --- |
| Capture and shaping (you, by default) | `description`, `tags`, `status` up to `ready` (or `declined` with `decline_reason` when the user decides), evidence, requester, Project and Feature-to-Feature relations |
| Users, through the vote control | their own entry in `votes` |
| Ranking procedure (the `feature-ranking` skill) | `rank`, `rank_rationale`, `ranked_at`, `ranked_content_updated_at` on the Feature's `project` relations |
| Handoff (the `feature-handoff` skill) and status sync (the `feature-ranking` skill) | `overlord`, `overlord_url`, `status` `in_development`/`live` (and back to `ready`), `live_at` |

Outside the ranking and handoff procedures, leave the other writers' keys alone. Every
write is guarded: `set_properties` needs the node's `metadata_revision` and
`update_relation` takes the relation's `revision`. Send only the keys you change. On a
`412`, reread, re-check that the change still makes sense, and reapply it; retry at most
three times, then report the conflict instead of forcing it. When a write times out or
its outcome is unknown, reread and check whether it landed before writing again.

### Where changes go

| Feature status | New information goes |
| --- | --- |
| `idea`, `shaping`, `ready` | Into the Feature: edit it, add evidence. |
| `in_development` | Into the Overlord mission (`overlord` names it). Small clarifications to the Feature's description are fine; scope changes belong to the mission. |
| `live` | Into a new Feature with `follows` pointing at the live one. Never reopen it. |
| `declined` | Tell the user it was declined (`decline_reason`); create nothing unless they ask. |
| `merged` | Follow `merged_into` and apply these rules to the survivor. |

### Capture with duplicate lookup

1. Resolve the Project (`search` or `query` with `type: "project"`). If the idea's
   Project is unclear, ask; a Feature with no Project is invisible to every list.
2. Look for an existing Feature. `query` with `type: "feature"`,
   `rel: [{type: "project", to_node_id: <project>}]`, `include: ["properties",
   "relations"]`, and follow `next_cursor` until it is absent. Do not stop at the first
   page. Also `search` for the idea's key words with `type: "feature"`, since a
   duplicate may sit under another Project.
3. If a Feature already covers the idea, add evidence to it (below) and apply
   [Where changes go](#where-changes-go). Mention any additional Project in your report;
   add a `project` relation only if the user asked for it. If two existing Features are
   duplicates of each other, propose a merge.
4. Otherwise create it. `get_registries` gives the `feature` `entity_type_id`. Then
   `create_node` with `path: "features/<slug>.md"`, `expected_version: "new"`, content
   `# <Short title>`, and `properties: {description, status: "idea"}` (plus `tags` when
   obvious), and `relations` with a `project` relation to each Project (explicit
   relations carry the Project's ranking) and `requested_by` relations to the people
   or companies who asked for it.

### Evidence: one relation per source, many citations

A Feature has at most one `supported_by` relation per source node (meeting, note,
document). Its `attributes.citations` is a list:

```json
{"citations": [{"quote": "We rebuild the payment report by hand every month.",
  "locator": "00:21:14", "resource_id": "<transcript id>",
  "note": "Current reconciliation is manual.", "stance": "supports",
  "added_at": "2026-10-05T14:03:00Z"}]}
```

`locator` is a transcript timestamp, heading or text span; `resource_id` names the
attached resource the quote came from (for example the meeting's transcript);
`stance` is `supports`, `questions` or `opposes`, so counterevidence is kept.

1. Read the Feature's relations (`get_related`, or `include: ["relations"]` on the
   query). Find the explicit `supported_by` relation whose target is the source.
2. If it exists, build the new attributes from the current ones: keep every other key
   and every existing citation, and append only the citations not already present. Two
   citations are the same when `quote`, `locator` and `resource_id` match. Then
   `update_relation` with that relation's `revision` as `expected_revision`. If nothing
   is new, write nothing.
3. If it does not exist, `add_relation` (`relation_type: "supported_by"`) with
   `attributes: {citations: [...]}`. If it reports `status: "exists"` (another writer
   created it first), its attributes were not changed: continue with step 2.
4. On `412` from `update_relation`, reread the relation and redo step 2 from its current
   attributes. Re-running the whole capture is safe: existing citations are recognized
   and skipped.

Never copy whole transcripts into citations; keep quotes short. Editing the source
later does not change the copied quotes.

### Merging duplicates

Merging is user-requested or user-confirmed. One Feature survives; the other becomes
`merged`.

1. **Choose the survivor.** Read both Features. A Feature is mission-linked when its
   `overlord` is nonempty. If both are linked, do not merge: relate them with
   `depends_on` or `follows` and stop. If exactly one is linked, it must survive, even if
   the user named the other; say so. A survivor that is itself `merged` is not a
   survivor: follow its `merged_into` first.
2. **Copy, never move.** Into the survivor, with every write guarded as above:
   - Citations: for each `supported_by` relation on the duplicate, append its citations
     to the survivor's relation for the same source using the evidence procedure
     (deduplicated by `quote`, `locator`, `resource_id`).
   - Requesters: add each `requested_by` target the survivor lacks, with its attributes.
   - Votes: combine the maps with the survivor's entry winning where a user voted on
     both (`{...duplicate.votes, ...survivor.votes}`); write only if the result
     differs, with the survivor's `metadata_revision`. On `412`, reread and recombine.
   - Projects: add a `project` relation for each Project of the duplicate the survivor
     lacks, with empty attributes. Do not copy the duplicate's ranks; the survivor's
     existing ranks become due for re-ranking on their own because its content changed.
   Keep the survivor's description (fold in useful wording only if asked), status,
   mission link and ranks. Do not delete the duplicate's evidence, relations or page,
   so an interrupted merge can resume.
3. **Recheck, then finalize.** Reread both Features. If either now has a mission that
   changes step 1's answer (the duplicate gained a link, or both are linked), stop and
   report: copied evidence on the survivor is harmless. Repeat step 2 to pick up
   anything added to the duplicate meanwhile. Then `set_properties` on the duplicate
   with `{status: "merged"}` and the `metadata_revision` from this reread. A `412` means
   it changed: go back to the start of this step. Finally `add_relation` `merged_into`
   from the duplicate to the survivor if it is not already there.
4. **Resuming.** A duplicate that is `merged` with a `merged_into` relation is done. One
   that is `merged` without it needs only the relation. Otherwise run the merge again;
   every step recognizes what was already copied.

### Worked example

"Capture the feature ideas for Clear Comply from Tuesday's meeting": find the meeting
and read its transcript in text form; resolve Clear Comply; list Clear Comply's
Features (all pages). For an idea with no match, create
`features/payment-data-import.md` with `description` and `status: "idea"`, add a
`project` relation to Clear Comply, then one `supported_by` relation to the meeting
whose `citations` hold both quotes from it. A second run over the same meeting finds
that Feature, recognizes both citations, and writes nothing new.
