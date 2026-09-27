-- What produced an attempt, so two agent runs are distinguishable.
-- NULL for human attempts.
ALTER TABLE runs ADD COLUMN model TEXT;
-- How much work it took. Comparable across agents, unlike Coasty's billing
-- columns, which only apply to one of them.
ALTER TABLE runs ADD COLUMN steps INTEGER;
ALTER TABLE runs ADD COLUMN duration_seconds REAL;
