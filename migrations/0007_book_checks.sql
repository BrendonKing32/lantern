-- Lantern: saved whole-book continuity checks. They cost more than a chapter
-- check, so results are kept on the server for every device.

CREATE TABLE book_checks (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  result      TEXT NOT NULL,   -- JSON BookCheckResult
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_book_checks_project ON book_checks(project_id, created_at);
