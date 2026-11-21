// Runs `wrangler preview` and retries it when Cloudflare's API fails on its side.
// Workers Builds runs this for pull request branches (deploy command: `npm run preview`).
// `wrangler preview` is in open beta and its API occasionally answers with a 5xx such as
// "Internal authentication error: internal server error [code: 10500]" even though the
// build and asset upload succeeded. Anything else, including real auth or config errors,
// fails straight away.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 5_000;

const TRANSIENT = [
  /\[code: 10500\]/i, // Cloudflare API internal error
  /internal server error/i,
  /\b(?:status|code)[: ]+5\d\d\b/i,
  /\b5\d\d (?:Bad Gateway|Service Unavailable|Gateway Time-?out|Internal Server Error)\b/i,
  /\b(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)\b/,
  /socket hang up/i,
  /fetch failed/i,
];

/** True when wrangler's output shows a failure on Cloudflare's side that's worth retrying. */
export function isTransient(output) {
  return TRANSIENT.some((pattern) => pattern.test(output));
}

function wranglerBin() {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("wrangler/package.json");
  const bin = require(pkgPath).bin;
  return join(dirname(pkgPath), typeof bin === "string" ? bin : bin.wrangler);
}

function runOnce(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [wranglerBin(), "preview", ...args], {
      stdio: ["inherit", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", (err) => resolve({ code: 1, output: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

export async function main(args, { run = runOnce, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.error } = {}) {
  for (let attempt = 1; ; attempt++) {
    const { code, output } = await run(args);
    if (code === 0) return 0;
    if (attempt >= MAX_ATTEMPTS || !isTransient(output)) return code;
    const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
    log(`\nwrangler preview hit a Cloudflare server error; retrying in ${delay / 1000}s (attempt ${attempt + 1} of ${MAX_ATTEMPTS})...\n`);
    await sleep(delay);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
