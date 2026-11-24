# Scenes in the text: implementation spec

Phase 2, item 1. This is the build spec for tying scene cards to real passages
of a chapter. It is written to be executed one step at a time, each step as its
own pull request. Read the whole document once, then do **only the step your
issue names**.

- Each step must leave `main` working and shippable: `npm test`,
  `npm run typecheck` and `npx vite build` all pass.
- Don't start work belonging to a later step, even if it looks easy.
- If something in this spec turns out to be wrong against the code, stop and
  say so in the pull request description instead of inventing a different design.

Repository conventions are in [`.github/copilot-instructions.md`](../../.github/copilot-instructions.md).

---

## 1. Background

Today a scene card is a planning note in the `scenes` table (`migrations/0009_scenes.sql`,
`migrations/0012_unassigned_scenes.sql`). It has a title, summary, POV, location and a manual
`planned`/`drafted` status, and it sits in a chapter or is unassigned (`chapter_id` null). It has
no tie to the chapter's markdown, which lives in R2, one object per chapter (`chapterKey` in `worker/db.ts`).

The manuscript already marks scenes with breaks: `***`, `---` or a lone `#` on its own line. The
exports (`src/export/model.ts`, `parseChapter`) turn `hr` tokens and empty headings into scene breaks.

After this work, a card in a chapter is either **in the text** (tied to one passage between breaks)
or **planned** (not written yet). Lantern works this out by itself after every save. Moving an
in-text card moves its passage.

## 2. Decisions (fixed; do not revisit)

1. **The manuscript stays plain markdown.** No ids, comments or markers are ever written into
   chapter text. Cards find their text by *anchors plus order* (section 4).
2. **The text always wins.** Matching cards to text must never make a save fail. If matching
   throws, log it and carry on; the next scene listing repairs it (section 6.3).
3. **Moving a card never removes text from the book.** It only rearranges passages.
4. **A passage with no card is not stored.** It's shown as a placeholder worked out from the text.
5. **Status:** when a planned card is first matched to text, set `status` to `drafted`. The writer can
   still change status by hand.
6. **Linking new passages to planned cards is suggested, never automatic** (except the cut-and-paste
   case in 6.4 and the existing-cards case in step 2).
7. **Editor scene labels** are on by default, with a per-device toggle (stored like the grammar
   on/off setting, in `localStorage`).
8. **Moving text needs a connection.** Writing offline is unchanged.
9. Only top-level breaks split scenes. Breaks inside block quotes or lists don't.

## 3. Glossary

| Term | Meaning |
|---|---|
| **Passage** | The text of a chapter between two scene breaks (or before the first / after the last). A chapter with no breaks is one passage. |
| **Break line** | The line that opens a passage: `***`, `---`, `___` (any thematic break), or an empty ATX heading (`#` … `######` with nothing after). |
| **In-text card** | A scene row with `in_text = 1`, matched to exactly one passage of its chapter. |
| **Planned card** | A scene row with a `chapter_id` and `in_text = 0`. |
| **Placeholder** | A passage that no card is matched to. Not stored. Shown in the UI with "Add card" / "This is…". |
| **Anchors** | `head` and `tail`: the first and last 160 characters of a passage's normalized prose. |

## 4. Shared module: `shared/scenes.ts`

One module, imported by both the Worker and the app, so the server and the editor always agree.
It must be pure: no I/O and no `Date.now()`.

### 4.1 `splitScenes`

```ts
export interface Passage {
  /** 0-based order within the chapter. */
  index: number;
  /** Offset of the break line that opens this passage in the normalized text; null for the first passage. */
  breakStart: number | null;
  /** The break line as written, trimmed (e.g. "***", "* * *", "---", "#"); null for the first passage. */
  breakLine: string | null;
  /** Offset where the passage body starts (just after the break line's newline; 0 for the first). */
  start: number;
  /** Offset after a matching chapter-title heading and its following blank lines, or `start`. */
  lead: number;
  /** Offset (exclusive) where the next break line starts, or the text length. */
  end: number;
  /** countWords() of the body. */
  words: number;
  /** Normalized anchors (see 4.2). Empty string when the body has no prose. */
  head: string;
  tail: string;
  /** Up to 120 characters of the body's first prose, plain text, for display. */
  excerpt: string;
}

/** Line endings normalized to "\n". All offsets refer to this string. */
export function normalizeText(markdown: string): string;

export function splitScenes(markdown: string, chapterTitle?: string): Passage[];
```

Rules:

- Normalize first: replace `\r\n` and `\r` with `\n` (this is what `marked`'s lexer does). All
  offsets refer to the normalized string.
- Tokenize with `new Lexer().lex(text)` from `marked`, the same lexer `src/export/model.ts` uses.
  Walk the **top-level** tokens, tracking each token's offset by summing `token.raw` lengths.
  A break is a top-level `hr` token, or a top-level `heading` token whose text is empty after trimming.
  Using the lexer (not a regex) keeps this identical to what the exports treat as a break,
  including the `---` setext-heading case and fenced code.
- **Guard:** if the concatenated `raw` of the top-level tokens isn't exactly the normalized text,
  don't guess. Return a single passage covering the whole text, and `console.warn` once.
- A passage's body is the text from just after the break token's raw (which includes its trailing
  newline) to the start of the next break token.
- `chapterTitle`: if the first passage starts with a heading whose plain text equals the title
  (case-insensitive, trimmed; the same rule as `parseChapter`), that heading is left out of
  `head` and `excerpt` (it still counts in `start`/`end`).
- Empty passages (for example two breaks in a row) are still passages, with `words: 0` and empty anchors.

### 4.2 `normalizeAnchor`

```ts
export function normalizeAnchor(prose: string): string;
```

1. `stripLinks()` from `shared/wikilinks.ts` (`[[Name|shown]]` → `shown`).
2. Replace markdown marks `[#>*_`~]` with spaces.
3. Lowercase, collapse whitespace runs to one space, and trim.

`head` = `normalizeAnchor(body).slice(0, 160)`; `tail` = `.slice(-160)`.

### 4.3 `matchScenes`

```ts
export interface MatchCard {
  id: string;
  in_text: boolean;
  anchor_head: string | null;
  anchor_tail: string | null;
  /** Current order among the chapter's cards. */
  position: number;
}

export interface MatchResult {
  /** cardId → passage index, for every card that ends up in the text. */
  pairs: Map<string, number>;
  /** Passage indexes with no card (placeholders), ascending. */
  placeholders: number[];
  /** Ids of cards that were in the text before this match and aren't now. */
  leftText: string[];
}

export function matchScenes(passages: Passage[], cards: MatchCard[]): MatchResult;
```

Only cards with `in_text: true` take part; planned cards are never paired by this function.
(Linking a planned card is always an explicit action: decision 6.)

1. **Head pass.** Count how many passages share each non-empty `head`. For each in-text card whose
   `anchor_head` equals the head of exactly one passage, and only one card has that anchor, pair them.
2. **Tail pass.** The same with `anchor_tail`/`tail`, over cards and passages still unpaired.
3. **Order pass.** Walk the gaps between consecutive paired passages (plus before the first and after
   the last). In each gap, take the unpaired passages in that gap (in index order), and the unpaired
   in-text cards whose `position` is strictly between the positions of the cards paired to the gap's
   two bounding passages (in position order). If the two counts are equal and non-zero, pair them in
   order. If the counts differ, or the two bounding cards' positions are inverted (because an anchor
   pair crossed), pair nothing in that gap.
4. Anchor pairs may cross position order. That's expected: a scene cut and pasted elsewhere in the
   chapter is paired by its anchor at its new place, and its card's position is updated afterwards
   (section 6.1). Pass 3 only works inside gaps between pairs, so it never crosses.
5. Unpaired in-text cards go in `leftText`. Unpaired passages go in `placeholders`.

`matchScenes` returns pairs only. The caller writes anchors, word counts, positions and `in_text` (section 6).

### 4.4 `arrangeText`

```ts
/**
 * Rebuild a chapter with its passages in a new order.
 * `order` is a permutation of passage indexes. Returns normalized text.
 */
export function arrangeText(text: string, passages: Passage[], order: number[]): string;
```

- Each passage keeps its own break line as written, so `***` stays `***`.
- The passage that ends up first loses its break line.
- The passage that *was* first and is no longer first gets a break line: the break style used most
  often in this chapter (ties go to the first one used), or `***` if the chapter had none.
- A leading chapter-title heading (`passages[0].lead > 0`) stays at the top of the chapter; only the
  bodies after it are rearranged.
- Join passages as `body.trimEnd() + "\n\n" + breakLine + "\n\n" + nextBody.trimStart()`. The result
  ends with exactly one `"\n"` if the original ended with a newline.
- `arrangeText(text, p, identity)` must equal `text` after its spacing is normalized the same way.
  Test this property.

Also export, for moves between chapters:

```ts
/** Remove passage `index` from a chapter. Returns the remaining text and the removed body. */
export function takePassage(text: string, passages: Passage[], index: number): { rest: string; body: string };
/** Insert a body as a new passage before passage `beforeIndex` (or at the end when null). */
export function insertPassage(text: string, passages: Passage[], body: string, beforeIndex: number | null): string;
```

They follow the same break and spacing rules. Inserting into an empty chapter makes the body the
whole text, with no break line.

## 5. Data model

Migration `migrations/0014_scenes_in_text.sql` only adds columns:

```sql
-- Scene cards can be tied to a passage of their chapter's text.
ALTER TABLE scenes ADD COLUMN in_text     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scenes ADD COLUMN anchor_head TEXT;
ALTER TABLE scenes ADD COLUMN anchor_tail TEXT;
ALTER TABLE scenes ADD COLUMN word_count  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scenes ADD COLUMN unlinked_at TEXT;
-- 1 while an in-text card was paired by order during the one-time migration and the writer hasn't confirmed it.
ALTER TABLE scenes ADD COLUMN unconfirmed INTEGER NOT NULL DEFAULT 0;

-- The chapter version its scene cards were last matched against. 0 = never.
ALTER TABLE chapters ADD COLUMN scenes_version INTEGER NOT NULL DEFAULT 0;
```

`shared/types.ts`, `SceneMeta` gains:

```ts
  /** True while this card is matched to a passage of its chapter. */
  in_text: boolean;
  /** Words in its passage; 0 when not in the text. */
  word_count: number;
  /** The passage's first words, for display; "" when not in the text. */
  excerpt: string;
  /** 0-based order of its passage in the chapter, or null. */
  passage_index: number | null;
  /** Paired by order when this feature arrived; the writer hasn't confirmed it yet. */
  unconfirmed: boolean;
  /** When the card last left the text (merged or cut), or null. */
  unlinked_at: string | null;
```

`in_text` and `unconfirmed` are stored as 0/1 and returned as booleans. `excerpt` and `passage_index`
are not stored. `listScenes` works them out (section 6.3). Keep `anchor_head`/`anchor_tail` out of
API responses. Update `sceneMeta` in `src/schemas.ts` to match.

The listing also returns placeholders. Change `GET /api/projects/:id/scenes` to return:

```ts
interface SceneListing {
  scenes: SceneMeta[];
  /** Passages with no card, per chapter. */
  placeholders: { chapter_id: string; passage_index: number; words: number; excerpt: string }[];
}
```

Update `api.scenes` in `src/api.ts` and every caller.

`position` keeps its meaning: one order for all of a chapter's cards, planned and in-text. After a
match, in-text cards are re-sorted into the *slots* they already hold, so planned cards keep their place.

## 6. Server behaviour

### 6.1 `afterChapterWrite`

New `worker/sceneSync.ts`:

```ts
/** Match a chapter's scene cards to text just written. Never throws. */
export async function afterChapterWrite(env: Env, chapter: ChapterMeta, text: string, version: number): Promise<void>;
```

1. Load the chapter's scene rows (`chapter_id = ?`), ordered by `position`.
2. `splitScenes(text, chapter.title)`, then `matchScenes(...)`.
3. **Cross-chapter follow (6.4).** For each placeholder whose `head` is non-empty, look for a card in
   *another* chapter of the same novel with `in_text = 0`, `unlinked_at` within the last hour, and
   `anchor_head` equal to that head. If there's exactly one, pair it (set `chapter_id` to this chapter).
4. Work out the new row state:
   - paired cards: `in_text = 1`, anchors and `word_count` from the passage, `unlinked_at = NULL`,
     and `status = 'drafted'` if it was `planned` and the card was not in the text before (decision 5);
   - cards in `leftText`: `in_text = 0`, `word_count = 0`, `unlinked_at = now`, anchors **kept**
     (they're what 6.4 matches on);
   - positions: the in-text cards' slots refilled in passage order.
5. Write **only rows that changed**, plus `UPDATE chapters SET scenes_version = ? WHERE id = ? AND version = ?`,
   all in one `env.DB.batch`. If the version guard matches no row, a newer save happened; do nothing more.
6. Wrap everything in `try/catch`. On error, `console.error("scene sync failed", e)` and return.

Call it after the R2 write succeeds in:

- `saveChapter` (`worker/handlers/chapters.ts`)
- `saveAsClaude` (`worker/mcp/writes.ts`)
- the move endpoints (6.5, 6.6)

Await it. Don't use `waitUntil`, so tests are deterministic.

### 6.2 Messages a merge leaves behind

When a card lands in `leftText` because two passages merged (its passage's text is now inside a
neighbouring paired passage), the UI shows "Merged into *‹title›*" for a day. Work this out in
`listScenes` from `unlinked_at` and the card that now holds the previous passage's slot. No extra column.

### 6.3 Self-healing listing

`listScenes`: for every chapter of the novel whose `scenes_version < version`, read its text from R2
and run `afterChapterWrite` before answering.
The match uses the R2 object's version metadata, falling back to the D1 version for older objects without it.
To fill `excerpt`, `passage_index` and `placeholders`, the listing needs the passages of every chapter.
Read every chapter of the novel that has at least one
scene row or one break (one R2 read each, in parallel with `Promise.all`), and split them. Books are at
most a few dozen chapters, so this is acceptable. Don't add caching in this item.

### 6.4 Cut and paste between chapters

Handled entirely by step 3 of `afterChapterWrite`: the source chapter's save marks the card
`in_text = 0` with `unlinked_at`; the destination chapter's save finds the anchor and claims it.

### 6.5 Reorder passages within a chapter

`PUT /api/chapters/:id/scenes/arrangement`, body `{ baseVersion: number, sceneIds: string[] }`.

- `sceneIds` lists **all** the chapter's cards (planned and in-text) in the new order. It must be the
  same set as the stored set, or return 409 `"Scene list is out of date; reload and try again"`.
- Read the text, `splitScenes`, `matchScenes`. If any in-text card doesn't pair, return the same 409.
- New passage order: the in-text cards' passages in `sceneIds` order, with placeholder passages kept
  attached after the passage before them. A placeholder at index 0 stays first.
- If the passage order is unchanged, just write the positions and return. No text write, no History copy.
- Otherwise save `arrangeText(...)` through the same claim → snapshot → put → roll back sequence as
  `saveChapter`, with snapshot reason **`move`** (always kept, not rate-limited), daily words delta **0**,
  then `afterChapterWrite`, then write positions from `sceneIds`.
- Return `{ version, word_count, updated_at }` like `saveChapter`.

Refactor the claim/snapshot/put/rollback sequence out of `saveChapter` into a helper in
`worker/handlers/chapters.ts` that both use, rather than copying it.

### 6.6 Move a passage to another chapter

`POST /api/scenes/:id/move`, body `{ toChapterId: string, beforeSceneId: string | null, baseVersions: { from: number, to: number } }`.

- The scene must be in the text (planned cards move with the existing `PATCH /api/scenes/:id`).
  `toChapterId` must be in the same novel and differ from the scene's chapter. `beforeSceneId`, when
  given, must be a card in the destination chapter.
- The insert point is before the passage of `beforeSceneId` if that card is in the text. If it's
  planned, use the next in-text card after it, or the end when there isn't one.

Sequence. Each step fails safe:

1. **Claim both versions** in one `env.DB.batch` of two conditional `UPDATE chapters SET version = version + 1 … WHERE id = ? AND version = ?`.
   If either has `meta.changes === 0`, put the other back and return 409 with both current versions.
2. **History copies of both** with reason `move`. If either fails, put both versions back and return 500
   `"Could not keep a copy in History, so nothing was moved"`.
3. **Write the destination first**, then the source.
4. If the source write fails, write the destination's original text back. If that also fails, return 500
   `"The scene is now in both chapters. Delete one copy."` and leave the versions claimed. Text is never lost.
5. Update both chapters' `word_count`, then run `afterChapterWrite` for the destination with the moving card
   pre-assigned (set its `chapter_id` to the destination and keep `in_text = 1` *before* running sync,
   so its anchors pair it), then for the source.
6. Daily words delta 0 for both. Return `{ from: {version, word_count}, to: {version, word_count}, scene }`.

### 6.7 History reason

Add `"move"` to `SnapshotReason` (`shared/types.ts`), the `reason` literal in `src/schemas.ts`, and the
`REASON` map in `src/components/HistoryPanel.tsx` as `"Before moving a scene"`. `snapshotBeforeSave`
must treat `move` like `restore` (always keep a copy).

### 6.8 Linking and confirming

Extend `PATCH /api/scenes/:id`:

- `{ link: { passage_index: number } }`: link a planned card in a chapter to one of that chapter's
  placeholders. Read and split the text; the passage must exist and have no card. Set `in_text = 1`,
  anchors, `word_count`, `status = 'drafted'` if planned, `unconfirmed = 0`, and position just before
  the card of the next passage. Return 409 if the passage is now taken.
- `{ unlink: true }`: in-text card → planned. Its passage becomes a placeholder. The text is untouched.
- `{ confirm: true }`: set `unconfirmed = 0`.
- Changing `chapter_id` of an in-text card is refused with 400
  `"Move scenes that are in the text with the move action"`.

Deleting an in-text card is allowed. Only the row goes, and its passage becomes a placeholder.

## 7. UI

Follow the existing look in `src/styles.css`. Use existing tokens only (`--lamp`, `--sage`, `--rose`,
`--faint`, `--chip` and so on) and no new colours. All copy is plain and from the writer's side.

### 7.1 Scenes view (`src/components/SceneBoard.tsx`, wired in `ProjectView.tsx`)

- Each chapter lists its cards and placeholders in one order: in-text cards and placeholders in
  passage order, with planned cards in their slots.
- State pill on each card: **In the text** (sage), **Planned** (lamp), placeholder **No card**
  (dashed outline, faint).
- In-text cards show `word_count` ("1,240 words") and the excerpt in the prose font.
- **Open** on an in-text card opens the Write view at the passage start (put the cursor there and
  scroll it into view, the same way a search result opens).
- Placeholder actions: **Add card** (creates a card titled from the excerpt's first 6 words, then
  links it) and **This is…** (a menu of the chapter's planned cards, which links the chosen one).
- Unconfirmed cards show **Looks right** (confirm) and **Not this one** (unlink).
- Dragging an in-text card within its chapter calls 6.5. Dragging it into another chapter calls 6.6.
  Dropping it on **Unassigned** is refused with the hint "To take this scene out of the chapter, cut
  its text in the editor."
- Before 6.5 or 6.6, flush any unsaved local draft of the affected chapters through the existing save
  path. If a chapter can't be saved (offline or in conflict), don't move. Say
  "Save ‹chapter› first: ‹reason›".
- After a move, show a notice "Moved ‹scene› to ‹chapter›" with **Undo**, which runs the reverse
  move with fresh versions.
- While offline, in-text cards can't be dragged. Show the existing offline hint.

### 7.2 One-time banner for existing cards

The first match of a chapter that has `scenes_version = 0` and existing in-chapter cards:

- if the number of cards in the chapter equals the number of passages, pair them in order with
  `in_text = 1, unconfirmed = 1`;
- otherwise leave them all planned.

Do this in `afterChapterWrite` when `scenes_version` was 0, before the normal match. The Scenes view
then shows a banner while any card is unconfirmed or any chapter has both planned cards and
placeholders from this migration: "Check how your scene cards line up with the text." It lists those
chapters and can be dismissed (dismissal is remembered per novel in `localStorage`).

### 7.3 Editor labels (`src/components/ChapterEditor.tsx`, new `src/sceneLabels.ts`)

- A CodeMirror extension that runs `splitScenes` on the document (debounced 300 ms) and
  `matchScenes` against the chapter's cards. It shows a small label widget at the top of the chapter
  and after each break line, with the card title, or "Scene 3 · no card".
- Widgets are decorations, never document text. Copy, search, word count and Harper must not see them.
- Clicking a label opens the card beside the page, the same way `LinkPeek` opens a story guide entry.
- Toggle **Scene labels** in the desk bar, per device in `localStorage`, default on.
- Command **Insert scene break**, bound to Mod-Shift-Enter. It inserts `\n\n<chapter's usual break>\n\n` at the cursor.

### 7.4 Corkboard (`src/components/Corkboard.tsx`)

Each chapter card gets a thin strip under the synopsis listing its in-text scenes (title and word
count), in passage order. Max 6, then "+N more". Corkboard drag still reorders chapters only.

## 8. Connector (`worker/mcp/`)

- `get_outline`: each scene gains `in_text`, `word_count`, `passage_index`. Each chapter gains
  `uncarded_passages: { passage_index, words, excerpt }[]`.
- `read_chapter`: optional `scene_id`. When given, return only that passage's text, plus the chapter
  `version` and `passage_index`. The card must be in the text.
- New tool `move_scene` (read-and-edit connections only, registered next to the other write tools):
  inputs `scene_id`, `to_chapter_id` (optional; omit to reorder within the same chapter),
  `before_scene_id` (optional), and `base_versions`. It calls the handlers through `viaApp` like the other
  write tools and logs a `claude_changes` row (`action: "move_scene"`, `target_kind: "scene"`).
- Update the `create_scene` description and the instructions in `worker/mcp/server.ts`. Cards are no
  longer "notes that don't change any chapter's text". Say: scene cards can be tied to passages between
  scene breaks, and `move_scene` moves the text with them.
- `edit_chapter` / `append_to_chapter` already go through `saveAsClaude`, so they get matching for free.

## 9. Build steps

Each step is one pull request. Each step lists its scope, what must be tested, and when it's done.

### Step 1: shared splitter, matcher and arranger

Tracking issue: https://github.com/BrendonKing32/lantern/issues/78

**Scope:** `shared/scenes.ts` (section 4) and `shared/scenes.test.ts`. No other file changes, except
moving the title-heading comparison out of `src/export/model.ts` into a small shared helper if that
avoids duplication.

**Tests:**
- `splitScenes`: each break style (`***`, `* * *`, `---`, `___`, `#`, `##`); `---` directly under a
  paragraph line (a setext heading, **not** a break); `***` inside a fenced code block (not a break);
  `---` inside a block quote (not a top-level break); a chapter with no breaks; leading and trailing
  breaks; two breaks in a row; `\r\n` input; a leading title heading left out of the head anchor;
  `[[Mara|her]]` normalizing to "her".
- **Parity:** for a corpus of at least 10 varied chapters, the number of top-level `break` blocks
  `parseChapter` produces equals `splitScenes(...).length - 1`.
- `matchScenes`: a table-driven test covering type inside a scene; split a scene; merge two scenes;
  swap two scenes; rewrite one scene's opening; rewrite an opening **and** add a break elsewhere;
  two scenes with identical openings; a new break near the top (no cards shift); all cards
  planned (no pairs).
- `arrangeText` / `takePassage` / `insertPassage`: break lines kept as written; the new first passage
  loses its break; the old first gains the chapter's usual break; round-trip with the identity order;
  insert into an empty chapter.

**Done when:** all of the above pass, and nothing outside `shared/` (plus an optional export helper) changes.

### Step 2: match cards to text (read-only)

Tracking issue: https://github.com/BrendonKing32/lantern/issues/79

**Scope:** migration 0014; `SceneMeta` and schema changes; `worker/sceneSync.ts`; calls from
`saveChapter` and `saveAsClaude`; the self-healing `listScenes` and the new listing shape; linking,
unlinking and confirming (6.8); `in_text`-aware `PATCH` refusals; the one-time pairing and banner (7.2);
the Scenes view card states, placeholders, **Add card**, **This is…** and **Open** (7.1, minus dragging
text); the README.

Not in scope: anything that rearranges text.

**Tests (worker, using `worker/testing/d1.ts`):** a save updates word counts and anchors; a failing
match doesn't fail the save and leaves `scenes_version` behind; listing repairs a stale chapter; merge
→ the lower card becomes planned with `unlinked_at`; cut and paste across two chapters moves the card;
`link` / `unlink` / `confirm`; the one-time pairing when counts agree and when they don't;
`chapter_id` change refused for an in-text card. Update any existing test that reads
`GET /api/projects/:id/scenes`.

**Done when:** a writer can see which cards are in the text, with real word counts, link placeholders
to planned cards and open a scene in the editor. The README "Scenes" bullet describes this.

### Step 3: editor labels and Insert scene break

Tracking issue: https://github.com/BrendonKing32/lantern/issues/80

**Scope:** 7.3 and the README.

**Tests:** a unit test for the label extension's computed labels given a document and a card list; a
check that the widgets add no document text (doc length is unchanged).

**Done when:** labels show and follow typing, clicking opens the card, the toggle persists per device,
and the command inserts the chapter's usual break.

### Step 4: reorder passages within a chapter

Tracking issue: https://github.com/BrendonKing32/lantern/issues/81

**Scope:** the 6.5 endpoint, the shared save helper refactor, the `move` History reason (6.7), dragging
in-text cards within a chapter, the flush-before-move rule, the Undo notice, and the README.

**Tests:** reordering rewrites the text in the new order with History reason `move`; 409 on a stale
`baseVersion` and on a stale card list; daily words unchanged; positions-only when the passage order is
unchanged; placeholders stay attached to the passage before them.

**Done when:** dragging a card in the text reorders the chapter's text, it can be undone from the
notice and from History, and the streak doesn't move.

### Step 5: move a passage to another chapter

Tracking issue: https://github.com/BrendonKing32/lantern/issues/82

**Scope:** the 6.6 endpoint, dragging in-text cards across chapters, refusing drops on Unassigned,
and the README.

**Tests:** a successful move (text, both History copies, card row, word counts, zero daily words);
409 when either base version is stale, with neither chapter changed; a failing snapshot changes
nothing; a failing source write puts the destination back; a failing source write *and* a failing
restore leaves the scene in both chapters and returns the "both chapters" message. Simulate failures
by wrapping the R2 test double's `put`.

**Done when:** a scene can be dragged into another chapter with its text, and no failure path loses text.

### Step 6: connector and corkboard

Tracking issue: https://github.com/BrendonKing32/lantern/issues/83

**Scope:** section 8, 7.4, and the README "Connect Claude chat" section (mention `move_scene` under
"Read and edit").

**Tests:** `get_outline` shape; `read_chapter` with `scene_id`; `move_scene` refused on read-only
connections, logged in `claude_changes` on edit connections, and 409-style refusal text on a stale version.

**Done when:** Claude can read one scene and move scenes through the connector, and the corkboard shows
scene strips.
