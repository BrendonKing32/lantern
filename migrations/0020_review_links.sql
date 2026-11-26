-- Let a novel have several labelled review links, optionally reading a milestone.
DROP INDEX idx_active_project_share;
ALTER TABLE project_shares ADD COLUMN label TEXT NOT NULL DEFAULT '';
ALTER TABLE project_shares ADD COLUMN milestone_id TEXT REFERENCES milestones(id);
ALTER TABLE project_shares ADD COLUMN track_progress INTEGER NOT NULL DEFAULT 1;
CREATE INDEX idx_project_shares_project ON project_shares(project_id, revoked_at);
