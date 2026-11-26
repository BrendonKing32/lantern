-- Keep MCP chapter creation retries attached to their original chapter.
CREATE TABLE mcp_chapter_creations (
  project_id TEXT NOT NULL REFERENCES projects(id),
  operation_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  chapter_id TEXT NOT NULL REFERENCES chapters(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
  result_json TEXT,
  lease_until TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, operation_id),
  CHECK ((status = 'pending' AND result_json IS NULL) OR (status = 'complete' AND result_json IS NOT NULL))
);
