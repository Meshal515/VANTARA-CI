-- B4 ownership freeze: D1 is the sole owner of social/profile/presence state.
--
-- These PostgreSQL tables were the retired first implementation. Keeping them
-- after the HTTP routes moved to D1 creates a second source of truth and makes
-- backup/restore semantics ambiguous. Operational PostgreSQL tables
-- (sessions, identity links, reports, source verdicts, policy, audit) remain.
--
-- All live API reads/writes to these tables are removed before this migration.

DROP TABLE IF EXISTS vantara_comment_reactions;
DROP TABLE IF EXISTS vantara_comments;
DROP TABLE IF EXISTS vantara_recommendations;
DROP TABLE IF EXISTS vantara_activity_events;
DROP TABLE IF EXISTS vantara_reading_sessions;
DROP TABLE IF EXISTS vantara_presence;
DROP TABLE IF EXISTS vantara_profiles;
DROP TABLE IF EXISTS vantara_user_gates;
