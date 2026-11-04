-- Lantern: story bible. Characters, places, things and notes for a novel,
-- linked from chapters with [[Name]].

CREATE TABLE bible_entries (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  kind        TEXT NOT NULL,            -- 'character', 'place', 'thing' or 'note'
  name        TEXT NOT NULL,
  aliases     TEXT NOT NULL DEFAULT '[]', -- JSON array of other names [[links]] may use
  body        TEXT NOT NULL DEFAULT '',   -- markdown notes
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

CREATE INDEX idx_bible_project ON bible_entries(project_id, kind, name);
