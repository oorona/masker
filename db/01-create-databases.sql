-- Create the three PoC databases.
-- Names use the requested convention: <mock-data base> + P (prod) / + T (test).
-- The mixed-case names MUST stay double-quoted everywhere (Postgres folds
-- unquoted identifiers to lowercase), and connection URLs must use the exact case.
CREATE DATABASE "fintechP";   -- production: real-shape sensitive data
CREATE DATABASE "fintechT";   -- test: same schema, no live PII
CREATE DATABASE bus;          -- shared message bus between the two agents
