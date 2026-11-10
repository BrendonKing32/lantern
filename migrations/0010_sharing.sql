CREATE TABLE project_shares (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  owner_email TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);

CREATE UNIQUE INDEX idx_active_project_share
  ON project_shares(project_id) WHERE revoked_at IS NULL;

CREATE TABLE share_comments (
  id           TEXT PRIMARY KEY,
  share_id     TEXT NOT NULL REFERENCES project_shares(id),
  chapter_id   TEXT NOT NULL REFERENCES chapters(id),
  display_name TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_share_comments_share
  ON share_comments(share_id, created_at DESC);
