import { describe, expect, it } from "vitest";
import worker, { type Env } from "./index";

async function hash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function shareEnv(tokenHash: string): Env {
  const db = {
    prepare(sql: string) {
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          params = values;
          return {
            async first() {
              if (sql.includes("FROM project_shares")) {
                return params[0] === tokenHash ? { id: "share-1", project_id: "project-1" } : null;
              }
              if (sql.includes("SELECT title FROM projects")) return { title: "Shared novel" };
              return null;
            },
            async all() {
              if (sql.includes("FROM chapters")) {
                return { results: [{ id: "chapter-1", title: "Chapter 1", word_count: 21 }] };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  };
  return { DB: db as unknown as D1Database } as Env;
}

describe("public manuscript review links", () => {
  it("serves only the shared title and chapter list without an Access token", async () => {
    const token = "a".repeat(64);
    const env = shareEnv(await hash(token));
    const response = await worker.fetch(
      new Request(`https://lantern.test/api/share/${token}`),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      project: { title: "Shared novel" },
      label: "",
      chapters: [{ id: "chapter-1", title: "Chapter 1", word_count: 21 }],
    });
  });

  it("rejects unknown share tokens", async () => {
    const token = "b".repeat(64);
    const response = await worker.fetch(
      new Request(`https://lantern.test/api/share/${token}`),
      shareEnv("not-the-token-hash"),
    );

    expect(response.status).toBe(404);
  });
});
