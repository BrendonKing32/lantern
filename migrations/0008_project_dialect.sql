-- Lantern: the English each novel is written in, for grammar and spelling checks.

ALTER TABLE projects ADD COLUMN dialect TEXT NOT NULL DEFAULT 'american';
