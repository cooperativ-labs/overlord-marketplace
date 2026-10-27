---
name: feature-ranking
description: Use when asked to rank, re-rank or prioritise the Feature ideas of one or more Knowledgebase Projects, to sync Features with their Overlord missions, or when a scheduled ranking run starts. Collects every candidate Feature per Project through the knowledgebase MCP tools, ranks each Project independently, writes rank, rationale and freshness onto the Feature–Project relations with guarded updates, then reconciles in-development Features with their missions through Overlord MCP.
---

# Feature ranking

Ranks each Project's candidate Features and records the result on the Feature's
`project` relation to that Project. It runs through the Knowledgebase MCP server at
`https://knowledge.chaselubitz.com/mcp`, invoked by a person or by an external scheduler. Scheduling, runners and
credentials live outside the Knowledgebase; this skill is only the procedure. The
`knowledgebase` skill's "Feature ideas" section describes the Feature model; follow it for
anything not covered here.

You write only these four attributes, and only on explicit `project` relations:

| Attribute | Value |
| --- | --- |
| `rank` | Integer, 1 = build first, unique and dense (1..n) within one Project |
| `rank_rationale` | One or two sentences naming the inputs that decided the position |
| `ranked_at` | Now, as an ISO 8601 timestamp |
| `ranked_content_updated_at` | The Feature's `content_updated_at` **exactly as you read it before assessing** |

Never write Feature properties (`votes`, `status`, `content_updated_at`, …), never write
another Project's relation, and never drop a relation attribute you do not own. The one
exception is [status sync](#status-sync), which writes `status`, `live_at`, `overlord`
and `overlord_url` on `in_development` Features.

## Inputs and scope

- Workspace: the one you were given; otherwise each workspace from `list_workspaces`
  whose `get_registries` has a `feature` type.
- Projects: the ones you were given; otherwise every Project
  (`query` with `type: "project"`, following `next_cursor`). Projects without candidates
  need only cleanup.
- A Feature linked to several Projects is ranked separately in each, against that
  Project's candidates only. Its ranks are unrelated: `#1` in one Project and `#7` in
  another is normal. Never copy a rank between Projects.

A **candidate** has `status` `idea`, `shaping` or `ready` and an empty `overlord`
(missing, null or ""). Everything else — `in_development`, `live`, `declined`, `merged`,
no valid status, or any mission link even when `ready` — is a non-candidate.

## Procedure, per Project

### 1. Collect every candidate before writing anything

```json
{"type": "feature",
 "rel": [{"type": "project", "to_node_id": "<project id>"}],
 "where_in": {"status": ["idea", "shaping", "ready"]},
 "where_empty": ["overlord"],
 "include": ["properties", "relations"],
 "limit": 100}
```

Pass each response's `next_cursor` back as `cursor` until it is absent. Do not order by
rank while collecting and do not write between pages. If any page fails, write nothing
for this Project; report it and move on.

For each candidate keep a snapshot: node ID, title, `metadata_revision`,
`content_updated_at` (verbatim string), and from `relations`: its project relations,
`supported_by` relations (count and read the `citations`), `requested_by` targets,
`depends_on`/`follows`/`part_of` links. Read the Project page (`read_resource`, text) for
its goals.

The relation for this Project is the Feature's outgoing `project` relation with
`to_node_id` = this Project. A `project:: [[...]]` body line is a mention and never creates
an association. Candidates without an explicit relation are not returned by the query.

### 2. Assess and order, without writing

Rank all collected candidates against each other, using only the snapshot:

- evidence: number of citations and distinct sources, strength of the quotes, `stance`
  (`contradicts` counts against);
- requesters: distinct people and companies who asked;
- votes: the net of `votes` (each value `1` or `-1`);
- readiness: `ready` over `shaping` over `idea` when otherwise close;
- dependencies: a Feature that `depends_on` an unbuilt Feature ranks after it;
- fit with the Project's stated goals.

Produce ranks 1..n with no ties, and a short rationale per Feature that names the deciding
inputs ("Four customers asked; three citations from two meetings; net +3 votes."). Do not
mention other Projects in a rationale.

### 3. Recheck, then write each ranking

Rerun the step 1 query (all pages). This gives the current candidates, relation revisions
and content timestamps. For each assessed Feature:

1. **No longer a candidate** (absent from the recheck): do not write a rank; cleanup
   (step 4) handles it.
2. **Inputs changed** (`content_updated_at` differs from the snapshot): either reassess
   the whole Project once more from the new snapshot, or write the ranking from the old
   assessment with the **old** `content_updated_at`. The page then correctly shows it as
   needing re-ranking. Never pair an assessment with a timestamp you did not assess.
3. **Unchanged ranking**: if the canonical relation already has the same `rank` and its
   `ranked_content_updated_at` equals the snapshot value, skip the write.
4. Otherwise write:
   - `update_relation` with `relation_id`, `expected_revision` = the relation's `revision`
     from the recheck, and `attributes` = **all of its current attributes** with the four
     ranking keys replaced.

On `412` from `update_relation`: `get_related` the Feature, find the canonical relation
again, and check that the Feature is still a candidate (`status`, `overlord`). If it is
not, skip it. If its `content_updated_at` moved past your snapshot, apply rule 2. Otherwise
rebuild `attributes` from the reread relation (keeping any attribute someone else just
wrote) and retry with its new `revision`. Retry at most three times, then report. When a
write's outcome is unknown (timeout, dropped connection), reread before writing again.

Features that became candidates after your snapshot are not ranked in this run; they
show as unranked until the next run.

Your writes change only ranking attributes, which the server does not count as content:
after a successful write, `ranked_content_updated_at` equals `content_updated_at` and
the ranking is fresh.

### 4. Clean up non-candidate rankings (housekeeping)

Ranked lists already exclude non-candidates, so this only tidies data. Query the
Project's Features without the candidate filters:

```json
{"type": "feature",
 "rel": [{"type": "project", "to_node_id": "<project id>"}],
 "include": ["properties", "relations"],
 "limit": 100}
```

Follow every cursor. For each non-candidate whose canonical relation to **this** Project
holds any of the four ranking keys, `update_relation` with `expected_revision` and
`attributes` = its current attributes **minus** those four keys (send `{}` if nothing
else remains). Leave every other attribute and every other Project's relation alone. On
`412`, reread with `get_related`; if the Feature is a candidate again, skip it, otherwise
retry as in step 3. A cleanup failure never blocks ranking.

## Status sync

Runs after ranking in the same job, once per workspace. It needs the agent's own
authenticated Overlord MCP tools; Knowledgebase holds no Overlord credentials. Without
them, skip this section and say so in the report.

### 1. Collect every in-development Feature

```json
{"type": "feature", "where": {"status": "in_development"},
 "include": ["properties", "relations"], "limit": 100}
```

Follow `next_cursor` to the end before acting, and keep each Feature's
`metadata_revision`, `overlord` and `overlord_url`. A failed page stops status sync for
this workspace (report it); what was already collected may still be reconciled.

### 2. Look up each mission

For each Feature with a nonempty `overlord`, call `overlord_load_mission_context` with
`missionId` = that value and read the **mission's** `statusType`. An objective's
delivery or a `review` status is not completion. Classify the result:

| Lookup | Outcome |
| --- | --- |
| `statusType` `complete` | **Live** |
| `statusType` `cancelled` | **Gone** |
| Mission not found, *and* a complete exact-reference scan (the `feature-handoff` skill, step 3) in the `overlord_project` of each of the Feature's Projects succeeded without it | **Gone** (deleted) |
| Any other `statusType` | Leave it |
| Authentication, permission, rate-limit, timeout or network error; not found without that confirming scan; a `project_selection_required` or other ambiguous answer | **Unresolved**: leave the Feature unchanged and report it for retry |

An `in_development` Feature with an empty `overlord` is inconsistent: report it and
leave it for a person.

### 3. Write with the revision read before the lookup

- **Live:** `set_properties` `{"status": "live", "live_at": "<now, ISO 8601>"}`.
- **Gone:** `set_properties`
  `{"overlord": null, "overlord_url": null, "status": "ready", "live_at": null}`.

Each with `expected_metadata_revision` = the revision from step 1. On `412`, reread the
Feature (`get_related`) and re-evaluate before writing again: if it no longer links the
**same** mission or is no longer `in_development` (a user removed or changed the link,
relinked it, or set a status by hand), skip it; that newer decision stands. Otherwise resend at the new revision, at
most three attempts. When a write's outcome is unknown, reread before writing again.

One Feature's failure never stops the others. Report per workspace: Features checked,
marked live, returned to ready, left unchanged, unresolved (with the reason), and skipped
because they changed during the run.

## Partial runs and reporting

- A failure on one Feature never aborts the others or other Projects.
- A run interrupted after some writes can leave ties or gaps in a Project. That is
  expected; the next complete run rewrites a dense 1..n order.
- Rerunning with unchanged inputs writes nothing (step 3, rule 3).
- Finish with a short report per Project: candidates collected, ranks written, skipped as
  unchanged, left stale because inputs changed, no longer candidates, cleaned up, and any
  failures with their reason.

## Example

Project *Clear Comply* has 130 candidates (two pages) and *Borealis* has 4. Feature
*Bulk export* belongs to both. Collect all 130 for Clear Comply and all 4 for Borealis,
assess each set separately, and write `rank: 12` on Bulk export's Clear Comply relation
and `rank: 1` on its Borealis relation — two `update_relation` calls on two different
relations, each keeping that relation's other attributes. A user votes on Bulk export
while you assess Clear Comply: the recheck shows a newer `content_updated_at`, so you
either reassess or write rank 12 with the old timestamp, and the page marks it
"Needs re-ranking". A Feature handed to Overlord while still `ready` (it has `overlord`
set) appears in neither candidate list; step 4 removes its old rank attributes.
