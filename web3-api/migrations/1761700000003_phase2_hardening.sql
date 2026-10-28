-- Up Migration

-- ---------------------------------------------------------------------------
-- Wallet unlinking: soft revoke. History is kept for audit and for the
-- relink cool-down; only ACTIVE rows are unique per (chain, address).
-- ---------------------------------------------------------------------------
ALTER TABLE user_wallets ADD COLUMN revoked_at timestamptz;
ALTER TABLE user_wallets ADD CONSTRAINT user_wallets_revoked_after_verified
  CHECK (revoked_at IS NULL OR revoked_at >= verified_at);
ALTER TABLE user_wallets DROP CONSTRAINT user_wallets_chain_address_unique;
CREATE UNIQUE INDEX user_wallets_active_chain_address_idx
  ON user_wallets (chain_id, wallet_address) WHERE revoked_at IS NULL;
DROP INDEX user_wallets_did_idx;
CREATE INDEX user_wallets_did_active_idx ON user_wallets (did, chain_id) WHERE revoked_at IS NULL;
CREATE INDEX user_wallets_released_idx ON user_wallets (chain_id, wallet_address, revoked_at)
  WHERE revoked_at IS NOT NULL;

-- Per-DID challenge quota lookups (rows per hour).
CREATE INDEX wallet_challenges_did_created_idx ON wallet_challenges (did, created_at DESC);

-- ---------------------------------------------------------------------------
-- Audit events. No IP addresses, tokens or signatures are ever stored here.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor_did    text,
  action       text        NOT NULL,
  subject_type text,
  subject_id   text,
  outcome      text        NOT NULL,
  reason       text,
  request_id   text,
  metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT audit_events_action_format CHECK (action ~ '^[a-z][a-z0-9_.]{1,63}$'),
  CONSTRAINT audit_events_outcome_valid CHECK (outcome IN ('success', 'denied', 'failure')),
  CONSTRAINT audit_events_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT audit_events_metadata_size CHECK (pg_column_size(metadata) <= 4096)
);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_did, occurred_at DESC);
CREATE INDEX audit_events_action_idx ON audit_events (action, occurred_at DESC);
CREATE INDEX audit_events_occurred_idx ON audit_events (occurred_at);

-- ---------------------------------------------------------------------------
-- Idempotency for payment operations. One row per (caller, operation, key).
-- request_hash detects a key reused with a different body.
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  did             text        NOT NULL,
  operation       text        NOT NULL,
  idempotency_key text        NOT NULL,
  request_hash    text        NOT NULL,
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (did, operation, idempotency_key),
  CONSTRAINT idempotency_keys_key_format CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  CONSTRAINT idempotency_keys_hash_format CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT idempotency_keys_response_consistent CHECK ((response_status IS NULL) = (response_body IS NULL))
);
CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------
-- Payment intents: optional post context and reconciliation bookkeeping.
-- ---------------------------------------------------------------------------
ALTER TABLE payment_intents
  ADD COLUMN post_uri        text,
  ADD COLUMN next_check_at   timestamptz,
  ADD COLUMN check_attempts  integer     NOT NULL DEFAULT 0,
  ADD COLUMN last_error      text,
  ADD COLUMN last_checked_at timestamptz,
  ADD COLUMN finalized_at    timestamptz;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_post_uri_format
  CHECK (post_uri IS NULL OR (post_uri ~ '^at://[^[:space:]]+$' AND char_length(post_uri) <= 512));
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_attempts_nonneg
  CHECK (check_attempts >= 0);
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_last_error_length
  CHECK (last_error IS NULL OR char_length(last_error) <= 64);
-- Work queue for the reconciler.
DROP INDEX payment_intents_open_idx;
CREATE INDEX payment_intents_due_idx ON payment_intents (next_check_at)
  WHERE status IN ('awaiting_confirmation', 'reorged', 'confirmed') AND finalized_at IS NULL;
CREATE INDEX payment_intents_expiry_idx ON payment_intents (expires_at) WHERE status = 'created';
-- Pending-payment lookups per wallet (blocks unlink while money is in flight).
CREATE INDEX payment_intents_sender_wallet_idx ON payment_intents (chain_id, sender_wallet_address)
  WHERE status IN ('created', 'awaiting_confirmation', 'reorged');
CREATE INDEX payment_intents_recipient_wallet_idx ON payment_intents (chain_id, recipient_wallet_address)
  WHERE status IN ('created', 'awaiting_confirmation', 'reorged');
CREATE INDEX payment_intents_creator_created_idx ON payment_intents (sender_did, created_at DESC);

ALTER TABLE chain_transactions
  ADD COLUMN confirmed_at     timestamptz,
  ADD COLUMN last_checked_at  timestamptz,
  ADD COLUMN confirmations    bigint;
ALTER TABLE chain_transactions ADD CONSTRAINT chain_transactions_confirmations_nonneg
  CHECK (confirmations IS NULL OR confirmations >= 0);
-- A transaction hash can be attached to an intent at most once (already unique
-- per chain); an intent has at most one attached transaction.
CREATE UNIQUE INDEX chain_transactions_one_per_intent_idx
  ON chain_transactions (payment_intent_id) WHERE payment_intent_id IS NOT NULL;
DROP INDEX chain_transactions_one_confirmed_per_intent_idx;

-- Down Migration

CREATE UNIQUE INDEX chain_transactions_one_confirmed_per_intent_idx
  ON chain_transactions (payment_intent_id)
  WHERE status = 'confirmed' AND payment_intent_id IS NOT NULL;
DROP INDEX chain_transactions_one_per_intent_idx;
ALTER TABLE chain_transactions DROP COLUMN confirmations, DROP COLUMN last_checked_at, DROP COLUMN confirmed_at;

DROP INDEX payment_intents_creator_created_idx;
DROP INDEX payment_intents_recipient_wallet_idx;
DROP INDEX payment_intents_sender_wallet_idx;
DROP INDEX payment_intents_expiry_idx;
DROP INDEX payment_intents_due_idx;
CREATE INDEX payment_intents_open_idx ON payment_intents (status, expires_at)
  WHERE status IN ('created', 'awaiting_confirmation');
ALTER TABLE payment_intents DROP CONSTRAINT payment_intents_last_error_length;
ALTER TABLE payment_intents DROP CONSTRAINT payment_intents_attempts_nonneg;
ALTER TABLE payment_intents DROP CONSTRAINT payment_intents_post_uri_format;
ALTER TABLE payment_intents
  DROP COLUMN finalized_at, DROP COLUMN last_checked_at, DROP COLUMN last_error,
  DROP COLUMN check_attempts, DROP COLUMN next_check_at, DROP COLUMN post_uri;

DROP TABLE idempotency_keys;
DROP TABLE audit_events;
DROP INDEX wallet_challenges_did_created_idx;

DROP INDEX user_wallets_released_idx;
DROP INDEX user_wallets_did_active_idx;
CREATE INDEX user_wallets_did_idx ON user_wallets (did);
DROP INDEX user_wallets_active_chain_address_idx;
-- Reverting requires no duplicate (chain, address) rows; drop revoked history first.
DELETE FROM user_wallets WHERE revoked_at IS NOT NULL;
ALTER TABLE user_wallets ADD CONSTRAINT user_wallets_chain_address_unique UNIQUE (chain_id, wallet_address);
ALTER TABLE user_wallets DROP CONSTRAINT user_wallets_revoked_after_verified;
ALTER TABLE user_wallets DROP COLUMN revoked_at;
