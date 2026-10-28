-- Up Migration

-- Time-limited creator access passes. No automatic renewal.
CREATE TABLE creator_plans (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_did             text          NOT NULL,
  name                    text          NOT NULL,
  chain_id                bigint        NOT NULL,
  token_address           text          NOT NULL,
  -- Integer base units of the token, see payment_intents.amount.
  price_amount            numeric(78,0) NOT NULL,
  currency                text          NOT NULL,
  access_duration_seconds integer       NOT NULL,
  status                  text          NOT NULL DEFAULT 'draft',
  created_at              timestamptz   NOT NULL DEFAULT now(),
  updated_at              timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT creator_plans_did_format CHECK (creator_did ~ '^did:[a-z]+:[a-zA-Z0-9._:%-]+$' AND char_length(creator_did) <= 2048),
  CONSTRAINT creator_plans_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT creator_plans_chain_positive CHECK (chain_id > 0),
  CONSTRAINT creator_plans_token_format CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT creator_plans_price_positive CHECK (price_amount > 0),
  CONSTRAINT creator_plans_currency_format CHECK (currency ~ '^[A-Z0-9]{2,10}$'),
  -- 1 hour to 366 days.
  CONSTRAINT creator_plans_duration_range CHECK (access_duration_seconds BETWEEN 3600 AND 31622400),
  CONSTRAINT creator_plans_status_valid CHECK (status IN ('draft', 'active', 'archived'))
);

CREATE INDEX creator_plans_creator_idx ON creator_plans (creator_did, status);

CREATE TABLE subscription_entitlements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_did    text        NOT NULL,
  creator_did       text        NOT NULL,
  plan_id           uuid        NOT NULL REFERENCES creator_plans (id) ON DELETE RESTRICT,
  -- The verified payment that granted this access. NULL only for manual grants.
  payment_intent_id uuid        REFERENCES payment_intents (id) ON DELETE RESTRICT,
  starts_at         timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  status            text        NOT NULL DEFAULT 'active',
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_entitlements_subscriber_did_format CHECK (subscriber_did ~ '^did:[a-z]+:[a-zA-Z0-9._:%-]+$' AND char_length(subscriber_did) <= 2048),
  CONSTRAINT subscription_entitlements_creator_did_format CHECK (creator_did ~ '^did:[a-z]+:[a-zA-Z0-9._:%-]+$' AND char_length(creator_did) <= 2048),
  CONSTRAINT subscription_entitlements_not_self CHECK (subscriber_did <> creator_did),
  CONSTRAINT subscription_entitlements_window CHECK (expires_at > starts_at),
  CONSTRAINT subscription_entitlements_status_valid CHECK (status IN ('active', 'expired', 'revoked')),
  CONSTRAINT subscription_entitlements_revoked_consistent CHECK (
    (status = 'revoked') = (revoked_at IS NOT NULL)
  ),
  -- A payment grants access at most once.
  CONSTRAINT subscription_entitlements_payment_unique UNIQUE (payment_intent_id)
);

CREATE INDEX subscription_entitlements_lookup_idx
  ON subscription_entitlements (subscriber_did, creator_did, status, expires_at);
CREATE INDEX subscription_entitlements_creator_idx ON subscription_entitlements (creator_did, status);

-- Down Migration

DROP TABLE subscription_entitlements;
DROP TABLE creator_plans;
