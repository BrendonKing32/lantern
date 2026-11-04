-- Lantern: goals and streaks.

-- Net words written per novel per day. `day` is the writer's local date
-- (YYYY-MM-DD), sent by the app with each save.
CREATE TABLE daily_words (
  day         TEXT NOT NULL,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  words       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, project_id)
);

-- Writer-wide settings, such as the daily word goal.
CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- A novel's target length and optional deadline.
ALTER TABLE projects ADD COLUMN target_words INTEGER;
ALTER TABLE projects ADD COLUMN target_date TEXT;
