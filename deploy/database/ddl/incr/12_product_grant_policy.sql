
-- Continuous product grants: current policy and append-only revision history.
CREATE TABLE IF NOT EXISTS model.product_grant_policy (
  product_code varchar(64) PRIMARY KEY CHECK (product_code ~ '^[a-z][a-z0-9_-]{1,63}$'),
  revision integer NOT NULL CHECK (revision > 0),
  rules jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'array'),
  updated_by varchar(128) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS model.product_grant_policy_revision (
  product_code varchar(64) NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  rules jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'array'),
  updated_by varchar(128) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_code, revision)
);

GRANT SELECT, INSERT ON model.product_grant_policy, model.product_grant_policy_revision TO atlas_svc;
REVOKE UPDATE, DELETE ON model.product_grant_policy, model.product_grant_policy_revision FROM atlas_svc;
GRANT UPDATE (revision, rules, updated_by, updated_at) ON model.product_grant_policy TO atlas_svc;

ALTER TABLE model.model_endpoints ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
GRANT UPDATE (tags) ON model.model_endpoints TO atlas_svc;
