import type { Env } from "./env";

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: object) {
    super(message);
  }
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export const now = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();
export const chapterKey = (projectId: string, chapterId: string) =>
  `projects/${projectId}/chapters/${chapterId}.md`;
export const snapshotKey = (projectId: string, chapterId: string, snapshotId: string) =>
  `projects/${projectId}/chapters/${chapterId}/history/${snapshotId}.md`;
export const MARKDOWN = { httpMetadata: { contentType: "text/markdown; charset=utf-8" } };

export async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

export function cleanTitle(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const t = value.trim().slice(0, 200);
  return t || fallback;
}

export type Params = Record<string, string>;
export type Handler = (req: Request, env: Env, p: Params, email?: string) => Promise<Response>;

export function isDay(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}
