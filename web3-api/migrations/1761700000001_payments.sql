-- Up Migration

-- All token amounts are integer base units (uint256 fits in NUMERIC(78,0)).
-- Application code must use BigInt and never floating point for these values.
CREATE TABLE payment_intents (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_did               text          NOT NULL,
  recipient_did            text          NOT NULL,
  chain_id                 bigint        NOT NULL,
  token_address            text          NOT NULL,
  -- Snapshot of the verified wallets at intent time, so later wallet changes
  -- cannot change what a past payment is verified against.
  sender_wallet_address    text          NOT NULL,
  recipient_wallet_address text          NOT NULL,
  amount                   numeric(78,0) NOT NULL,
  status                   text          NOT NULL DEFAULT 'created',
  expires_at               timestamptz   NOT NULL,
  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT payment_intents_sender_did_format CHECK (sender_did ~ '^did:[a-z]+:[a-zA-Z0-9._:%-]+$' AND char_length(sender_did) <= 2048),
  CONSTRAINT payment_intents_recipient_did_format CHECK (recipient_did ~ '^did:[a-z]+:[a-zA-Z0-9._:%-]+$' AND char_length(recipient_did) <= 2048),
  CONSTRAINT payment_intents_no_self_payment CHECK (sender_did <> recipient_did),
  CONSTRAINT payment_intents_chain_positive CHECK (chain_id > 0),
  CONSTRAINT payment_intents_token_format CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT payment_intents_sender_wallet_format CHECK (sender_wallet_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT payment_intents_recipient_wallet_format CHECK (recipient_wallet_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT payment_intents_amount_positive CHECK (amount > 0),
  CONSTRAINT payment_intents_status_valid CHECK (
    status IN ('created', 'awaiting_confirmation', 'confirmed', 'failed', 'expired', 'reorged')
  )
);

CREATE INDEX payment_intents_sender_idx ON payment_intents (sender_did, created_at DESC);
CREATE INDEX payment_intents_recipient_idx ON payment_intents (recipient_did, created_at DESC);
CREATE INDEX payment_intents_open_idx ON payment_intents (status, expires_at)
  WHERE status IN ('created', 'awaiting_confirmation');

-- Observed on-chain transactions. block_hash is kept so a later change of the
-- hash at the same height can be detected as a reorganisation.
CREATE TABLE chain_transactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id          bigint      NOT NULL,
  tx_hash           text        NOT NULL,
  payment_intent_id uuid        REFERENCES payment_intents (id) ON DELETE RESTRICT,
  status            text        NOT NULL DEFAULT 'pending',
  block_number      bigint,
  block_hash        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chain_transactions_chain_positive CHECK (chain_id > 0),
  CONSTRAINT chain_transactions_hash_format CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT chain_transactions_block_hash_format CHECK (block_hash IS NULL OR block_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT chain_transactions_block_number_nonneg CHECK (block_number IS NULL OR block_number >= 0),
  CONSTRAINT chain_transactions_status_valid CHECK (
    status IN ('pending', 'confirmed', 'failed', 'reorged')
  ),
  -- Duplicate-event protection: one row per transaction, and therefore a
  -- transaction can never be credited to two payment intents.
  CONSTRAINT chain_transactions_chain_hash_unique UNIQUE (chain_id, tx_hash)
);

CREATE INDEX chain_transactions_intent_idx ON chain_transactions (payment_intent_id);
CREATE INDEX chain_transactions_pending_idx ON chain_transactions (chain_id, status)
  WHERE status = 'pending';
-- An intent can be settled by at most one confirmed transaction.
CREATE UNIQUE INDEX chain_transactions_one_confirmed_per_intent_idx
  ON chain_transactions (payment_intent_id)
  WHERE status = 'confirmed' AND payment_intent_id IS NOT NULL;

-- Down Migration

DROP TABLE chain_transactions;
DROP TABLE payment_intents;
