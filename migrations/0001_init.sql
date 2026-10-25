-- Lantern: projects and chapters metadata. Chapter text lives in R2.

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE chapters (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  title       TEXT NOT NULL,
  synopsis    TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL,
  word_count  INTEGER NOT NULL DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT            -- soft delete: text stays in R2 so nothing is lost
);

CREATE INDEX idx_chapters_project ON chapters(project_id, position);
