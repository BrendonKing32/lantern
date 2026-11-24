-- Scene cards can be tied to a passage of their chapter's text.
ALTER TABLE scenes ADD COLUMN in_text INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scenes ADD COLUMN anchor_head TEXT;
ALTER TABLE scenes ADD COLUMN anchor_tail TEXT;
ALTER TABLE scenes ADD COLUMN word_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scenes ADD COLUMN unlinked_at TEXT;
ALTER TABLE scenes ADD COLUMN unconfirmed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chapters ADD COLUMN scenes_version INTEGER NOT NULL DEFAULT -1;
