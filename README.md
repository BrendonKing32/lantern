# Lantern

A markdown novel-writing app on Cloudflare. Milestone 1 covers projects, a
drag-to-reorder chapter list, a live-markdown editor with autosave, word
counts, conflict protection across devices, and Dusk mode.

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

The Worker checks the Access token on every API call. It refuses everything
while those two values are empty, so a deploy before this step stays locked.

## Deploy

```sh
npm run deploy
```

This builds the app and publishes it at `lantern.bkbuilds.dev`. The custom
domain is created automatically because bkbuilds.dev is on Cloudflare.
The `workers.dev` URL is turned off, so Access is the only way in.

### Automatic deploys from GitHub (optional)

Every push and pull request runs the **CI** workflow (typecheck and build).
The **Deploy** workflow publishes `main` to Cloudflare, but it stays off until you turn it on:

1. Create a Cloudflare API token (**My Profile → API Tokens → Create Token**) using the
   **Edit Cloudflare Workers** template, and add **Account → D1 → Edit** permission.
2. In the GitHub repo, go to **Settings → Secrets and variables → Actions** and add:
   - Secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (the account ID is on your Cloudflare dashboard's overview page)
   - Variable: `CLOUDFLARE_DEPLOY` set to `true`

After that, merging to `main` applies any new migrations and deploys.

The values in `wrangler.toml` (database ID, Access team domain, and AUD tag) are
identifiers, not secrets, so they're fine to commit. Real secrets go in
GitHub secrets or `wrangler secret put`, never in the repo.

## Local development

```sh
cp .dev.vars.example .dev.vars   # skips Access locally
npm run db:migrate:local
npm run dev:api                  # API plus local D1/R2 on :8787
npm run dev                      # UI with hot reload on :5173 (proxies /api)
```

Local data is simulated and lives in `.wrangler/`. It never touches your real bucket.

## Using it

- **Rename** a chapter or the novel: double-click its title, or use the pencil button.
- **Reorder** chapters: drag them, or focus one and use Space plus the arrow keys.
- **Dusk mode:** the Dusk button or ⌘⇧D. Press Esc to leave.
- **The lamp:** the light behind the page brightens as you add words in a session, reaching full glow at 1,000.
- **Saving:** every keystroke is kept in the browser first, then saved about a
  second after you pause. When you're offline it keeps retrying, and reloading is safe.
- **Two devices:** if a chapter was saved somewhere else while you were writing,
  Lantern stops and asks which version to keep instead of overwriting either one.
- **Deleted chapters** leave the book, but their text stays in R2.

## What's next

- **Milestone 2:** IndexedDB offline cache and sync queue, version history, restoring deleted chapters
- **Milestone 3:** corkboard with synopses, goals and streaks, export (.md zip, .docx, .epub)
- **Milestone 4:** story bible with `[[wikilinks]]`, Claude continuity helpers
