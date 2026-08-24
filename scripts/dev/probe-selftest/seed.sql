-- Registry fixtures for the probe self-test.
--
-- Three models against one stub upstream, each isolating exactly one thing the
-- probe claims to do. Fixed UUIDs so the runner can name them without a lookup.
--
-- `auth.style: none` because the stub checks nothing: this exercise is about
-- the probe's verdict, not about the vault. Key resolution has its own coverage.
BEGIN;

INSERT INTO model.model_providers (id, provider_code, provider_name, config)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'stub',
  'Stub thinking upstream',
  '{"wire": {"schemaVersion": 2, "chatPath": "/chat/completions",
             "auth": {"style": "none"}, "streamUsage": "stream_options",
             "supports": {"tools": true, "toolChoice": true, "topP": true, "temperature": true}}}'::jsonb
)
ON CONFLICT (provider_code) DO NOTHING;

-- 1. No declared output ceiling -> the probe should send its 2048 default, and
--    both checks should FAIL: empty content, and a stream with no content frame.
INSERT INTO model.models (id, provider_id, model_code, model_name, protocol,
                          endpoint_url, supports_streaming, is_active, config)
VALUES (
  '22222222-2222-2222-2222-222222222222',
  '11111111-1111-1111-1111-111111111111',
  'stub-thinking', 'Stub thinking (no ceiling)', 'openai-chat-completions',
  'http://stub:8080', true, true,
  '{"upstreamModel": "stub-v4-flash"}'::jsonb
)
ON CONFLICT (model_code) DO NOTHING;

-- 2. Declares a 512 ceiling -> the probe must not exceed the model's own limit.
--    Sending more than an upstream allows is a 400, i.e. a fake onboarding
--    failure on a model that works.
INSERT INTO model.models (id, provider_id, model_code, model_name, protocol,
                          endpoint_url, max_output_tokens, supports_streaming,
                          is_active, config)
VALUES (
  '33333333-3333-3333-3333-333333333333',
  '11111111-1111-1111-1111-111111111111',
  'stub-thinking-capped', 'Stub thinking (512 ceiling)', 'openai-chat-completions',
  'http://stub:8080', 512, true, true,
  '{"upstreamModel": "stub-v4-flash"}'::jsonb
)
ON CONFLICT (model_code) DO NOTHING;

-- 3. Turns thinking off through wire.extraBody -> both checks should PASS.
INSERT INTO model.models (id, provider_id, model_code, model_name, protocol,
                          endpoint_url, supports_streaming, is_active, config)
VALUES (
  '44444444-4444-4444-4444-444444444444',
  '11111111-1111-1111-1111-111111111111',
  'stub-no-thinking', 'Stub with thinking disabled', 'openai-chat-completions',
  'http://stub:8080', true, true,
  '{"upstreamModel": "stub-v4-flash",
    "wire": {"extraBody": {"thinking": {"type": "disabled"}, "reasoning_effort": "low"}}}'::jsonb
)
ON CONFLICT (model_code) DO NOTHING;

COMMIT;
