-- Up Migration
-- Chain head observed when the intent was created. A transfer mined at or before
-- this block cannot be the payment the intent asked for (it is a replay of an
-- older transfer). NULL for intents created before this column existed.
ALTER TABLE payment_intents
  ADD COLUMN min_block_number NUMERIC(78,0),
  ADD CONSTRAINT payment_intents_min_block_nonneg CHECK (min_block_number IS NULL OR min_block_number >= 0);

-- Down Migration
ALTER TABLE payment_intents
  DROP CONSTRAINT payment_intents_min_block_nonneg,
  DROP COLUMN min_block_number;
