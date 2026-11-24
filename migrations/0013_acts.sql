-- Acts (or parts, or any bucket the author likes) group chapters. A chapter
-- belongs to at most one act; chapters with no act come before the first act.
-- Book order stays in chapters.position, kept so each act's chapters sit
-- together in act order.

CREATE TABLE acts (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  title       TEXT NOT NULL,
  position    INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_acts_project ON acts(project_id, position);

ALTER TABLE chapters ADD COLUMN act_id TEXT REFERENCES acts(id);
