// Worker entry point: route registration, authorization and error handling.
// Handlers live in ./handlers, one module per feature area.
import { AiError } from "./ai";
import { authorize } from "./auth";
import { createBackup } from "./backups";
import { ChangelogError } from "./changelog";
import type { Env } from "./env";
import { HttpError, json, type Handler, type Params } from "./http";
import {
  checkBook,
  checkChapterHandler,
  draftBibleEntryHandler,
  getAiStatus,
  lastBookCheck,
  testAi,
} from "./handlers/claude";
import { createEntry, deleteEntry, listBible, updateEntry } from "./handlers/bible";
import {
  createChapter,
  deleteChapter,
  getChapter,
  listDeletedChapters,
  reorderChapters,
  restoreChapter,
  saveChapter,
  updateChapter,
} from "./handlers/chapters";
import { getChangelog } from "./handlers/changelog";
import { getSnapshot, listHistory } from "./handlers/history";
import {
  createProject,
  deleteProject,
  getProject,
  listDeletedProjects,
  listProjects,
  restoreProject,
  setDialect,
  setTarget,
  updateProject,
} from "./handlers/projects";
import { createScene, deleteScene, listScenes, reorderScenes, updateScene } from "./handlers/scenes";
import {
  createShare,
  createShareComment,
  deleteShareComment,
  getSharedChapter,
  getSharedProject,
  getShareStatus,
  listShareComments,
  revokeShare,
} from "./handlers/sharing";
import { getStats, setGoal } from "./handlers/stats";
import { handleOAuth, isOAuthPath } from "./mcp/oauth";

export type { Env } from "./env";

// ---------- router ----------

const routes: Array<[string, string, Handler]> = [
  ["GET", "/api/projects", listProjects],
  ["GET", "/api/changelog", getChangelog],
  ["GET", "/api/stats", getStats],
  ["GET", "/api/ai/status", getAiStatus],
  ["POST", "/api/ai/test", testAi],
  ["POST", "/api/chapters/:id/check", checkChapterHandler],
  ["POST", "/api/chapters/:id/draft-entry", draftBibleEntryHandler],
  ["POST", "/api/projects/:id/check-book", checkBook],
  ["GET", "/api/projects/:id/check-book", lastBookCheck],
  ["GET", "/api/projects/:id/bible", listBible],
  ["GET", "/api/projects/:id/scenes", listScenes],
  ["PUT", "/api/projects/:id/scenes/order", reorderScenes],
  ["POST", "/api/chapters/:id/scenes", createScene],
  ["PATCH", "/api/scenes/:id", updateScene],
  ["DELETE", "/api/scenes/:id", deleteScene],
  ["POST", "/api/projects/:id/bible", createEntry],
  ["PATCH", "/api/bible/:id", updateEntry],
  ["DELETE", "/api/bible/:id", deleteEntry],
  ["PUT", "/api/goal", setGoal],
  ["PUT", "/api/projects/:id/target", setTarget],
  ["PUT", "/api/projects/:id/dialect", setDialect],
  ["GET", "/api/trash/projects", listDeletedProjects],
  ["POST", "/api/projects/:id/restore", restoreProject],
  ["GET", "/api/projects/:id/trash", listDeletedChapters],
  ["POST", "/api/chapters/:id/restore", restoreChapter],
  ["POST", "/api/projects", createProject],
  ["GET", "/api/projects/:id", getProject],
  ["PATCH", "/api/projects/:id", updateProject],
  ["DELETE", "/api/projects/:id", deleteProject],
  ["POST", "/api/projects/:id/chapters", createChapter],
  ["PUT", "/api/projects/:id/order", reorderChapters],
  ["GET", "/api/chapters/:id", getChapter],
  ["PUT", "/api/chapters/:id", saveChapter],
  ["PATCH", "/api/chapters/:id", updateChapter],
  ["DELETE", "/api/chapters/:id", deleteChapter],
  ["GET", "/api/chapters/:id/history", listHistory],
  ["GET", "/api/chapters/:id/history/:snapshotId", getSnapshot],
  ["GET", "/api/projects/:id/share", getShareStatus],
  ["POST", "/api/projects/:id/share", createShare],
  ["DELETE", "/api/projects/:id/share", revokeShare],
  ["GET", "/api/projects/:id/share/comments", listShareComments],
  ["DELETE", "/api/projects/:id/share/comments/:commentId", deleteShareComment],
];

const publicRoutes: Array<[string, string, Handler]> = [
  ["GET", "/api/share/:token", getSharedProject],
  ["GET", "/api/share/:token/chapters/:chapterId", getSharedChapter],
  ["POST", "/api/share/:token/comments", createShareComment],
];

function compileRoutes(routesToCompile: Array<[string, string, Handler]>) {
  return routesToCompile.map(([method, path, handler]) => {
    const names: string[] = [];
    const pattern = path.replace(/:(\w+)/g, (_, n) => {
      names.push(n);
      return "([^/]+)";
    });
    return { method, re: new RegExp(`^${pattern}$`), names, handler };
  });
}

const compiled = compileRoutes(routes);
const compiledPublic = compileRoutes(publicRoutes);

function matchRoute(
  routesToMatch: ReturnType<typeof compileRoutes>,
  req: Request,
  pathname: string,
) {
  for (const route of routesToMatch) {
    if (route.method !== req.method) continue;
    const match = pathname.match(route.re);
    if (!match) continue;
    const params: Params = {};
    route.names.forEach((name, i) => (params[name] = decodeURIComponent(match[i + 1])));
    return { route, params };
  }
  return null;
}

export default {
  async fetch(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    // The Claude connector: /mcp, /authorize and the OAuth endpoints.
    if (isOAuthPath(url.pathname) && ctx) return handleOAuth(req, env, ctx);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    try {
      const publicMatch = matchRoute(compiledPublic, req, url.pathname);
      if (publicMatch) return await publicMatch.route.handler(req, env, publicMatch.params);
      const email = await authorize(req, env);
      const match = matchRoute(compiled, req, url.pathname);
      if (match) return await match.route.handler(req, env, match.params, email);
      return json({ error: "Not found" }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
      if (e instanceof AiError) return json({ error: e.message, code: e.code }, e.status);
      if (e instanceof ChangelogError) return json({ error: e.message }, 502);
      console.error(e);
      return json({ error: "Server error" }, 500);
    }
  },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      createBackup(env).catch((e) => {
        console.error("scheduled backup failed", e);
        throw e;
      }),
    );
  },
} satisfies ExportedHandler<Env>;
