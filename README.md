# Lantern

A markdown novel-writing app on Cloudflare. Milestone 1 covers projects, a
drag-to-reorder chapter list, a live-markdown editor with autosave, word
counts, and conflict protection across devices.

- **Front end:** React, TypeScript, and CodeMirror 6, served as static assets
- **API:** a Cloudflare Worker (`worker/index.ts`)
- **Text:** plain `.md` files in R2 (`lantern-manuscripts`), one per chapter
- **Metadata:** D1 (`lantern-db`), holding projects, chapter order, titles, word counts, and versions
- **Login:** Cloudflare Access in front of `lantern.bkbuilds.dev`

The R2 bucket and D1 database already exist in your Cloudflare account and are wired up in `wrangler.toml`.

## One-time setup

```sh
npm install
npx wrangler login
npm run db:migrate          # creates the tables in lantern-db
```

### Protect it with Cloudflare Access (do this before the first deploy)

1. In the Cloudflare dashboard, go to **Zero Trust → Access → Applications → Add an application → Self-hosted**.
2. Set the application domain to `lantern.bkbuilds.dev`. Add a policy: **Allow**, then under Include choose **Emails** and enter your email.
3. Save, then open the application's **Overview** and copy the **Application Audience (AUD) tag**.
4. Find your team domain under **Zero Trust → Settings**. It looks like `yourteam.cloudflareaccess.com`.
5. Put both values in `wrangler.toml` under `[vars]`:
   ```toml
   ACCESS_TEAM_DOMAIN = "yourteam.cloudflareaccess.com"
   ACCESS_AUD = "the-aud-tag"
   ```

The Worker checks the Access token on every private API call. It refuses
private API requests while those two values are empty, so a deploy before this
step stays locked. Review links use separate, limited public endpoints.

### Allow unlisted manuscript reviews

Review links are public bearer links, so Cloudflare Access must let those paths
through without weakening the private app. Add Access **Bypass** applications
for `lantern.bkbuilds.dev/share/*`, `lantern.bkbuilds.dev/api/share/*`, and
`lantern.bkbuilds.dev/assets/*`, each with an **Everyone** policy. Do not bypass
`/api/*` broadly: only `/api/share/*` serves a valid review link without sign-in.
The `/assets/*` path exposes only the app's built JavaScript and styles; the
manuscript is returned only after the share token is checked by the Worker.

## Deploy

```sh
npm run deploy
```

This builds the app, applies any new database migrations to `lantern-db`, and publishes it at `lantern.bkbuilds.dev`. The custom
domain is created automatically because bkbuilds.dev is on Cloudflare.
The `workers.dev` URL is turned off. Cloudflare Access protects the writing
app and private API; the explicitly bypassed paths above serve unlisted reviews.

### Automatic deploys from GitHub (optional)

Every push and pull request runs the **CI** workflow (tests, typecheck and build).
The **Deploy** workflow publishes `main` to Cloudflare, but it stays off until you turn it on:

1. Create a Cloudflare API token (**My Profile → API Tokens → Create Token**) using the
   **Edit Cloudflare Workers** template, and add **Account → D1 → Edit** and
   **Account → Workers R2 Storage → Edit** permissions.
2. In the GitHub repo, go to **Settings → Secrets and variables → Actions** and add:
   - Secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (the account ID is on your Cloudflare dashboard's overview page)
   - Variable: `CLOUDFLARE_DEPLOY` set to `true`

After that, merging to `main` applies any new migrations and deploys.

The values in `wrangler.toml` (database ID, Access team domain, and AUD tag) are
identifiers, not secrets, so they're fine to commit. Real secrets go in
GitHub secrets or `wrangler secret put`, never in the repo.

## Backups

Lantern writes a daily backup to a separate, private R2 bucket. Before the first
deploy with backups enabled, create it:

```sh
npx wrangler r2 bucket create lantern-backups
```

The Worker runs the backup at 03:17 UTC. Each complete backup contains a
restorable SQL export of every D1 table, every object in `lantern-manuscripts`
(including chapter history), and a manifest. Backups older than 30 days are
deleted. A backup is marked complete only after confirming that no chapter
version changed while its text was copied. Check the Worker logs for
`scheduled backup failed`; an incomplete run has no manifest and should not be
used for recovery.

The backup bucket is separate but in the same Cloudflare account, so it helps
recover from accidental changes or loss of the primary bucket/database; it
doesn't protect against loss of the entire Cloudflare account.

### Restore

Stop writing in Lantern while restoring. Choose a backup directory containing
`manifest.json` in the R2 dashboard, then use its timestamp as `<backup-id>`.
The D1 SQL restore replaces the app's current rows, so review the file and make
sure the database migrations are already applied:

```powershell
npx wrangler r2 object get lantern-backups/backups/<backup-id>/database.sql --file .\database.sql
npx wrangler d1 execute lantern-db --remote --file .\database.sql
.\scripts\restore-r2-backup.ps1 -BackupId <backup-id>
```

The PowerShell script restores the listed manuscript and history objects into
`lantern-manuscripts`, overwriting matching keys without deleting any others.

## Claude (optional)

Lantern can call Claude for writing help. It needs an Anthropic API key, which is
billed by use, separately from any claude.ai subscription.

1. At [console.anthropic.com](https://console.anthropic.com), add billing and set a
   monthly spend limit, then create a key under **API Keys**.
2. Run `npx wrangler secret put ANTHROPIC_API_KEY` and paste the key. Cloudflare
   stores it encrypted; it never goes in the repo, and it survives deploys.
3. On the shelf, open **Claude** and use **Test connection**.

Every call goes through the same safeguards (`worker/ai.ts`):

- **Daily limit:** at most `AI_DAILY_LIMIT` calls in any 24 hours (30 by default).
- **Monthly budget:** `AI_MONTHLY_BUDGET_USD` per calendar month, UTC ($10 by default).
  The most a call could cost is reserved before it's made, and the call is refused
  if that could pass the budget, so the limit holds even with calls running at once.
- **Size caps** on what's sent and on how long a reply can be.
- **A log** of every call with its tokens and estimated cost, shown in the Claude
  panel. Calls Anthropic rejects aren't counted; interrupted ones count at their maximum.

The model and both limits are in `wrangler.toml` under `[vars]`. Costs shown are
estimates from published prices; the Anthropic Console has the actual bill, and its
spend limit is a second, independent cap.

## Local development

```sh
cp .dev.vars.example .dev.vars   # skips Access locally
npm run db:migrate:local
npm run dev:api                  # API plus local D1/R2 on :8787
npm run dev                      # UI with hot reload on :5173 (proxies /api)
```

Local data is simulated and lives in `.wrangler/`. It never touches your real bucket.

## Installing as an app

Open Lantern in Chrome or Edge over HTTPS (or localhost), then use the browser's
address-bar install icon or **Install page as app** menu item. Lantern opens in
its own window and starts on the shelf. Sign-in and offline writing work just as
they do in a browser tab; installation does not make server-only features
available offline.

The manifest and app icons contain no private data. If Cloudflare Access blocks
Chromium from fetching them during installation, add Access **Bypass**
applications for `lantern.bkbuilds.dev/manifest.webmanifest` and
`lantern.bkbuilds.dev/icons/*`, each with an **Everyone** policy. Keep the writing
app and private API protected.

## Using it

- **Rename** a chapter or the novel: double-click its title, or use the pencil button.
- **Reorder** chapters: drag the handle beside a chapter, or focus the handle and use Space plus the arrow keys.
- **Corkboard:** switch between **Write** and **Corkboard** at the top. Each chapter is an
  index card with its title, synopsis and word count. Drag cards (or Space and the arrow keys)
  to reorder the book, click a synopsis to write one (Esc cancels, ⌘/Ctrl+Enter saves), and
  **Open** a card to write that chapter.
- **Scenes:** the **Scenes** view keeps planning cards inside each chapter. Add and reorder
  scenes, then note a summary, POV, location and whether the scene is planned or drafted.
  Scene cards are planning notes and do not split or change the chapter manuscript.
- **Search:** the **Search** view finds literal words or phrases across the whole book, including
  drafts saved on this device. Choose whether to match case, then open a result to jump to it
  in the chapter editor. Search shows up to 500 matches at a time. **Replace across the book**
  previews chapter counts first, includes this device's unsaved drafts, checks for version conflicts,
  and saves a restorable copy of each changed chapter in History before replacing.
- **Review links:** **Share** creates an unlisted read-only link that stays active until revoked.
  Anyone with the link can read the manuscript and leave chapter-level feedback; feedback
  is private to the author and is never shown to other reviewers. The author can review or delete
  comments in Share, and can revoke or replace the link at any time. Review links need a connection.
- **Story guide:** the **Story Guide** view keeps the novel's characters, places, things and notes,
  each with a name, other names it goes by, and free-form notes that save as you type.
  Link to an entry from a chapter with `[[Name]]`, or `[[Name|shown text]]` to show different
  words; typing `[[` suggests entries. Links to an entry are underlined in amber and links to
  a name with no entry are dotted. Click a link to see the entry beside the page, or add it.
  Each entry lists the chapters that mention it, linked or not. Exports show links as plain
  text (`[[Mara|her]]` becomes "her"); the Markdown export keeps them as written.
- **Continuity check:** while writing, **Check** sends the chapter on screen to Claude with
  the story guide entries it links to or names, the names of the other entries, and the synopses
  of earlier chapters. Claude returns contradictions with the story guide or earlier chapters,
  places the chapter contradicts itself, and new facts worth adding to the story guide, each
  quoting the passage; click a quote to jump to it. The panel shows what will be sent and
  the estimated cost first. For a new-fact finding, **Draft Story Guide entry** suggests a concise
  reference note from the chapter and selected passage. Review and edit the name, category,
  aliases and notes before adding it; nothing is saved automatically, and Claude never writes
  or changes the chapter. Needs Claude set up (see below); until then it says so.
- **Whole-book check:** the **Whole book** tab in the same panel sends every chapter in
  order (unsaved writing included) with the whole story guide, and reports contradictions between
  chapters, timeline problems, and where the story guide has fallen behind. Findings are grouped by
  chapter; click a quote to open that chapter at it. A run takes a few minutes, so keep the
  page open; the last result is saved and shows again on any device. Books up to about
  160,000 words fit in one check.
- **Grammar and spelling:** pick **Grammar: US English** or **Grammar: UK English** in the desk
  bar (or **Grammar off**), and [Harper](https://writewithharper.com) checks the chapter as you write and underlines problems: rose for spelling, amber for
  grammar, dotted for style. Hover an underline for the suggested fix, **Add to dictionary**,
  or **Ignore**. Harper runs entirely in the browser, so chapter text never leaves the device
  for these checks. Story guide names and aliases, and `[[links]]`, are never flagged as
  misspellings. The checker downloads once (about 8.5 MB compressed) the first time it runs,
  then works offline. The US/UK choice belongs to the novel, so every device checks it
  the same way; each device keeps its own on/off setting, dictionary and ignored problems. With Grammar off, the browser's own spellcheck is used instead.
- **Themes:** pick Lantern, Hearth, Pine, Tide, or Parchment (a light theme) from the menu on the shelf or in the desk bar. Each device remembers its own choice.
- **The lamp:** the light behind the page brightens as you write. With a daily goal it reaches
  full glow when you meet the goal; without one, at 1,000 words in a session.
- **Daily goal and streak:** the panel at the top of the shelf shows today's words, your
  streak and the last 12 weeks. **Set a daily goal** to count only days that meet it toward the
  streak; with no goal, any day with writing counts. Today never breaks a streak before it ends.
  Words are net (deleting counts against the day), credited to your local date, and restoring a
  version from History doesn't count.
- **Export:** the Export button in a novel saves it as a Word manuscript (.docx: standard
  manuscript format with a title page, running header and `#` scene breaks), a typeset PDF
  for reading or printing, an EPUB e-book, or a Markdown .zip (a file per chapter plus the whole
  book). Files are built in the browser
  from what's on screen, unsaved writing included, so export works offline too. A heading at
  the top of a chapter that repeats its title is dropped, and `***`, `---` or a lone `#` marks
  a scene break.
- **Novel target:** under the novel's word count, **Set a target length**, optionally with a
  finish date, to see progress and the words a day needed to make it.
- **Saving:** every keystroke is kept on the device first (IndexedDB), then saved about a
  second after you pause. When you're offline it keeps retrying, and reloading is safe. If the
  browser blocks local draft storage, Lantern reports it and won't open a chapter it can't
  safely check for an unsaved draft.
- **History:** the History button shows earlier versions of the open chapter. Lantern keeps a
  copy at most every 10 minutes while you write, plus one before every restore, whole-book
  replacement, and before you replace another device's version. Pick one to read it, then **Restore this version**. Restoring
  is itself undoable from History. Copies live in R2 under each chapter's `history/` folder.
- **Offline:** once a novel has been opened online, the app, the shelf and every chapter of that
  novel are kept on the device, so Lantern opens and lets you write with no connection. Unsaved
  writing from any chapter is sent when you reconnect. Creating, renaming, reordering, deleting
  and restoring still need a connection.
- **Two devices:** if a chapter was saved somewhere else while you were writing,
  Lantern stops and asks which version to keep instead of overwriting either one.
- **Deleted chapters** move to **Recently deleted** under the chapter list. The arrow button
  puts one back at the end of the book, with its text and history intact.
- **Archive a novel:** on the shelf, hover it and use the box button. Archived novels
  move to the **Archived** section at the bottom, where the arrow button puts them back.
- **Delete a novel:** the trash button, on the shelf or in Archived. It moves to **Deleted**
  at the bottom of the shelf, where the arrow button restores it with all its chapters.
