-- How many CEFR levels either side of the target level the practice screen shows.
ALTER TABLE settings ADD COLUMN level_range INTEGER NOT NULL DEFAULT 1;
