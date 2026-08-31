-- Reusable schema for the data databases (fintechP and fintechT).
-- Applied to BOTH via \i from 02-schema.sql so the two stay identical.
-- Everything lives in the `bank` schema — NOT public.

CREATE SCHEMA IF NOT EXISTS bank;

-- Enumerated types (proper constrained values instead of free text).
CREATE TYPE bank.account_type   AS ENUM ('checking', 'savings', 'credit');
CREATE TYPE bank.card_brand      AS ENUM ('visa', 'mastercard', 'amex');
CREATE TYPE bank.txn_direction   AS ENUM ('debit', 'credit');
CREATE TYPE bank.entity_status   AS ENUM ('active', 'frozen', 'closed');

-- People. Holds the most sensitive PII (ssn, dob, contact details).
CREATE TABLE bank.customers (
    id            BIGINT       PRIMARY KEY,
    first_name    TEXT         NOT NULL,
    last_name     TEXT         NOT NULL,
    email         TEXT         NOT NULL,
    phone         TEXT         NOT NULL,
    ssn           TEXT         NOT NULL,
    date_of_birth DATE         NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- One or more postal addresses per customer.
CREATE TABLE bank.addresses (
    id           BIGINT  PRIMARY KEY,
    customer_id  BIGINT  NOT NULL REFERENCES bank.customers (id) ON DELETE CASCADE,
    line1        TEXT    NOT NULL,
    line2        TEXT,
    city         TEXT    NOT NULL,
    state        TEXT    NOT NULL,
    postal_code  TEXT    NOT NULL,
    country      TEXT    NOT NULL DEFAULT 'US'
);
CREATE INDEX addresses_customer_idx ON bank.addresses (customer_id);

-- Bank accounts owned by a customer.
-- account_number is intentionally NOT unique: masked copies in the test DB can
-- share a last-4 suffix, and we still want them to insert cleanly.
CREATE TABLE bank.accounts (
    id              BIGINT             PRIMARY KEY,
    customer_id     BIGINT             NOT NULL REFERENCES bank.customers (id) ON DELETE CASCADE,
    account_number  TEXT               NOT NULL,
    routing_number  TEXT               NOT NULL,
    account_type    bank.account_type  NOT NULL,
    balance         NUMERIC(14,2)      NOT NULL DEFAULT 0,
    currency        CHAR(3)            NOT NULL DEFAULT 'USD',
    status          bank.entity_status NOT NULL DEFAULT 'active',
    opened_at       TIMESTAMPTZ        NOT NULL
);
CREATE INDEX accounts_customer_idx ON bank.accounts (customer_id);

-- Payment cards attached to an account.
CREATE TABLE bank.cards (
    id               BIGINT             PRIMARY KEY,
    account_id       BIGINT             NOT NULL REFERENCES bank.accounts (id) ON DELETE CASCADE,
    card_number      TEXT               NOT NULL,
    cardholder_name  TEXT               NOT NULL,
    brand            bank.card_brand    NOT NULL,
    expiry_month     SMALLINT           NOT NULL CHECK (expiry_month BETWEEN 1 AND 12),
    expiry_year      SMALLINT           NOT NULL,
    cvv              TEXT               NOT NULL,
    status           bank.entity_status NOT NULL DEFAULT 'active'
);
CREATE INDEX cards_account_idx ON bank.cards (account_id);

-- Transaction history per account (behavioral data; no direct PII).
CREATE TABLE bank.transactions (
    id           BIGINT             PRIMARY KEY,
    account_id   BIGINT             NOT NULL REFERENCES bank.accounts (id) ON DELETE CASCADE,
    occurred_at  TIMESTAMPTZ        NOT NULL,
    amount       NUMERIC(12,2)      NOT NULL,
    direction    bank.txn_direction NOT NULL,
    merchant     TEXT               NOT NULL,
    category     TEXT               NOT NULL,
    description  TEXT
);
CREATE INDEX transactions_account_idx ON bank.transactions (account_id);
CREATE INDEX transactions_time_idx    ON bank.transactions (occurred_at);
