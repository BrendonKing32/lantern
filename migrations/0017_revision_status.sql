-- Track revision progress and the writer's revised words.
ALTER TABLE chapters ADD COLUMN revision_status TEXT NOT NULL DEFAULT 'drafting';
ALTER TABLE daily_words ADD COLUMN revised INTEGER NOT NULL DEFAULT 0;
