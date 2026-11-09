-- Run once on the dedicated analytics database as its existing database owner.
-- Pass psql -v db_name=analytics -v api_user=... -v worker_user=... -v migrate_user=...
-- IAM usernames are SA emails without the .gserviceaccount.com suffix.
\set ON_ERROR_STOP on
BEGIN;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db_name" TO :"api_user", :"worker_user", :"migrate_user";
GRANT USAGE ON SCHEMA public TO :"api_user", :"worker_user", :"migrate_user";
GRANT CREATE ON SCHEMA public TO :"migrate_user";
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION :"worker_user";
COMMIT;
