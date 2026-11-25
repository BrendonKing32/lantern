-- Coordinate chapter writes while moving a scene between chapters.
ALTER TABLE chapters ADD COLUMN moving_until TEXT;
