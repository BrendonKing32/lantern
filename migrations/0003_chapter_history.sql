-- Lantern: version history. Each row is a point-in-time copy of a chapter;
-- the text itself lives in R2 next to the chapter, under history/.

CREATE TABLE chapter_snapshots (
  id          TEXT PRIMARY KEY,
  chapter_id  TEXT NOT NULL REFERENCES chapters(id),
  version     INTEGER NOT NULL,   -- the chapter version this text was saved as
  word_count  INTEGER NOT NULL,
  reason      TEXT NOT NULL,      -- 'auto', 'restore', or 'conflict'
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_snapshots_chapter ON chapter_snapshots(chapter_id, created_at);
