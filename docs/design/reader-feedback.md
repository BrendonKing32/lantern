# Reader feedback: implementation spec

Phase 2, item 3. Today a review link is one link per novel, readers can only comment on a whole
chapter, and the writer reads that feedback in a list inside **Share**. This item lets feedback
work the way readers actually react to a book. It has three parts:

1. **Links per reader or round:** several review links at once, each with a label ("Sam",
   "Beta round 1"), and optionally frozen on a milestone so every reader in a round reads the same
   text.
2. **Comments on a passage:** a reader selects text and comments on it. Those comments appear in
   the editor margin beside the passage, where the writer resolves or dismisses them.
3. **Where readers stopped:** the writer sees how far each reader got in each chapter. A reader can
   also mark "I stopped here", optionally saying why. Both tell the writer a lot about pacing.

Execute it **one step at a time**, each step as its own pull request. Read the whole document, then
do **only the step your issue names**. Each step must leave `main` working: `npm test`,
`npm run typecheck` and `npx vite build` pass. If something here turns out to be wrong against the
code, say so in the pull request instead of inventing a different design.

Conventions are in [`.github/copilot-instructions.md`](../../.github/copilot-instructions.md). This
spec builds on [`revision-workflow.md`](revision-workflow.md): read section 6 (milestones) and
section 8 (margin notes) before starting. The current review links are in
`worker/handlers/sharing.ts`, `src/components/ShareDialog.tsx` and
`src/components/PublicShareView.tsx`.

---

## 1. Decisions (fixed; do not revisit)

1. **Review links stay public bearer links under `/api/share/*`.** Every new reader-facing endpoint
   lives under `/api/share/:token/…`, because Cloudflare Access bypasses only that path (README,
   "Allow unlisted manuscript reviews"). Nothing new is served without a valid token, and no
   private route is opened to the public.
2. **Readers never see anything but the manuscript.** No reader sees another reader's comments,
   progress or name, the writer's margin notes, Claude's drafts or anything in History.
3. **A passage comment is a margin note** with `author = 'reader'`. It is stored in `margin_notes`,
   anchored with `shared/anchors.ts`, re-anchored in the editor, kept as "Passage not found" when
   its passage is gone, and carried along by `moveScene`. This is the same mechanism step 5 of the
   revision workflow built. Don't build a second one.
4. **Chapter-level feedback stays in `share_comments`**, as today. Readers can still send a comment
   on the whole chapter.
5. **Resolve keeps, dismiss deletes.** Resolving reader feedback moves it to **Resolved**.
   Dismissing deletes it after asking. This is the same as margin notes.
6. **Reading progress is disclosed and optional.** A link records progress only while its
   **Show me how far readers get** setting is on. It's on by default for new links. When it's on,
   the reader page says so in plain words. Progress is anonymous: readers are numbered per link
   ("Reader 1"), never identified.
7. **A milestone link serves the milestone's text, never the live chapters.** Comments on it anchor
   to the milestone text and re-anchor against the current chapter in the editor, like any other
   note.
8. Reader feedback and progress are private, like margin notes. They never appear in exports,
   search, word counts, the continuity check or the whole-book check.
9. Single writer throughout. The existing `owner_email` checks stay as they are.

## 2. Glossary

| Term | Meaning |
|---|---|
| **Review link** | One public, unlisted link with its own token, label and settings. |
| **Round** | A set of review links that share a milestone, so their readers read the same text. |
| **Live link** | A review link that serves the chapters as they are now. |
| **Milestone link** | A review link that serves one milestone's copied chapters. |
| **Passage comment** | A reader's comment pinned to a quoted passage. Stored as a margin note with `author = 'reader'`. |
| **Chapter feedback** | A reader's comment on a whole chapter (`share_comments`). |
| **Reader key** | A random id the reader page keeps in the reader's browser, one per link. It's used only to tell readers apart in progress. |
| **Furthest point** | The furthest character offset in a chapter that a reader has had on screen. |
| **Stop marker** | A point a reader marked with **I stopped here**, with an optional reason. |

## 3. Migrations

| Step | File |
|---|---|
| 1 | `0020_review_links.sql` |
| 2 | `0021_passage_comments.sql` |
| 3 | `0022_reading_progress.sql` |

Each migration starts with a one-line comment saying why it exists. Every new table goes in
`TABLES` in `worker/backups.ts`, with its `DELETE` placed before the tables it references.

---

## 4. Step 1: links per reader or round

### 4.1 Data (`0020_review_links.sql`)

```sql
-- Let a novel have several labelled review links, optionally reading a milestone.
DROP INDEX idx_active_project_share;
ALTER TABLE project_shares ADD COLUMN label TEXT NOT NULL DEFAULT '';
ALTER TABLE project_shares ADD COLUMN milestone_id TEXT REFERENCES milestones(id);
ALTER TABLE project_shares ADD COLUMN track_progress INTEGER NOT NULL DEFAULT 1;
CREATE INDEX idx_project_shares_project ON project_shares(project_id, revoked_at);
```

An existing active link keeps working, with an empty label, serving live chapters. In the list it
shows as "Review link".

### 4.2 Writer API (replaces the singular `/share` routes)

- `GET /api/projects/:id/shares`: the active links, oldest first:
  `{ id, label, milestone_id, milestone_name, track_progress, created_at, feedback_count }`.
- `POST /api/projects/:id/shares` with `{ label, milestoneId?, trackProgress? }`.
  - The label is required, trimmed, and at most 80 characters.
  - `milestoneId` must be a complete milestone of this novel.
  - At most 20 active links per novel. A 21st returns 409 "Revoke a link before creating another."
  - Returns the token once, as today: `{ ...link, token }`.
- `PATCH /api/shares/:id` with `{ label?, trackProgress? }`. The milestone can't change. To read a
  different milestone, create a new link.
- `DELETE /api/shares/:id`: revoke (sets `revoked_at`). Revoked links stay in the table, because
  feedback points at them.
- `GET /api/projects/:id/feedback?shareId=`: all feedback for the novel, newest first, optionally
  for one link. In step 1 this returns chapter feedback only, with `share_id` and `share_label`
  added. Step 2 adds passage comments.
- `DELETE /api/projects/:id/share/comments/:commentId` stays.
- Keep the existing `owner_email` rule (403 "Only the person who created this review link can
  manage it") per link.
- Remove `GET`, `POST` and `DELETE /api/projects/:id/share` and `GET …/share/comments`. The app is
  their only client.

### 4.3 Reader API

- `GET /api/share/:token` returns `{ project: { title }, label, chapters }`.
  - A live link lists live chapters, as today.
  - A milestone link lists `milestone_chapters` in position order: id, title and word_count.
- `GET /api/share/:token/chapters/:chapterId`:
  - a live link reads the live chapter, as today;
  - a milestone link reads `milestoneKey(project, milestone, chapter)`, and returns 404 for a
    chapter that isn't in the milestone.
- `POST /api/share/:token/comments` is unchanged, except that on a milestone link the chapter must
  be in the milestone and still exist (not deleted). If it doesn't, return 404 "This chapter is no
  longer in the book. Your other feedback still reaches the author."

### 4.4 Milestones and links

Deleting a milestone that active links use revokes those links in the same request. The
**Milestones** dialog's delete question names them: "Delete the milestone ‹name›? The review links
‹label›, ‹label› that read it will stop working. Your chapters aren't affected."

### 4.5 UI (`ShareDialog.tsx`)

- **Share** lists the active links, each with its label, what it reads ("Current chapters" or
  "Milestone ‹name›"), its created date and its feedback count. Each link has **Copy link**,
  **Rename**, **Revoke** and the progress toggle.
- **New review link** asks for a label, what to share (**Current chapters** or one milestone,
  newest first), and **Show me how far readers get** (on by default).
- Store tokens per link in `localStorage` under `lantern:share:{shareId}`. On first open after this
  change, if the old key `lantern:share:{projectId}` exists and exactly one link is active, move the
  token to that link's key. Then remove the old key either way.
- **Private feedback** lists feedback with the link's label on each item, and a filter by link.
- The reader page shows the link's label nowhere. Labels are for the writer.
- README: update the **Review links** bullet.

### 4.6 Tests

- Several links can be active at once, each with its own token. Revoking one leaves the others
  working.
- The 20-link cap.
- A milestone link serves the milestone's text and chapter list, including a chapter deleted
  since. It returns 404 for a chapter that isn't in the milestone.
- A live link still serves live text.
- Deleting a milestone revokes its links.
- A link created before this migration still works.
- `feedback` filters by link.
- Moving the old `localStorage` token.

---

## 5. Step 2: comments on a passage

### 5.1 Data (`0021_passage_comments.sql`)

```sql
-- Let readers' passage comments live with margin notes, and let feedback be resolved.
ALTER TABLE margin_notes ADD COLUMN share_id TEXT REFERENCES project_shares(id);
ALTER TABLE margin_notes ADD COLUMN reader_name TEXT NOT NULL DEFAULT '';
ALTER TABLE share_comments ADD COLUMN resolved_at TEXT;
CREATE INDEX idx_margin_notes_share ON margin_notes(share_id);
```

`MarginNote.author` becomes `"writer" | "claude" | "reader"`. Update `shared/types.ts`,
`src/schemas.ts` and the connector's `list_margin_notes` output. Reader notes have `share_id` set
and `reader_name` (possibly empty). Writer and Claude notes have `share_id = NULL`.

### 5.2 Reader API

`POST /api/share/:token/passages` with `{ chapterId, quote, prefix, suffix, body, displayName? }`.

1. Check the link, and that the chapter is live (and, for a milestone link, in the milestone).
2. Read the text this link serves for that chapter: live or milestone.
3. Validate:
   - `quote` is 1 to 2,000 characters;
   - `prefix` and `suffix` are at most 32 characters each;
   - `body` is 1 to 5,000 characters after trimming;
   - `displayName` is trimmed to at most 80 characters.
4. `findAnchor(servedText, { quote, prefix, suffix })` must find it. Otherwise return 400
   "That passage isn't in this chapter any more. Reload the chapter and select it again."
5. Insert through `createChapterNote` (`worker/handlers/notes.ts`) with author `reader`, plus
   `share_id` and `reader_name`. Its guard returns 423 during a scene move. The reader page then
   says "The author is rearranging this chapter. Try again in a minute."
6. The existing limit of 50 comments an hour per link covers chapter feedback and passage comments
   together.

### 5.3 Reader page (`PublicShareView.tsx`)

- Keep rendering the chapter as one `<pre>` text node, so selection offsets are text offsets.
- When the reader selects text inside the manuscript, show a small **Comment on this passage**
  button next to the selection. On touch devices, show it below the selection's end. The feedback
  form below the chapter also gets **Comment on selected text**, so the keyboard works too.
- Compute offsets with a `Range` from the start of the `<pre>` to the selection's start and end,
  then `makeAnchor(content, from, to)`. A selection longer than 2,000 characters says "Select a
  shorter passage (2,000 characters or fewer)."
- The form shows the quoted passage, the optional name and the comment, then **Send privately**.
  After sending, say "Sent privately to the author. Thank you." The reader page never shows sent
  comments again.
- Whole-chapter feedback stays as it is.

### 5.4 Editor

- Reader notes come back in `GET /api/chapters/:id/notes` with the writer's notes. In the margin and
  highlight they look like other notes, but labelled with the reader's name, or "Reader" if there's
  no name. The link's label sits beside it in the panel. Use the existing highlight class with a
  `cm-note-reader` modifier that only changes the marker's shape. Add no new colours.
- **Notes panel** gains a **Reader feedback** section above **Open**, listing this chapter's open
  reader notes in text order, then its unresolved chapter feedback. Each item can be jumped to
  (passage comments only), resolved or dismissed. Reader notes that are resolved or orphaned go
  into the existing **Resolved** and **Passage not found** sections, with their reader label.
- The writer can't edit a reader note's body. They can resolve it, dismiss it, or **Reply in a
  note**, which creates a writer note on the same anchor and leaves the reader note as it is.
- `PATCH /api/notes/:id` rejects `body` for a reader note with 400 "Readers' comments can't be
  edited." `resolved` works as for any note.
- `PATCH /api/projects/:id/share/comments/:commentId` with `{ resolved }` resolves chapter feedback.
- **Share → Private feedback** also lists passage comments, with their quote and a link that opens
  the chapter at the passage (`reveal` with the quote).

### 5.5 Connector

`list_margin_notes` already returns notes. Add `author: "reader"`, `reader_name` and `link_label`
to its output, and say in its description that reader feedback is included. Claude can't add,
resolve or delete reader notes. Leave `add_margin_note` unchanged.

### 5.6 Privacy

Reader notes are margin notes, so the existing privacy tests already cover them in exports, search
and word counts. Add one test: a passage comment sent through one link is never returned by any
`/api/share/*` route, for that link or another.

### 5.7 Tests

- A passage comment on a live link anchors and appears in the chapter's notes as `reader`.
- On a milestone link, it anchors to the milestone text and shows as "passage not found" against a
  changed chapter.
- A quote not in the served text is refused (400).
- A 423 during a move.
- The rate limit counts both kinds of feedback.
- A reader note's body can't be edited, but it can be resolved and dismissed.
- Chapter feedback can be resolved.
- Reader notes follow `moveScene` across chapters, which the existing move test should cover once
  it includes a reader note.
- `list_margin_notes` includes reader notes with their fields.
- The offset computation on the reader page: selection start and end in a `<pre>` match the quote.

---

## 6. Step 3: where readers stopped

### 6.1 Data (`0022_reading_progress.sql`)

```sql
-- Record how far anonymous readers of a review link got in each chapter.
CREATE TABLE share_progress (
  share_id    TEXT NOT NULL REFERENCES project_shares(id),
  reader_key  TEXT NOT NULL,
  reader_no   INTEGER NOT NULL,          -- 1, 2, 3… per link, in order first seen
  chapter_id  TEXT NOT NULL,
  furthest    INTEGER NOT NULL DEFAULT 0,  -- character offset
  length      INTEGER NOT NULL,            -- served text length when last updated
  stopped_at  INTEGER,                     -- offset of the reader's stop marker
  stop_excerpt TEXT NOT NULL DEFAULT '',   -- first 80 characters of that paragraph
  stop_note   TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (share_id, reader_key, chapter_id)
);
CREATE INDEX idx_share_progress_share ON share_progress(share_id, chapter_id);
```

### 6.2 Reader API

- `POST /api/share/:token/progress` with `{ readerKey, chapterId, furthest }`.
  - Ignore the request with 204 when the link's `track_progress` is 0.
  - `readerKey` must be a UUID.
  - The server sets `length` from the served text, and clamps `furthest` to it.
  - Upsert with `furthest = MAX(furthest, excluded.furthest)`. A new reader key gets the next
    `reader_no` for the link.
  - At most 200 reader keys per link. Beyond that, return 204 and store nothing.
- `POST /api/share/:token/stop` with `{ readerKey, chapterId, offset, note? }`.
  - This works even when `track_progress` is 0, because the reader chose to send it.
  - The note is at most 280 characters.
  - The server sets `stop_excerpt` from the served text: the first 80 characters of the paragraph
    holding `offset`.
  - Sending another stop for the same chapter replaces the old one.
- Both endpoints share a limit of 600 requests an hour per link. Above it, return 429 and store
  nothing.

### 6.3 Reader page

- When the link tracks progress, say under the chapter selector: "The author can see how far
  readers get in each chapter, but not who they are."
- Make the reader key with `crypto.randomUUID()` and keep it in `localStorage` under
  `lantern:reader:{token}`. If storage fails, use a key for the page's lifetime only.
- Furthest point: the character offset at the bottom of the viewport, from
  `document.caretPositionFromPoint` (or `caretRangeFromPoint`) inside the `<pre>`. Fall back to the
  scrolled fraction times the text length. Send it at most every 15 seconds while it grows, and on
  `visibilitychange` to hidden, using `fetch` with `keepalive`. Put this in a small helper with
  tests.
- **I stopped here** is a quiet button at the foot of the screen. It records the offset at the top
  of the viewport and offers an optional "Why?" box (280 characters). Then it says "Thanks. The
  author will see where you stopped."

### 6.4 Writer view

- `GET /api/shares/:id/progress` returns, per chapter in the link's order:
  - `opened` (readers with a row);
  - `finished` (`furthest >= length * 0.95`);
  - each reader's furthest point as a percentage;
  - stop markers as `{ reader_no, percent, excerpt, note, updated_at }`.
- In **Share**, each link has **Reading**: a compact table with a row per chapter (opened,
  finished, and a small bar of the readers' furthest points using existing tokens), and the stop
  markers listed under their chapter as "Reader 2 stopped at 40%: ‹excerpt› ‘‹note›’". Chapters
  where several readers stopped are easy to spot.
- In the editor, a chapter with stop markers shows a quiet line in the **Notes** panel, such as
  "2 readers stopped in this chapter", which opens **Share** at that link's **Reading**.

### 6.5 Tests

- Progress only grows. Stored values never go backwards.
- `track_progress = 0` stores nothing, but stop markers still save.
- The reader cap.
- Reader numbers are assigned in order.
- The rate limit.
- The excerpt is computed from the served text, including on milestone links.
- The `furthest` and `finished` arithmetic.
- The reader-page helper's fallback.
- Backups include `share_progress`.

---

## 7. Build order

| Step | PR | Depends on |
|---|---|---|
| 1 | Links per reader or round | `main` |
| 2 | Comments on a passage | 1 (the feedback list and link labels) |
| 3 | Where readers stopped | 1 |

Steps 2 and 3 can run in parallel once step 1 has merged. Both touch `PublicShareView.tsx` and
`ShareDialog.tsx`, so whichever merges second merges `main` first. Each PR body names its step and
ends with `Fixes #<issue>`.
