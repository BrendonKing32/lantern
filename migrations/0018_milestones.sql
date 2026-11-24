-- Keep named copies of a novel's chapters for later comparison.
CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  word_count INTEGER NOT NULL DEFAULT 0,
  chapter_count INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_milestones_project ON milestones(project_id, created_at);

CREATE TABLE milestone_chapters (
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  chapter_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  act_title TEXT,
  version INTEGER NOT NULL,
  word_count INTEGER NOT NULL,
  PRIMARY KEY (milestone_id, chapter_id)
);
