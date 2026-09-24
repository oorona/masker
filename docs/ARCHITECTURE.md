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
├── docker-compose.yml          # postgres:16 with all 3 DBs (+ profiles: ui, emulate, seed)
├── docker-compose.home.yml     # overlay: Traefik labels for the home-lab deployment
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
    ├── Dockerfile              # control-plane image: node:24 + python3/Faker (context = repo root)
    ├── lib/
    │   ├── mask.ts             # ★ the masking control — per-entity, pure, testable
    │   ├── schema.ts           # shared table/column metadata (extension + sync tools + ui)
    │   └── pg.ts               # pg pools from PI_PG_URL / PI_BUS_URL
    ├── tools/                  # model-free programs that reuse mask.ts:
    │   ├── sync-baseline.mjs   #   test := masked mirror of prod (no bus)
    │   ├── sync-delta.mjs      #   only new prod rows → test (no bus)
    │   └── prod-emulator.mjs   #   the prod agent's bus protocol without a model
    ├── ui/                     # bus monitor + control plane: server.mjs (SSE tail of
    │                           #   mq.messages, starts/stops the agents, seeds/resets), index.html
    ├── extensions/
    │   ├── mailbox.ts          # identical on both agents: mailbox_send, mailbox_wait
    │   └── bank-db.ts          # role-gated, multi-entity: query_masked / insert_rows / local_watermark
    ├── prod/  (.pi/settings.json, .pi/APPEND_SYSTEM.md, run.sh, trace.mjs → also feeds the ui)
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
- **The bus is the only thing the UI watches.** `pi/ui/server.mjs` polls `mq.messages`
  (new ids, plus `consumed_at` flips for pending ones) and pushes them to the page over
  Server-Sent Events; the page pairs each reply to the request it `echo`es. The server has
  the bus and `fintechT` connection strings only: what it can show is, by construction,
  what already crossed the wire masked. The prod-side trace reaches it as an HTTP POST
  from `trace.mjs` (or the emulator), never from the data DB.
- **Emulators speak the same protocol.** `prod-emulator.mjs` reuses the mailbox SQL and
  the `query_masked` SQL builder with `maskRow`, so its replies are what the real producer
  would send. The control plane's test agent is a `mailbox_wait` loop plus `insert_rows`;
  scenario steps wait for the reply whose `echo` equals the request they sent (compared as
  canonical JSON, since JSONB reorders keys). Either side can be real or emulated; the
  boundary is identical in all four combinations.
- **The control plane is a supervisor, not a data path.** With `MASKER_CONTROL=1` the UI
  server starts the prod emulator and the seeder as child processes and runs the test agent
  in-process; it queries `fintechP` only for `count(*)` per table. Starting, stopping,
  seeding and resetting are HTTP endpoints driven by the page, so a deployment needs no
  shell access to run the demo.
