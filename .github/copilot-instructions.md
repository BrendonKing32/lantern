# Working on Lantern

Lantern is a single-writer markdown novel app: React + CodeMirror 6 front end (`src/`), one Cloudflare
Worker API (`worker/index.ts` holds the route table, `worker/handlers/` one module per feature), chapter
text in R2 and metadata in D1. Code shared by both lives in `shared/`. The README is the user manual
and the setup guide.

## Before you open a pull request

- `npm test`, `npm run typecheck` and `npx vite build` must all pass. CI runs the same three.
- When your issue points to a design spec in `docs/design/`, follow it. Do only the step your issue
  names. If the spec is wrong against the code, say so in the PR description; don't redesign.

## Conventions

- **Tests sit beside the code** (`foo.ts` → `foo.test.ts`), using Vitest. Worker tests use the real-SQLite
  D1 double and in-memory R2 in `worker/testing/d1.ts`, which applies every migration. Test the Worker's
  real SQL, not mocks.
- **Migrations** are numbered SQL files in `migrations/`, applied in order. Never edit a migration that
  has already shipped; add a new one. Start each with a one-line comment saying why.
- **API responses are validated** on the client by `src/schemas.ts`. A change to a shared type in
  `shared/types.ts` needs the matching schema change, or the app rejects the response.
- **Chapter text is the author's.** Never rewrite, reformat or normalize chapter text except where a
  feature is explicitly about that. Every server-side change to chapter text keeps the previous text in
  History first (`snapshotBeforeSave` in `worker/handlers/history.ts`) and refuses to save if it can't.
- **Saves are version-checked:** claim `version + 1` with `WHERE version = ?`, and roll back on failure.
  Follow the pattern in `saveChapter` (`worker/handlers/chapters.ts`).
- **Daily words** count only the author's own writing. Restores, moves and Claude's edits add 0.
- **Offline-first:** text edits work offline through IndexedDB drafts (`src/local.ts`, `src/sync.ts`).
  Structural actions (create, rename, reorder, move) need a connection and must say so when offline.
- **Styling** uses the tokens in `src/styles.css`. Add no new colours. Every theme, light Parchment
  included, must stay readable.

## Writing (README, UI copy, error messages)

- Plain, direct sentences from the writer's side of the screen. Name things the way the app shows them
  (**Scenes**, **History**, **Story Guide**), in bold for UI labels.
- Errors say what happened and what to do next, without apologizing.
- Update the README's **Using it** section whenever user-visible behaviour changes.

## Commits

- Subject: an imperative sentence describing the change for the writer, e.g. "Let scenes exist on their
  own, outside any chapter". No `feat:`-style prefixes.
- Body: a short summary, then bullets per area (migration, API, UI, connector).
