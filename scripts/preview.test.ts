import { describe, expect, it, vi } from "vitest";
import { isTransient, main, MAX_ATTEMPTS } from "./preview.mjs";

const CF_10500 = `✘ [ERROR] A request to the Cloudflare API (/accounts/x/workers/workers/lantern/previews/y/deployments/latest) failed.

  Internal authentication error: internal server error [code: 10500]`;

describe("preview retry", () => {
  it("treats Cloudflare server errors and dropped connections as transient", () => {
    expect(isTransient(CF_10500)).toBe(true);
    expect(isTransient("Received a 502 Bad Gateway from the API")).toBe(true);
    expect(isTransient("TypeError: fetch failed\n  cause: ECONNRESET")).toBe(true);
  });

  it("does not retry auth, permission or config errors", () => {
    expect(isTransient("Authentication error [code: 10000]")).toBe(false);
    expect(isTransient("You do not have permission to perform this action")).toBe(false);
    expect(isTransient("Processing wrangler.toml configuration: unexpected key")).toBe(false);
  });

  it("retries a transient failure and returns success", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ code: 1, output: CF_10500 })
      .mockResolvedValueOnce({ code: 0, output: "Preview deployed" });
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(main(["--x"], { run, sleep, log: () => {} })).resolves.toBe(0);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith(["--x"]);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("fails immediately on a non-transient error", async () => {
    const run = vi.fn().mockResolvedValue({ code: 1, output: "Authentication error [code: 10000]" });
    await expect(main([], { run, sleep: vi.fn(), log: () => {} })).resolves.toBe(1);
    expect(run).toHaveBeenCalledOnce();
  });

  it("gives up after the last attempt", async () => {
    const run = vi.fn().mockResolvedValue({ code: 1, output: CF_10500 });
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(main([], { run, sleep, log: () => {} })).resolves.toBe(1);
    expect(run).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(sleep).toHaveBeenCalledTimes(MAX_ATTEMPTS - 1);
  });
});
