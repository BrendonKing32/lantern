# Revision workflow: implementation spec

Phase 2, item 2. Lantern is good at drafting. This item makes it good at revising, which is where
most of a novel's life is spent. It has four parts:

1. **Claude's drafts:** Claude's edits wait beside a chapter until the writer accepts them. This
   finishes PR #94.
2. **Revision status:** scenes and chapters are marked drafted, revising or done, and revising
   counts as writing.
3. **Milestones:** a named copy of the whole book ("Draft 2, sent to readers") that the writer can
   compare with, restore chapters from and export.
4. **Margin notes:** private notes pinned to a passage, kept out of the manuscript.

Execute it **one step at a time**, each step as its own pull request. Read the whole document, then
do **only the step your issue names**. Each step must leave `main` working: `npm test`,
`npm run typecheck` and `npx vite build` pass. If something here turns out to be wrong against the
code, say so in the pull request instead of inventing a different design.

Conventions are in [`.github/copilot-instructions.md`](../../.github/copilot-instructions.md). This
spec builds on [`scenes-in-text.md`](scenes-in-text.md): read its sections 6.1 (`afterChapterWrite`),
6.5 (`writeChapter`) and 6.6 (move locks and `reconcileChapter`) before starting.

---

## 1. Decisions (fixed; do not revisit)

1. **Claude never changes chapter text directly.** `edit_chapter`, `append_to_chapter` and the
   opening text of `create_chapter` go into Claude's draft of the chapter. The writer accepts it
   or discards it.
2. **Accepting a draft never silently replaces newer writing.** If the chapter changed after the
   draft began, Lantern replays Claude's edits onto the current text and shows the result before
   anything is saved. Edits that no longer apply are listed, never forced in.
3. **Claude's `move_scene` still applies directly** (it changes order, not words, and keeps a
   History copy), but it is **refused while either chapter has a draft by Claude waiting**.
4. **Every server-side write of chapter text goes through `writeChapter`**
   (`worker/handlers/chapters.ts`), so it gets the version check, the History copy, the move lock
   (423), `reconcileChapter` and `afterChapterWrite`. Add no new write path.
5. **Milestones are immutable copies.** Creating one copies each chapter's text. Milestones are
   never edited. They can be renamed or deleted, in the app only.
6. **Restoring from a milestone is per chapter** and works like a History restore. There is no
   whole-book restore.
7. **Revised words count toward the streak only if the writer turns that on.** It's off by default,
   so existing streaks mean what they did before.
8. **Margin notes are private.** They never appear in exports, review links, search results or
   word counts. Claude can read them and, on read-and-edit connections, add them.
9. **Margin notes are anchored by text, not by position**, the same way review comments and Claude's
   edits find text. A note whose passage is gone is kept and shown as "passage not found", never
   deleted automatically.
10. Single writer throughout. There are no per-user permissions on any of this.

## 2. Glossary

| Term | Meaning |
|---|---|
| **Claude's draft** | Claude's pending changes to one chapter. At most one per chapter. |
| **Draft base** | The chapter version Claude's draft started from. |
| **Stale draft** | A draft whose base is older than the chapter's current version. |
| **Draft operations** | The ordered list of edits Claude made to the draft, so they can be replayed. |
| **Milestone** | A named, unchangeable copy of every chapter of the book at one moment. |
| **Revised words** | Words the writer inserted or deleted in a save, counted on both sides of a change. |
| **Margin note** | A private note pinned to a quoted passage of a chapter. |

## 3. Migrations

Numbers are fixed so steps can't collide. **#94's `0014_claude_drafts.sql` must be renamed**, because
0014 and 0015 already exist on `main`.

| Step | File |
|---|---|
| 1 | `0016_claude_drafts.sql` |
| 2 | `0017_revision_status.sql` |
| 3 | `0018_milestones.sql` |
| 5 | `0019_margin_notes.sql` |

Each migration starts with a one-line comment explaining why it exists, as the existing ones do.

---

## 4. Step 1: Claude's drafts (finish #94)

#94 already adds the draft table, `claude-draft.md` beside each chapter in R2, `read_draft`, the
connector routing, the review panel, accept and discard. Keep all of that. Merge `origin/main` into
`claude-drafts` and change the following.

### 4.1 Migration and operations log

`0016_claude_drafts.sql` contains #94's `claude_drafts` table with one more column:

```sql
  ops TEXT NOT NULL DEFAULT '[]'  -- JSON array of DraftOp, in the order Claude made them
```

```ts
// shared/types.ts
export type DraftOp =
  | { kind: "replace"; old_text: string; new_text: string }
  | { kind: "append"; text: string }
  | { kind: "set"; text: string }; // the opening text of a new chapter
```

`draftAsClaude` (in `worker/mcp/writes.ts`) appends the ops it applied to `ops`, in the same
statement that bumps the draft version. `edit_chapter` records one `replace` per edit, in order.
`append_to_chapter` records `append`, and `create_chapter`'s opening text records `set`. Expose
`ops` on `ClaudeDraft` and in `src/schemas.ts`.

### 4.2 Shared replay

New `shared/draftReplay.ts`:

```ts
export interface ReplayResult {
  text: string;                       // the current chapter with every op that applied
  applied: number;                    // how many ops applied
  failed: { index: number; op: DraftOp; reason: "missing" | "ambiguous" }[];
}
export function replayDraft(current: string, ops: DraftOp[]): ReplayResult;
```

- `replace`: apply it when `old_text` occurs **exactly once** in the running text, using the same
  matching as `applyEdits`. Zero occurrences is `missing` and more than one is `ambiguous`. A failed
  op is skipped, and later ops still try.
- `append`: always applies, with the same spacing rule as `append_to_chapter`.
- `set`: applies only when the running text is empty or whitespace. Otherwise it is `missing`.
- Line endings: normalize to `\n` for matching, and keep the chapter's own line endings in the
  result.

Tests: everything applies; one op missing; one ambiguous; ops that depend on an earlier op's output;
`set` on an empty chapter and on a non-empty one; CRLF chapters.

### 4.3 Accept, through `writeChapter`

Replace #94's own claim, snapshot and put sequence in `acceptClaudeDraft` with **`writeChapter`**
(reason `claude`). That one change gives accept the move lock (423), `reconcileChapter`, rollback
and the History copy. Then:

`POST /api/chapters/:id/claude-draft/accept` with body
`{ baseVersion, draftVersion, mode: "as-drafted" | "replayed", expectedText? }`:

- `as-drafted` is allowed only when `draft.base_version === chapter.version` and the base is
  current. It saves the draft text.
- `replayed` (for a stale draft): the server runs `replayDraft(currentChapterText, draft.ops)`
  itself. If its result doesn't equal `expectedText` (what the writer was shown), it returns 409
  "The chapter changed again while you were reviewing. Look it over again." Otherwise it saves the
  result.
- Both modes refuse with 409 if `draftVersion` isn't the draft's current version (as in #94). Both
  add 0 to daily words, delete the draft row (guarded by version) and remove the draft text.
- Log a `claude_changes` row: `action: "accept_draft"`, with a summary such as "Accepted Claude's
  draft of ‹title›", plus "(3 of 4 edits applied)" when some failed.

`discard` stays as #94 has it, and logs `action: "discard_draft"`.

### 4.4 Review panel (`ClaudeDraftPanel.tsx`)

- **Current draft** (base matches the chapter): show the comparison as #94 does, with **Accept** and
  **Discard**.
- **Stale draft:** show "You've changed this chapter since Claude started this draft." Run
  `replayDraft` on the text on screen, and compare that result with the chapter (not the old
  draft). List failed edits as quotes with "No longer in the chapter" or "Appears more than once".
  The buttons are **Accept N of M edits** and **Discard**. If nothing applies, show only
  **Discard**, with "None of Claude's edits fit the chapter any more."
- Unsaved local writing must be saved before Accept is enabled. Use the same flush as scene moves
  (`flushForSceneMove` in `src/sceneArrangement.ts`, or a shared wrapper around it).

### 4.5 Interaction with scenes in the text

- `move_scene` (connector) refuses with "This chapter has a draft by Claude waiting for the author.
  Ask them to accept or discard it first." if either chapter has a draft row. The app's own moves
  stay allowed. A draft that goes stale because of them is handled by 4.2.
- `read_chapter` with `scene_id` keeps reading the **chapter**, not the draft. Say so in its
  description.
- `afterChapterWrite` runs on accept, via `writeChapter`. The draft text is never matched to cards.
- Exports, search, review links, continuity checks and scene labels use the chapter, never the
  draft.

### 4.6 Tests (in addition to #94's)

- Accept a current draft.
- Accept a stale draft with every op applying, and with some failing. The writer's later edits must
  survive in both cases.
- `expectedText` mismatch returns 409.
- Accept during a move lock returns 423 and changes nothing.
- Accept after an interrupted save is reconciled first.
- `move_scene` is refused while a draft exists in either chapter.
- `replayDraft` unit tests (4.2).
- Daily words are unchanged after an accept.
- Backups include `claude-draft.md` objects and the `claude_drafts` table. They should already,
  since backups copy every object and table, but assert it in `worker/backups.test.ts`.

---

## 5. Step 2: revision status and revised words

### 5.1 Data (`0017_revision_status.sql`)

```sql
ALTER TABLE chapters ADD COLUMN revision_status TEXT NOT NULL DEFAULT 'drafting';
ALTER TABLE daily_words ADD COLUMN revised INTEGER NOT NULL DEFAULT 0;
```

- `SceneStatus` becomes `"planned" | "drafted" | "revising" | "done"`. The column is already free
  text, so this needs no migration. Update the validation in `worker/handlers/scenes.ts`,
  `src/schemas.ts` and the connector's `update_scene`. The step 2 rule from `scenes-in-text.md`
  (planned becomes drafted on first match) is unchanged, and a card is never moved *back* to planned
  or drafted automatically.
- `ChapterMeta.revision_status`: `"drafting" | "revising" | "done"`. Set it with
  `PATCH /api/chapters/:id` (`updateChapter`) and the connector's `update_chapter_details`.

### 5.2 Counting revised words

- The editor counts, for each save, the words in the text **inserted** plus the words in the text
  **deleted** since the last save, from the CodeMirror changes (`ChangeSet.iterChanges`), using
  `countWords` on each side. Replacing one word with another counts 2. The count goes with the save
  as `revised`.
- `saveChapter` adds `revised` to `daily_words.revised` for author saves. Restores, replacements,
  moves, conflicts and accepted Claude drafts add 0. Cap a single save at 50,000, to ignore pastes
  of whole chapters.
- Offline drafts carry their pending `revised` count and send it with the eventual save. Store it
  with the draft in `src/local.ts`.

### 5.3 Streak and Today panel

- Writer setting `streak_counts_revision` in the existing `settings` table (`"1"` or absent). It's a
  toggle in the Today panel: "Count revising toward my streak".
- When it's on, a day counts if its net words, **or** its revised words, meet the goal (or are above
  0 with no goal). The calculation is in `worker/handlers/stats.ts`.
- The Today panel shows "‹n› words revised today" whenever revised is above 0, whether or not the
  toggle is on.

### 5.4 UI

- **Scenes view:** the status selector offers all four values. The pill colours use existing tokens:
  revising uses `--lamp`, done uses `--sage`.
- **Corkboard and chapter list:** each chapter shows a small status label (Drafting, Revising or
  Done), changed from a menu on the card. On the corkboard's scene strip (step 6 of
  `scenes-in-text.md`), done scenes show a check mark.
- **README:** the Scenes, Corkboard and Daily goal bullets.

### 5.5 Tests

Revised-word counting from a ChangeSet (insert, delete, replace, multi-range); the server adds
`revised` only for author saves; the 50,000 cap; streak with the toggle off and on; status
validation for scenes and chapters; and an offline draft carrying `revised` through to its save.

---

## 6. Step 3: milestones (create, list, rename, delete)

### 6.1 Data (`0018_milestones.sql`)

```sql
-- A named, unchangeable copy of the whole book at one moment.
CREATE TABLE milestones (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  name          TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  word_count    INTEGER NOT NULL DEFAULT 0,
  chapter_count INTEGER NOT NULL DEFAULT 0,
  complete      INTEGER NOT NULL DEFAULT 0,  -- 1 once every chapter copy is written
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_milestones_project ON milestones(project_id, created_at);

CREATE TABLE milestone_chapters (
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  chapter_id   TEXT NOT NULL,      -- no FK: the chapter may later be deleted
  position     INTEGER NOT NULL,
  title        TEXT NOT NULL,
  act_title    TEXT,               -- the act it was in, for exports and comparison
  version      INTEGER NOT NULL,   -- the chapter version copied
  word_count   INTEGER NOT NULL,
  PRIMARY KEY (milestone_id, chapter_id)
);
```

Text goes in R2 at `projects/{projectId}/milestones/{milestoneId}/{chapterId}.md` (add a
`milestoneKey` helper in `worker/db.ts`).

### 6.2 Create

`POST /api/projects/:id/milestones` with `{ name, note? }`. The name is required and at most 120
characters.

1. Insert the row with `complete = 0`.
2. For each live chapter in book order:
   - run `reconcileChapter`;
   - if the chapter is move-locked, stop with **423** (after cleaning up, as in step 4);
   - read the R2 text and its version, write the copy, and insert its `milestone_chapters` row.
3. Set `complete = 1` with the totals.
4. If any step fails, delete the copies and rows written so far and return 500 "Couldn't save the
   milestone. Nothing was kept. Try again."

Each chapter's copy is the text **as read**. A save landing mid-creation is simply in or out,
because every chapter is copied from one consistent read with its version recorded.

The client saves any unsaved writing first (the same flush as scene moves, applied to every chapter
with a local draft) and refuses with the chapter named if one can't be saved.

### 6.3 List, rename, delete

- `GET /api/projects/:id/milestones`: complete milestones only, newest first, with totals.
- `PATCH /api/milestones/:id` with `{ name?, note? }`.
- `DELETE /api/milestones/:id`: the app asks first ("Delete the milestone ‹name›? Your chapters
  aren't affected."). Delete the R2 copies, then the rows. Incomplete milestones older than an hour
  are deleted by the daily scheduled job (`worker/backups.ts` runs it; add a small cleanup next to
  it).
- Deleting a novel leaves its milestones alone, just as it leaves History alone.

### 6.4 UI

- **More → Milestones** opens a dialog listing milestones (name, date, word count, note) with
  **Save a milestone**, plus rename and delete.
- The shelf's novel target area shows "Since ‹latest milestone›: ‹±n› words", meaning net words now
  minus the milestone's total.
- Creating a milestone needs a connection; the app says so when offline.
- README: a new **Milestones** bullet.

### 6.5 Tests

- Create copies every chapter at its version.
- A chapter deleted later is still in the milestone.
- A move lock returns 423 and leaves nothing behind.
- A failed R2 write leaves nothing behind.
- Incomplete milestones are never listed, and the scheduled job cleans them up.
- Rename and delete.
- Backups include milestone objects and rows.

---

## 7. Step 4: compare with a milestone, restore a chapter, export a milestone

### 7.1 Read API

`GET /api/milestones/:id/chapters` returns the rows. `GET /api/milestones/:id/chapters/:chapterId`
returns one chapter's copied text.

### 7.2 Compare view

From the Milestones dialog, **Compare with now** opens a full-page view:

- **Summary:** words then and now, chapters added, removed, renamed and reordered (matched by
  `chapter_id`), and total words changed (inserted plus deleted, worked out as below).
- **One row per chapter:** title (now and then), status (unchanged, changed, new, or removed since),
  and words added and removed.
- **Open** on a row shows the line comparison, reusing `HistoryComparison.tsx` with the milestone
  text as the old side and the current text, including this device's unsaved writing, as the new
  side.
- The diffs run in the existing `src/historyDiff.worker.ts`, one chapter at a time, with a progress
  line. Never diff on the Worker, because Workers have tight CPU limits.

### 7.3 Restore a chapter from a milestone

In the open comparison, **Restore this chapter as it was** saves the milestone text through the
existing restore path. That is `saveChapter` with `snapshot: "restore"`, so History keeps the current
text and daily words add 0, exactly like restoring from History. Ask first. For a chapter that has
since been **deleted**, offer **Add it back as a new chapter**: `createChapter` with the milestone
title, then save the text with reason `restore`.

### 7.4 Export a milestone

**Export** in the Milestones dialog builds any of the existing formats from the milestone: its
chapter texts, titles and act titles, using `exportBook`'s builders. Refactor `exportBook` in
`src/export/index.ts` to take the chapter texts as input, so both the current book and milestones
use it. The file name gets the milestone's name: `‹title› – ‹milestone›.docx`.

### 7.5 Tests

- Compare classifies new, removed, renamed and changed chapters.
- Counting words changed from a diff.
- Restore keeps a History copy and adds 0 daily words.
- Adding back a deleted chapter.
- Exporting from milestone texts produces the same output as exporting the live book with the same
  text.

---

## 8. Step 5: margin notes

### 8.1 Data (`0019_margin_notes.sql`)

```sql
-- Private notes pinned to a passage of a chapter; never part of the manuscript.
CREATE TABLE margin_notes (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  chapter_id  TEXT NOT NULL REFERENCES chapters(id),
  quote       TEXT NOT NULL,   -- the passage, exactly as it was
  prefix      TEXT NOT NULL,   -- up to 32 characters before it
  suffix      TEXT NOT NULL,   -- up to 32 characters after it
  body        TEXT NOT NULL,
  author      TEXT NOT NULL DEFAULT 'writer',  -- 'writer' | 'claude'
  resolved_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_margin_notes_chapter ON margin_notes(chapter_id, resolved_at);
```

### 8.2 Anchoring (`shared/anchors.ts`)

```ts
export interface TextAnchor { quote: string; prefix: string; suffix: string }
export function makeAnchor(text: string, from: number, to: number): TextAnchor;
export function findAnchor(text: string, anchor: TextAnchor): { from: number; to: number } | null;
```

`findAnchor` works in this order:
1. If the quote occurs exactly once, use it.
2. If it occurs several times, pick the occurrence whose surrounding text best matches `prefix` and
   `suffix` (longest common suffix of the text before plus longest common prefix of the text after).
   On a tie, return null.
3. Retry 1 and 2 with whitespace collapsed on both sides, mapping the offsets back.
4. Otherwise return null.

The quote must be 1 to 2,000 characters.

### 8.3 API

- `GET /api/chapters/:id/notes?resolved=0|1`
- `POST /api/chapters/:id/notes` with `{ quote, prefix, suffix, body }`
- `PATCH /api/notes/:id` with `{ body?, resolved? }`
- `DELETE /api/notes/:id`

Body text is at most 4,000 characters. Notes need a connection, like other structural changes.

### 8.4 Editor

- Select text, then press **Mod-Alt-M** or use **Add note** in the desk bar. This opens a small form
  beside the page.
- Notes are shown as a soft highlight on the passage, made with CodeMirror mark decorations that are
  never part of the text, plus a marker in the margin. Clicking either opens the note.
  Claude's notes carry a small "Claude" label.
- Notes re-anchor with `findAnchor` on the live document, debounced like scene labels, so they
  follow edits.
- A **Notes** panel (in the desk bar, beside History) lists the chapter's open notes in text order.
  Each can be resolved, deleted or jumped to. There are sections for **Resolved** and **Passage not
  found** (orphans, shown with their quote).
- Notes on passages Claude's draft would change aren't specially handled. They re-anchor after an
  accept like after any edit.

### 8.5 Notes follow moved scenes

In `moveScene` (cross-chapter, `worker/handlers/scenes.ts`), after the text writes succeed and inside
the final guarded batch, update the `chapter_id` of open notes whose `findAnchor` result falls inside
the moved passage in the source chapter. Moves within a chapter need nothing, since anchors are
text-based.

### 8.6 Privacy

Notes never appear in exports, review links (`/api/share/*`), search, word counts, the continuity
check or the whole-book check. Add a test that a share-link read and an export of a chapter with
notes contain no note text.

### 8.7 Tests

`findAnchor` (a unique quote, duplicates broken by context, a tie returning null, whitespace drift,
a missing passage); CRUD; notes following a cross-chapter move; privacy; and an editor test that the
decorations don't change document length or word count.

---

## 9. Step 6: connector and README

- **`list_milestones`** (read-only): returns id, name, note, created_at, word_count and
  chapter_count.
- **`read_milestone`** (read-only), with `milestone_id` and optional `chapter_id`. Without a chapter
  it returns the milestone's chapter list (title, position, word_count, version). With one, it
  returns that chapter's milestone text. Claude can then answer "what changed since Draft 2" by
  comparing `read_milestone` with `read_chapter`.
- **`list_margin_notes`** (read-only), with `novel_id` or `chapter_id`, and `include_resolved`
  defaulting to false. Each note carries its quote, body, author and resolved state, and whether its
  passage is found in the current text.
- **`add_margin_note`** (read-and-edit connections only), with `chapter_id`, `quote` and `body`. The
  quote must occur **exactly once** in the chapter's current text (the same rule as `edit_chapter`),
  and the server builds the prefix and suffix. `author: 'claude'`. Logged in `claude_changes`.
  Claude can't resolve or delete notes.
- **Server instructions** (`worker/mcp/server.ts`): tell Claude that text edits go into a draft
  that the author accepts; that a margin note is often the better way to suggest something than an
  edit; and that milestones are read-only.
- **README**, under "Connect Claude chat": describe drafts (#94's text, updated for stale-draft
  replay), milestones (read) and margin notes (read and add).
- **Tests:** each tool's shape; `add_margin_note` refused on read-only connections and on a quote
  that matches more than once; milestones read-only.

---

## 10. Build order

| Step | PR | Depends on |
|---|---|---|
| 1 | Claude's drafts: rework #94 | `main` |
| 2 | Revision status and revised words | 1 (both touch the save path) |
| 3 | Milestones: create, list, rename, delete | 1 |
| 4 | Milestones: compare, restore, export | 3 |
| 5 | Margin notes | 1 (touches `moveScene`) |
| 6 | Connector and README | 3 and 5 |

Steps 2, 3 and 5 can run in parallel once step 1 has merged. Each PR body names its step and
ends with `Fixes #<issue>`.
