# masker — masking PII between two Pi agents

A proof-of-concept for the pattern: **mask sensitive data at the producer, before it
crosses the wire between two agents.** (Companion to the article *"Two Pi Agents and a
Customer Table: Masking PII Before It Crosses the Wire."*)

Two independent [Pi](https://pi.dev) agents talk over a shared mailbox:

- **prod** — sits on a production database (`fintechP`) holding a realistic relational
  bank dataset (customers, addresses, accounts, cards, transactions) full of sensitive PII
  (names, SSNs, dates of birth, credit cards, account/routing numbers). It serves data
  requests but **masks every row in code** before replying. There is no tool that returns
  raw rows, so the model on the prod side cannot leak PII even if asked.
- **test** — owns a test database (`fintechT`) with the **same schema but no live data**.
  It asks prod for rows of any entity and loads the **masked** results it gets back.

All data lives in a dedicated **`bank` schema** (not `public`); the message bus uses an
**`mq` schema**.

```
              ┌──────────────── one Postgres container (masker-db) ───────────────┐
              │  "fintechP" (raw PII)   "fintechT" (masked only)   bus (messages)  │
              └──────▲──────────────────────▲────────────────────────▲────────────┘
   query+mask ───────┘            insert ────┘             send/read ─┘
        ┌─────────────────┐                       ┌─────────────────┐
        │  PROD agent      │   ── mailbox ──▶      │  TEST agent      │
        │  (data steward)  │   ◀── mailbox ──      │  (user-driven)   │
        └─────────────────┘                       └─────────────────┘
```

The masking lives in **code**, not in a prompt: `pi/lib/mask.ts` is a pure per-entity
function the producer's `query_masked` tool runs every row through. That single module is
the entire security boundary.

## Layout

```
masker/
├── docker-compose.yml          # one postgres:16 container, all 3 DBs
├── .env.example                # optional connection-string overrides
├── db/
│   ├── 01-create-databases.sql # creates "fintechP", "fintechT", bus
│   ├── bank-ddl.sql           # the bank schema (5 tables, enums, FKs) — applied to P & T
│   ├── 02-schema.sql           # \i bank-ddl into P & T; mq.messages in bus
│   ├── seed.py                 # Faker → related mock data; --append adds NEW prod data
│   ├── reset.sh                # reseed prod, empty test, clear bus
│   ├── sync_baseline.sh        # make test a full masked mirror of prod (start "in sync")
│   ├── sync_delta.sh           # pull only NEW prod rows into test (model-free CDC)
│   └── requirements.txt
└── pi/
    ├── package.json            # extension dep: pg
    ├── lib/
    │   ├── mask.ts             # ★ the masking control — per-entity, pure, testable
    │   ├── schema.ts           # shared table/column metadata (extension + sync tools)
    │   └── pg.ts               # pg pools from PI_PG_URL / PI_BUS_URL
    ├── tools/                  # model-free sync helpers (reuse mask.ts): baseline + delta
    ├── extensions/
    │   ├── mailbox.ts          # identical on both agents: mailbox_send, mailbox_wait
    │   └── bank-db.ts          # role-gated, multi-entity: query_masked / insert_rows / local_watermark
    ├── prod/  (.pi/settings.json, .pi/APPEND_SYSTEM.md, run.sh)
    └── test/  (.pi/settings.json, .pi/APPEND_SYSTEM.md, run.sh)
```

> **DB naming:** the requested convention is *mock-data base name + `P`/`T`*, here
> `fintechP` / `fintechT`. The names are mixed-case so they stay double-quoted in SQL and
> exact-case in connection URLs. To rename, edit `db/01-create-databases.sql`,
> `db/02-schema.sql`, `db/seed.py`, and the `run.sh` URLs (or set them in `.env`).

## Setup (once)

```bash
# 1. Start Postgres + create the three databases
docker compose up -d

# 2. Install the extension dependency (pg)
cd pi && npm install && cd ..

# 3. Seed the PRODUCTION db with a related mock dataset (test db stays empty)
python3 -m venv .venv
./.venv/bin/pip install -r db/requirements.txt
./.venv/bin/python db/seed.py        # --customers N to change volume
```

Pi uses your global model/provider (`~/.pi/agent/settings.json`; defaults here to
`github-copilot` / `gpt-5.4`). No API keys are added by this PoC.

## Browse the data (pgAdmin)

`docker compose up` also starts a local pgAdmin on **http://localhost:5050**:

- **Login:** `admin@masker.com` / `masker`
- The three databases are pre-registered (server group **masker**): **fintechP**,
  **fintechT**, **bus**. Expand one → Schemas → **bank** → Tables → `customers`/`accounts`/
  `cards`/… (or **mq** → `messages` on the bus) → right-click → *View/Edit Data*.
  (DB password on first connect: `masker`.)

This is a self-contained instance for the PoC; it does not touch any other pgAdmin you run.

## Run the demo

Two terminals:

```bash
# Terminal 1 — production responder (autonomous; Ctrl+C to stop)
./pi/prod/run.sh

# Terminal 2 — test agent (interactive)
./pi/test/run.sh
```

**Terminal 1 prints a full trace of the production agent each cycle** — its thinking, every
tool call with arguments, every result, and its narration — so you can watch exactly what it
does before any data goes back to test. The producer is **locked to three tools**
(`mailbox_wait`, `query_masked`, `mailbox_send`); `bash`/`read`/`write`/`edit` are blocked,
so it physically cannot read the raw tables or hand-roll its own query — masking is its only
path to data.

In the test agent, type a natural request, e.g.:

> Pull 5 customers and their accounts and cards from production into the test database,
> then show me what landed.

The test agent sends one request per entity over the mailbox, prod answers each with masked
rows, and the test agent inserts them into `fintechT` in foreign-key order. Request bodies
are `{ entity, limit, customer_id?, account_id? }`:

- `entity` ∈ `customers | addresses | accounts | cards | transactions`
- `customer_id` scopes customers/addresses/accounts; `account_id` scopes cards/transactions
- e.g. *"give me 5 customers"*, *"accounts for customer 3"*, *"transactions for account 12"*

## Scenario: keep test in sync with production (CDC)

Start both databases **in sync**, introduce new data to production, and let the agent ship
just the new — masked — rows to test.

```bash
# 1. Baseline: make test a full masked mirror of prod (both "in sync")
./db/reset.sh            # seed prod, empty test
./db/sync_baseline.sh    # test := masked copy of every prod row (FK order)

# 2. Introduce NEW data to production (ids continue from the current max)
./.venv/bin/python db/seed.py --append --customers 5

# 3. The agent ships the delta. Start the prod responder, then in the test agent say:
#      "Sync new data from production into the test database."
./pi/prod/run.sh         # terminal 1
./pi/test/run.sh         # terminal 2
```

For each entity the test agent reads its **`local_watermark`** (the max id it already has),
asks prod for rows with `since_id` past it, and inserts the masked results — so only the new
rows cross, and they cross masked. (`./db/sync_delta.sh` does the same thing without the
model, for verification or quota-free runs.)

## Verify the boundary

```bash
# Test DB — MASKED (customer → account → card join)
docker exec masker-db psql -U masker -d fintechT -c "
  SELECT c.id, c.last_name, c.ssn, c.email, a.account_number, k.card_number
  FROM bank.customers c JOIN bank.accounts a ON a.customer_id=c.id
  LEFT JOIN bank.cards k ON k.account_id=a.id ORDER BY c.id LIMIT 10;"

# Production DB — RAW (same join)
docker exec masker-db psql -U masker -d fintechP -c "
  SELECT c.id, c.last_name, c.ssn, c.email, a.account_number, k.card_number
  FROM bank.customers c JOIN bank.accounts a ON a.customer_id=c.id
  LEFT JOIN bank.cards k ON k.account_id=a.id ORDER BY c.id LIMIT 10;"

# The bus carried the request + reply; the reply contains NO raw SSN/card
docker exec masker-db psql -U masker -d bus \
  -c "SELECT id, sender, recipient, jsonb_pretty(body) FROM mq.messages ORDER BY id;"

# Leak check — expect 0
docker exec masker-db psql -U masker -d bus -t \
  -c "SELECT count(*) FROM mq.messages WHERE body::text ~ '[0-9]{3}-[0-9]{2}-[0-9]{4}' OR body::text ~ '[0-9]{16}';"
```

Expected: `fintechT` shows `***-**-1234`, `4111 **** **** 1234`, `J***`; `fintechP` shows the
real values; the leak check returns `0`.

Unit-check the per-entity masking alone (Node's native TS support):

```bash
node --experimental-strip-types -e '
import("./pi/lib/mask.ts").then(({maskRow}) =>
  console.log(maskRow("customers",{id:1,first_name:"Danielle",last_name:"Johnson",
    email:"danielle.johnson@yahoo.com",phone:"(555) 123-4567",ssn:"224-30-8280",
    date_of_birth:"1981-06-01",created_at:"2022-01-01T00:00:00Z"})));'
```

## How it fits together

- **Transport is symmetric.** Both agents use the *same* `mailbox` extension against the
  same `mq.messages` table — each `mailbox_send`s and `mailbox_wait`s. `PI_AGENT_ID`
  (`prod`/`test`) is each agent's address.
- **Roles are config, not forks.** `pi/extensions/bank-db.ts` reads `PI_DB_ROLE`:
  `producer` registers only `query_masked` (masks in code) and blocks all other tools;
  `consumer` registers `insert_rows` + `query_local`. Same file, different env.
- **The prod loop** (`pi/prod/run.sh`) polls the bus with a cheap SQL count (no model cost
  while idle) and only invokes the agent when a real request is pending. Each run handles
  one request, prints its full trace, and exits.

## Reset

Put the databases back to a clean start (prod reseeded with canonical data, test emptied,
bus cleared) without recreating the container:

```bash
./db/reset.sh                    # reseed fintechP, empty fintechT, clear the bus
./db/reset.sh --customers 200    # reseed prod with a different volume
```

## Teardown

```bash
docker compose down          # stop container, keep data volume
docker compose down -v       # also delete the data volume (fresh start next time)
```
