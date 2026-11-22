-- Scenes exist on their own; a chapter is optional. A scene with no chapter
-- is "unassigned" and can be placed in a chapter later. SQLite can't drop
-- NOT NULL in place, so the table is rebuilt with the same rows.

PRAGMA defer_foreign_keys = true;

CREATE TABLE scenes_new (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  chapter_id  TEXT REFERENCES chapters(id),
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  pov         TEXT NOT NULL DEFAULT '',
  location    TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'planned',
  position    INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

INSERT INTO scenes_new (id, project_id, chapter_id, title, summary, pov, location, status, position, created_at, updated_at)
  SELECT id, project_id, chapter_id, title, summary, pov, location, status, position, created_at, updated_at FROM scenes;

DROP TABLE scenes;
ALTER TABLE scenes_new RENAME TO scenes;

CREATE INDEX idx_scenes_chapter ON scenes(chapter_id, position);
CREATE INDEX idx_scenes_project ON scenes(project_id, position);
