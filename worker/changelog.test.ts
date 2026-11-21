import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchChangelog } from "./changelog";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("GitHub changelog", () => {
  it("reads every page, filters unmerged PRs, and sorts by merge time", async () => {
    const firstPage = [
      { number: 12, title: "Older merge", merged_at: "2026-01-02T12:00:00Z", body: "private details" },
      ...Array.from({ length: 99 }, (_, i) => ({ number: i + 100, title: "Closed", merged_at: null })),
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(firstPage))
      .mockResolvedValueOnce(json([
        { number: 7, title: "Newer merge", merged_at: "2026-01-03T12:00:00Z" },
        { number: 12, title: "Duplicate", merged_at: "2026-01-02T12:00:00Z" },
      ]));

    await expect(fetchChangelog("test-token")).resolves.toEqual([
      {
        number: 7,
        title: "Newer merge",
        merged_at: "2026-01-03T12:00:00Z",
        url: "https://github.com/BrendonKing32/lantern/pull/7",
      },
      {
        number: 12,
        title: "Older merge",
        merged_at: "2026-01-02T12:00:00Z",
        url: "https://github.com/BrendonKing32/lantern/pull/12",
      },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(String(fetchMock.mock.calls[0][0]));
    const secondUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(firstUrl.searchParams.get("state")).toBe("closed");
    expect(firstUrl.searchParams.get("base")).toBe("main");
    expect(firstUrl.searchParams.get("per_page")).toBe("100");
    expect(secondUrl.searchParams.get("page")).toBe("2");
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer test-token");
  });

  it("reports invalid GitHub data rather than returning a partial history", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json([
      { number: 1, title: "Valid", merged_at: "2026-01-01T12:00:00Z" },
      { number: 2, title: "Invalid", merged_at: "not a date" },
    ]));
    await expect(fetchChangelog("test-token")).rejects.toThrow("unreadable");
  });

  it("reports GitHub refusal and connection failures without exposing the token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ message: "private details" }, 403));
    await expect(fetchChangelog("test-token")).rejects.toThrow("GitHub returned 403");
    fetchMock.mockRejectedValueOnce(new Error("test-token"));
    await expect(fetchChangelog("test-token")).rejects.toThrow("Couldn't reach GitHub");
  });

  it("does not follow a GitHub redirect with the private token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "https://example.com/elsewhere" },
    }));
    await expect(fetchChangelog("test-token")).rejects.toThrow("GitHub returned 302");
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe("manual");
  });
});
