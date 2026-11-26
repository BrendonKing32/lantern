import { describe, expect, it } from "vitest";
import worker, { type Env } from "./index";

type Project = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  deleted_at: string | null;
  target_words: number | null;
  target_date: string | null;
  dialect: string;
};

type Chapter = {
  id: string;
  project_id: string;
  title: string;
  synopsis: string;
  position: number;
  word_count: number;
  version: number;
  updated_at: string;
  deleted_at: string | null;
};

type Snapshot = {
  id: string;
  chapter_id: string;
  version: number;
  word_count: number;
  reason: string;
  created_at: string;
};

type Share = {
  id: string;
  project_id: string;
  owner_email: string;
  token_hash: string;
  revoked_at: string | null;
};

type Comment = {
  id: string;
  share_id: string;
  chapter_id: string;
  display_name: string;
  body: string;
  created_at: string;
};

type State = {
  projects: Project[];
  chapters: Chapter[];
  snapshots: Snapshot[];
  shares: Share[];
  comments: Comment[];
  dailyWords: Map<string, number>;
};

const initialProject = (): Project => ({
  id: "project-1",
  title: "A Lantern Novel",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  archived_at: null,
  deleted_at: null,
  target_words: null,
  target_date: null,
  dialect: "american",
});

const initialChapter = (overrides: Partial<Chapter> = {}): Chapter => ({
  id: "chapter-1",
  project_id: "project-1",
  title: "Chapter 1",
  synopsis: "",
  position: 0,
  word_count: 4,
  version: 0,
  updated_at: "2026-01-01T00:00:00.000Z",
  deleted_at: null,
  ...overrides,
});

function fakeBucket(initial: Record<string, string> = {}) {
  const contents = new Map(Object.entries(initial));
  const bucket = {
    contents,
    get: async (key: string) => {
      const value = contents.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    put: async (key: string, value: string) => {
      contents.set(key, value);
    },
  };
  return bucket as unknown as R2Bucket & typeof bucket;
}

function fakeDatabase(state: State) {
  function first(sql: string, params: unknown[]): unknown {
    if (sql.includes("FROM chapter_snapshots") && sql.includes("ORDER BY created_at DESC LIMIT 1")) {
      return [...state.snapshots].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
    }
    if (sql.includes("FROM chapter_snapshots") && sql.includes("WHERE id = ? AND chapter_id = ?")) {
      return state.snapshots.find((s) => s.id === params[0] && s.chapter_id === params[1]) ?? null;
    }
    if (sql.includes("FROM project_shares") && sql.includes("token_hash = ?")) {
      const share = state.shares.find((s) => s.token_hash === params[0] && !s.revoked_at);
      return share ? { id: share.id, project_id: share.project_id } : null;
    }
    if (sql.includes("FROM projects p") && sql.includes("WHERE p.id = ?")) {
      const project = state.projects.find((p) => p.id === params[0]);
      if (!project) return null;
      const chapters = state.chapters.filter((c) => c.project_id === project.id && !c.deleted_at);
      return {
        ...project,
        chapter_count: chapters.length,
        word_count: chapters.reduce((sum, chapter) => sum + chapter.word_count, 0),
      };
    }
    if (sql.includes("FROM projects WHERE id = ?")) {
      return state.projects.find((p) => p.id === params[0] && !p.deleted_at) ?? null;
    }
    if (sql.includes("FROM chapters") && sql.includes("deleted_at IS NOT NULL")) {
      const chapter = state.chapters.find((c) => c.id === params[0] && c.deleted_at);
      return chapter ? { project_id: chapter.project_id } : null;
    }
    if (sql.includes("FROM chapters") && sql.includes("WHERE id = ? AND project_id = ?")) {
      const chapter = state.chapters.find(
        (c) => c.id === params[0] && c.project_id === params[1] && !c.deleted_at,
      );
      return chapter ? { id: chapter.id } : null;
    }
    if (sql.includes("FROM chapters") && sql.includes("WHERE id = ?")) {
      const chapter = state.chapters.find((c) => c.id === params[0] && !c.deleted_at);
      if (!chapter || !state.projects.some((p) => p.id === chapter.project_id && !p.deleted_at)) return null;
      return { ...chapter };
    }
    if (sql.includes("MAX(position)") && sql.includes("FROM chapters")) {
      const positions = state.chapters
        .filter((c) => c.project_id === params[0] && !c.deleted_at)
        .map((c) => c.position);
      return { m: positions.length ? Math.max(...positions) : -1 };
    }
    if (sql.includes("SELECT COALESCE(SUM(words), 0) AS w")) {
      return { w: [...state.dailyWords.values()].reduce((sum, words) => sum + words, 0) };
    }
    if (sql.includes("COUNT(*) AS count FROM share_comments")) {
      return { count: state.comments.filter((c) => c.share_id === params[0]).length };
    }
    if (sql.includes("SELECT title FROM projects")) {
      const project = state.projects.find((p) => p.id === params[0] && !p.deleted_at);
      return project ? { title: project.title } : null;
    }
    return null;
  }

  function all(sql: string, params: unknown[]): unknown[] {
    if (sql.includes("FROM chapter_snapshots") && sql.includes("ORDER BY created_at DESC")) {
      return state.snapshots
        .filter((s) => s.chapter_id === params[0])
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map(({ id, version, word_count, reason, created_at }) => ({ id, version, word_count, reason, created_at }));
    }
    if (sql.includes("FROM chapters") && sql.includes("WHERE project_id = ? AND deleted_at IS NULL")) {
      return state.chapters
        .filter((c) => c.project_id === params[0] && !c.deleted_at)
        .map(({ id, project_id, title, synopsis, position, word_count, version, updated_at }) => ({
          id, project_id, title, synopsis, position, word_count, version, updated_at,
        }));
    }
    if (sql.includes("FROM chapters") && sql.includes("project_id = ? AND deleted_at IS NULL ORDER BY position")) {
      return state.chapters.filter((c) => c.project_id === params[0] && !c.deleted_at);
    }
    if (sql.includes("FROM share_comments AS comments")) {
      const [projectId, email] = params;
      return state.comments
        .filter((comment) => {
          const share = state.shares.find((s) => s.id === comment.share_id);
          return share !== undefined && share.project_id === projectId && share.owner_email === email;
        })
        .map((comment) => ({
          id: comment.id,
          chapter_id: comment.chapter_id,
          chapter_title: state.chapters.find((c) => c.id === comment.chapter_id)?.title,
          display_name: comment.display_name,
          body: comment.body,
          created_at: comment.created_at,
        }));
    }
    if (sql.includes("SELECT id FROM chapters")) {
      return state.chapters
        .filter((c) => c.project_id === params[0] && !c.deleted_at)
        .map(({ id }) => ({ id }));
    }
    if (sql.includes("FROM chapters") && sql.includes("id = ? AND project_id = ?")) {
      const chapter = state.chapters.find((c) => c.id === params[0] && c.project_id === params[1] && !c.deleted_at);
      return chapter ? [{ id: chapter.id }] : [];
    }
    if (sql.includes("FROM chapters") && sql.includes("project_id = ? AND deleted_at IS NULL ORDER BY position")) {
      return state.chapters.filter((c) => c.project_id === params[0] && !c.deleted_at);
    }
    return [];
  }

  function run(sql: string, params: unknown[]) {
    let changes = 0;
    if (sql.startsWith("INSERT INTO projects")) {
      state.projects.push({
        id: String(params[0]),
        title: String(params[1]),
        created_at: String(params[2]),
        updated_at: String(params[3]),
        archived_at: null,
        deleted_at: null,
        target_words: null,
        target_date: null,
        dialect: "american",
      });
      changes = 1;
    } else if (sql.startsWith("INSERT INTO chapters")) {
      state.chapters.push({
        id: String(params[0]),
        project_id: String(params[1]),
        title: String(params[2]),
        synopsis: "",
        position: Number(params[3]),
        word_count: 0,
        version: 0,
        updated_at: String(params[5]),
        deleted_at: null,
      });
      changes = 1;
    } else if (sql.startsWith("UPDATE chapters SET version = version + 1")) {
      const chapter = state.chapters.find((c) => c.id === params[2] && c.version === params[3] && !c.deleted_at);
      if (chapter) {
        chapter.version++;
        chapter.word_count = Number(params[0]);
        chapter.updated_at = String(params[1]);
        changes = 1;
      }
    } else if (sql.startsWith("INSERT INTO chapter_snapshots")) {
      state.snapshots.push({
        id: String(params[0]),
        chapter_id: String(params[1]),
        version: Number(params[2]),
        word_count: Number(params[3]),
        reason: String(params[4]),
        created_at: String(params[5]),
      });
      changes = 1;
    } else if (sql.startsWith("UPDATE projects SET updated_at")) {
      const project = state.projects.find((p) => p.id === params[1]);
      if (project) project.updated_at = String(params[0]);
      changes = project ? 1 : 0;
    } else if (sql.startsWith("UPDATE projects SET title")) {
      const project = state.projects.find((p) => p.id === params[2]);
      if (project) {
        project.title = String(params[0]);
        project.updated_at = String(params[1]);
        changes = 1;
      }
    } else if (sql.startsWith("UPDATE projects SET archived_at")) {
      const project = state.projects.find((p) => p.id === params[1]);
      if (project) {
        project.archived_at = params[0] as string | null;
        changes = 1;
      }
    } else if (sql.startsWith("UPDATE projects SET deleted_at = NULL")) {
      const project = state.projects.find((p) => p.id === params[0] && p.deleted_at);
      if (project) {
        project.deleted_at = null;
        changes = 1;
      }
    } else if (sql.startsWith("UPDATE projects SET deleted_at = ?")) {
      const project = state.projects.find((p) => p.id === params[1] && !p.deleted_at);
      if (project) {
        project.deleted_at = String(params[0]);
        changes = 1;
      }
    } else if (sql.startsWith("UPDATE chapters SET title = COALESCE")) {
      const chapter = state.chapters.find((c) => c.id === params[3]);
      if (chapter) {
        if (params[0] !== null) chapter.title = String(params[0]);
        if (params[1] !== null) chapter.synopsis = String(params[1]);
        changes = 1;
      }
    } else if (sql.startsWith("UPDATE chapters SET deleted_at = NULL")) {
      const chapter = state.chapters.find((c) => c.id === params[2] && c.deleted_at);
      if (chapter) {
        chapter.deleted_at = null;
        chapter.position = state.chapters
          .filter((c) => c.project_id === params[1] && c.id !== chapter.id && !c.deleted_at)
          .reduce((max, c) => Math.max(max, c.position), -1) + 1;
        changes = 1;
      }
    } else if (sql.startsWith("UPDATE chapters SET deleted_at = ?")) {
      const chapter = state.chapters.find((c) => c.id === params[1] && !c.deleted_at);
      if (chapter) {
        chapter.deleted_at = String(params[0]);
        changes = 1;
      }
    } else if (sql.startsWith("UPDATE chapters SET version = ?, word_count = ?, updated_at = ?")) {
      const chapter = state.chapters.find((c) => c.id === params[3] && c.version === params[4]);
      if (chapter) {
        chapter.version = Number(params[0]);
        chapter.word_count = Number(params[1]);
        chapter.updated_at = String(params[2]);
        changes = 1;
      }
    } else if (sql.startsWith("INSERT INTO daily_words")) {
      const key = `${String(params[0])}:${String(params[1])}`;
      state.dailyWords.set(key, (state.dailyWords.get(key) ?? 0) + Number(params[2]));
      changes = 1;
    } else if (sql.startsWith("INSERT INTO share_comments")) {
      state.comments.push({
        id: String(params[0]),
        share_id: String(params[1]),
        chapter_id: String(params[2]),
        display_name: String(params[3]),
        body: String(params[4]),
        created_at: String(params[5]),
      });
      changes = 1;
    } else if (sql.startsWith("DELETE FROM share_comments")) {
      const [commentId, projectId, email] = params;
      const index = state.comments.findIndex((comment) => {
        const share = state.shares.find((s) => s.id === comment.share_id);
        return comment.id === commentId && share !== undefined && share.project_id === projectId && share.owner_email === email;
      });
      if (index >= 0) {
        state.comments.splice(index, 1);
        changes = 1;
      }
    }
    return { success: true, results: [], meta: { changes } };
  }

  const db = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const statement = {
        sql,
        bind(...values: unknown[]) {
          params = values;
          return statement;
        },
        async first<T>() {
          return (first(sql, params) as T | null) ?? null;
        },
        async all<T>() {
          return { results: all(sql, params) as T[] };
        },
        async run() {
          return run(sql, params);
        },
      };
      return statement;
    },
    async batch(statements: { sql: string; run: () => Promise<unknown> }[]) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  return db as unknown as D1Database;
}

function makeEnv(options: {
  state?: Partial<State>;
  bucket?: ReturnType<typeof fakeBucket>;
} = {}) {
  const state: State = {
    projects: [initialProject()],
    chapters: [initialChapter()],
    snapshots: [],
    shares: [],
    comments: [],
    dailyWords: new Map(),
    ...options.state,
  };
  const bucket = options.bucket ?? fakeBucket();
  const env = {
    DB: fakeDatabase(state),
    BUCKET: bucket,
    BACKUPS: bucket,
    ASSETS: { fetch: async () => new Response() },
    ACCESS_TEAM_DOMAIN: "",
    ACCESS_AUD: "",
    DEV_BYPASS: "true",
  } as unknown as Env;
  return { env, state, bucket };
}

function request(method: string, path: string, body?: unknown) {
  return new Request(`https://lantern.test${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function tokenHash(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("Worker project and chapter routes", () => {
  it("creates a project with an initial chapter and supports reading and updating them", async () => {
    const { env, state, bucket } = makeEnv({ state: { projects: [], chapters: [] } });
    const create = await worker.fetch(request("POST", "/api/projects", { title: "  New novel  " }), env);
    const project = await create.json() as { id: string; title: string };

    expect(create.status).toBe(201);
    expect(project.title).toBe("New novel");
    expect(state.chapters).toHaveLength(1);
    expect(state.chapters[0]).toMatchObject({ project_id: project.id, title: "Chapter 1", position: 0 });
    expect([...bucket.contents.keys()]).toContain(`projects/${project.id}/chapters/${state.chapters[0].id}.md`);

    const read = await worker.fetch(request("GET", `/api/projects/${project.id}`), env);
    expect(await read.json()).toMatchObject({
      project: { id: project.id, title: "New novel" },
      chapters: [{ id: state.chapters[0].id, title: "Chapter 1" }],
    });

    const updateProject = await worker.fetch(
      request("PATCH", `/api/projects/${project.id}`, { title: "Revised title" }),
      env,
    );
    expect(updateProject.status).toBe(200);
    expect(state.projects[0].title).toBe("Revised title");

    const updateChapter = await worker.fetch(
      request("PATCH", `/api/chapters/${state.chapters[0].id}`, { title: "Opening", synopsis: "A new start." }),
      env,
    );
    expect(updateChapter.status).toBe(200);
    expect(state.chapters[0]).toMatchObject({ title: "Opening", synopsis: "A new start." });

    const deleteProject = await worker.fetch(request("DELETE", `/api/projects/${project.id}`), env);
    expect(deleteProject.status).toBe(200);
    expect(state.projects[0].deleted_at).not.toBeNull();

    const restoreProject = await worker.fetch(request("POST", `/api/projects/${project.id}/restore`), env);
    expect(restoreProject.status).toBe(200);
    expect(await restoreProject.json()).toMatchObject({
      id: project.id,
      title: "Revised title",
      chapter_count: 1,
    });
    expect(state.projects[0].deleted_at).toBeNull();
  });

  it("restores a soft-deleted chapter at the end of its project", async () => {
    const chapter = initialChapter({ id: "chapter-to-restore", position: 1 });
    const { env, state } = makeEnv({
      state: {
        chapters: [initialChapter({ id: "active", position: 0 }), chapter],
      },
    });

    const deleted = await worker.fetch(request("DELETE", `/api/chapters/${chapter.id}`), env);
    expect(deleted.status).toBe(200);
    expect(state.chapters[1].deleted_at).not.toBeNull();

    const response = await worker.fetch(request("POST", `/api/chapters/${chapter.id}/restore`), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: chapter.id, project_id: "project-1", position: 1 });
    expect(state.chapters[1].deleted_at).toBeNull();
  });
});

describe("Worker chapter save history", () => {
  it("rejects a stale save without changing chapter text", async () => {
    const bucket = fakeBucket({ "projects/project-1/chapters/chapter-1.md": "The saved text." });
    const { env } = makeEnv({ bucket, state: { chapters: [initialChapter({ version: 3 })] } });

    const response = await worker.fetch(
      request("PUT", "/api/chapters/chapter-1", { content: "A stale draft.", baseVersion: 2 }),
      env,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "conflict", version: 3 });
    expect(bucket.contents.get("projects/project-1/chapters/chapter-1.md")).toBe("The saved text.");
  });

  it("preserves prior text and exposes snapshots across saves and a restore", async () => {
    const chapterKey = "projects/project-1/chapters/chapter-1.md";
    const bucket = fakeBucket({ [chapterKey]: "The original saved words." });
    const { env, state } = makeEnv({ bucket });

    const firstSave = await worker.fetch(
      request("PUT", "/api/chapters/chapter-1", { content: "The newer draft.", baseVersion: 0, day: "2026-03-04" }),
      env,
    );
    expect(firstSave.status).toBe(200);
    expect(state.snapshots).toHaveLength(1);
    expect(state.snapshots[0]).toMatchObject({ version: 0, reason: "auto", word_count: 4 });
    const originalSnapshotId = state.snapshots[0].id;

    const restoreSave = await worker.fetch(
      request("PUT", "/api/chapters/chapter-1", {
        content: "Restored text.",
        baseVersion: 1,
        snapshot: "restore",
        day: "2026-03-04",
      }),
      env,
    );
    expect(restoreSave.status).toBe(200);
    expect(bucket.contents.get(chapterKey)).toBe("Restored text.");
    expect(state.snapshots).toHaveLength(2);
    expect(state.snapshots[1]).toMatchObject({ version: 1, reason: "restore", word_count: 3 });
    expect(state.dailyWords.get("2026-03-04:project-1")).toBe(-1);

    const history = await worker.fetch(request("GET", "/api/chapters/chapter-1/history"), env);
    expect(await history.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: originalSnapshotId, version: 0, reason: "auto" }),
      expect.objectContaining({ id: state.snapshots[1].id, version: 1, reason: "restore" }),
    ]));

    const snapshot = await worker.fetch(
      request("GET", `/api/chapters/chapter-1/history/${originalSnapshotId}`),
      env,
    );
    expect(await snapshot.json()).toMatchObject({ content: "The original saved words.", version: 0 });
  });
});

describe("Worker share-comment routes", () => {
  it("accepts comments only for active shares and chapters in the shared project", async () => {
    const token = "a".repeat(64);
    const share: Share = {
      id: "share-1",
      project_id: "project-1",
      owner_email: "dev@localhost",
      token_hash: await tokenHash(token),
      revoked_at: null,
    };
    const revokedToken = "b".repeat(64);
    const revokedShare: Share = {
      ...share,
      id: "share-revoked",
      token_hash: await tokenHash(revokedToken),
      revoked_at: "2026-01-02T00:00:00.000Z",
    };
    const otherProjectChapter = initialChapter({
      id: "another-project-chapter",
      project_id: "another-project",
    });
    const { env, state } = makeEnv({ state: { shares: [share, revokedShare], chapters: [initialChapter(), otherProjectChapter] } });

    const created = await worker.fetch(
      request("POST", `/api/share/${token}/comments`, {
        chapterId: "chapter-1",
        displayName: "  Reader  ",
        body: "  A useful note.  ",
      }),
      env,
    );
    expect(created.status).toBe(201);
    expect(state.comments[0]).toMatchObject({
      share_id: "share-1",
      chapter_id: "chapter-1",
      display_name: "Reader",
      body: "A useful note.",
    });

    const wrongChapter = await worker.fetch(
      request("POST", `/api/share/${token}/comments`, { chapterId: "another-project-chapter", body: "Not allowed." }),
      env,
    );
    expect(wrongChapter.status).toBe(404);

    const revoked = await worker.fetch(
      request("POST", `/api/share/${revokedToken}/comments`, { chapterId: "chapter-1", body: "Not allowed." }),
      env,
    );
    expect(revoked.status).toBe(404);
    expect(state.comments).toHaveLength(1);
  });

});
