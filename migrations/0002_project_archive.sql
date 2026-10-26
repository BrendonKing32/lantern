-- Lantern: archive and delete novels. Both are soft: chapter text stays in R2.

ALTER TABLE projects ADD COLUMN archived_at TEXT;
ALTER TABLE projects ADD COLUMN deleted_at TEXT;
