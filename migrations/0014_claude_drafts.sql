-- Lantern: Claude's chapter edits wait in a draft beside the chapter until the author accepts them.
-- At most one draft per chapter; its text lives in R2 next to the chapter, as claude-draft.md.

CREATE TABLE claude_drafts (
  chapter_id   TEXT PRIMARY KEY REFERENCES chapters(id),
  project_id   TEXT NOT NULL REFERENCES projects(id),
  version      INTEGER NOT NULL,   -- the draft's own version; each edit by Claude adds one
  base_version INTEGER NOT NULL,   -- the chapter version the draft began from
  word_count   INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_claude_drafts_project ON claude_drafts(project_id);
