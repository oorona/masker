-- Build the schema in all three databases. Runs as the second init script.
-- The data databases share an identical `bank` schema (loaded from bank-ddl.sql,
-- which is mounted at /sql/bank-ddl.sql but NOT auto-run). The bus gets its own
-- `mq` schema with the message table.

-- Production and test: identical bank schema, only the data differs.
\connect "fintechP"
\i /sql/bank-ddl.sql

\connect "fintechT"
\i /sql/bank-ddl.sql

-- Message bus: agent-to-agent mailbox lives in an `mq` schema (not public).
\connect bus

CREATE SCHEMA mq;

CREATE TABLE mq.messages (
    id           BIGSERIAL    PRIMARY KEY,
    sender       TEXT         NOT NULL,    -- 'test' | 'prod'
    recipient    TEXT         NOT NULL,    -- 'test' | 'prod'
    body         JSONB        NOT NULL,    -- request or masked response payload
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    consumed_at  TIMESTAMPTZ               -- NULL until a recipient picks it up
);

CREATE INDEX messages_inbox_idx ON mq.messages (recipient, consumed_at, id);
