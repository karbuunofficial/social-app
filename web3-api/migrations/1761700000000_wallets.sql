-- Up Migration

-- Verified links between an AT Protocol DID and an EVM wallet.
-- Addresses are stored lowercase; checksum casing is a display concern.
CREATE TABLE user_wallets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  did            text        NOT NULL,
  chain_id       bigint      NOT NULL,
  wallet_address text        NOT NULL,
  verified_at    timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_wallets_did_format CHECK (did ~ '^did:[a-z]+:[a-zA-Z0-9._:%-]+$' AND char_length(did) <= 2048),
  CONSTRAINT user_wallets_chain_positive CHECK (chain_id > 0),
  CONSTRAINT user_wallets_address_format CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  -- A wallet can belong to exactly one DID per chain. Re-assigning it requires
  -- an explicit, separately authorised unlink (not implemented in Phase 1).
  CONSTRAINT user_wallets_chain_address_unique UNIQUE (chain_id, wallet_address)
);

CREATE INDEX user_wallets_did_idx ON user_wallets (did);

-- Short-lived, single-use SIWE challenges. The raw nonce is never stored, only
-- its SHA-256 hash; the full signed message text is kept so verification
-- compares against exactly what the user was shown.
CREATE TABLE wallet_challenges (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  did            text        NOT NULL,
  chain_id       bigint      NOT NULL,
  wallet_address text        NOT NULL,
  nonce_hash     text        NOT NULL,
  message        text        NOT NULL,
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_challenges_did_format CHECK (did ~ '^did:[a-z]+:[a-zA-Z0-9._:%-]+$' AND char_length(did) <= 2048),
  CONSTRAINT wallet_challenges_chain_positive CHECK (chain_id > 0),
  CONSTRAINT wallet_challenges_address_format CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT wallet_challenges_nonce_hash_format CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT wallet_challenges_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT wallet_challenges_nonce_hash_unique UNIQUE (nonce_hash)
);

-- At most one live (unconsumed) challenge per DID and wallet. Issuing a new one
-- consumes the previous one first.
CREATE UNIQUE INDEX wallet_challenges_one_live_idx
  ON wallet_challenges (did, wallet_address)
  WHERE consumed_at IS NULL;

CREATE INDEX wallet_challenges_expires_idx ON wallet_challenges (expires_at);

-- Down Migration

DROP TABLE wallet_challenges;
DROP TABLE user_wallets;
