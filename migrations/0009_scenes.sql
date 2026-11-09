-- Scene planning cards belong to a chapter and are separate from manuscript text.

CREATE TABLE scenes (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  chapter_id  TEXT NOT NULL REFERENCES chapters(id),
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  pov         TEXT NOT NULL DEFAULT '',
  location    TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'planned',
  position    INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_scenes_chapter ON scenes(chapter_id, position);
