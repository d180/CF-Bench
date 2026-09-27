-- Which agent produced an agent run. NULL for human runs and for agent runs
-- recorded before this column existed.
ALTER TABLE runs ADD COLUMN agent_kind TEXT;
