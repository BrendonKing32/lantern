-- Lantern: what Claude changed through the connector, one row per change,
-- listed in the app under More → Changes by Claude. Rows older than 180 days
-- are pruned as new ones are written.

CREATE TABLE claude_changes (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  created_at  TEXT NOT NULL,
  action      TEXT NOT NULL,   -- the connector tool, e.g. 'edit_chapter'
  target_kind TEXT NOT NULL,   -- 'chapter', 'entry' or 'scene'
  target_id   TEXT NOT NULL,
  chapter_id  TEXT,            -- the chapter a change belongs to, for chapters and scenes
  summary     TEXT NOT NULL,   -- e.g. Edited “Arrival”
  detail      TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_claude_changes_project ON claude_changes(project_id, created_at);
