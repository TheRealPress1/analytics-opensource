CREATE TABLE IF NOT EXISTS apps (
 id uuid PRIMARY KEY, name text NOT NULL, slug text NOT NULL UNIQUE,
 secret_key_hash text NOT NULL UNIQUE, event_specs jsonb NOT NULL,
 allowed_origins jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS events (
 app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
 environment text NOT NULL CHECK (environment IN ('production','development')),
 id uuid NOT NULL, subject text NOT NULL, name text NOT NULL,
 session_id uuid NOT NULL, occurred_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(), properties jsonb NOT NULL,
 payload_hash text NOT NULL, PRIMARY KEY (app_id,environment,id)
);
CREATE INDEX IF NOT EXISTS events_app_time ON events(app_id,environment,occurred_at);
CREATE INDEX IF NOT EXISTS events_subject_time ON events(app_id,environment,subject,occurred_at);
CREATE TABLE IF NOT EXISTS rate_limits (key text PRIMARY KEY, window_start bigint NOT NULL, count integer NOT NULL);
CREATE TABLE IF NOT EXISTS worker_heartbeats (id text PRIMARY KEY, updated_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS deleted_subjects (app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE, subject text NOT NULL, deleted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(app_id,subject));
