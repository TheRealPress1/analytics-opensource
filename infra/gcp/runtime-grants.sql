-- Run after the first migration as its owner or an existing database admin.
-- Runtime identities cannot create/alter application tables or change grants.
\set ON_ERROR_STOP on
BEGIN;
GRANT SELECT ON apps, events, rate_limits, worker_heartbeats, deleted_subjects TO :"api_user";
GRANT INSERT ON events, rate_limits, deleted_subjects TO :"api_user";
GRANT UPDATE ON rate_limits TO :"api_user";
GRANT DELETE ON events TO :"api_user";
GRANT SELECT, DELETE ON rate_limits TO :"worker_user";
GRANT SELECT, INSERT, UPDATE ON worker_heartbeats TO :"worker_user";
-- The worker owns only the pgboss schema for queue migrations, locking and jobs.
-- Apply deliberate grants for each future application-table migration.
COMMIT;
