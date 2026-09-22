# Architecture

Components, data flow, and where the security boundary sits. See [README.md](../README.md) for what the project is and [INSTALLATION.md](INSTALLATION.md) for running it.

## Data flow

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

