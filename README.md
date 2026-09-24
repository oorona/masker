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

## What it demonstrates

- **Masking at the producer.** The side that owns the sensitive data masks it before it
  leaves. The consumer never sees a raw row, so nothing downstream has to be trusted.
- **Tool allow-listing as the enforcement.** The producer agent is locked to three tools
  (`mailbox_wait`, `query_masked`, `mailbox_send`). Shell, file, and edit tools are blocked,
  so it cannot read the raw tables around the masking function.
- **Per-entity masking rules.** SSNs keep the last four digits, card numbers keep the BIN
  and last four, emails keep the first letter and domain, surnames keep the initial, dates
  of birth collapse to January 1st. Non-PII columns pass through unchanged.
- **Model-free change data capture.** Baseline and delta sync scripts reuse the same
  masking module, so test can be brought to a masked mirror of prod, and later receive only
  new rows, with or without an agent in the loop.
- **Symmetric transport.** Both agents share one `mailbox` extension over a Postgres
  `mq.messages` table. Roles (`producer` / `consumer`) are environment config, not forks.
- **Visible traces.** The prod loop polls the bus with a cheap SQL count while idle and
  prints the full agent trace (thinking, tool calls, results) for every real request.
- **A bus monitor and control plane.** `pi/ui` tails the mailbox and shows the two agents
  talking: paired requests and masked replies, round-trip times, the prod trace, and prod
  vs test row counts. In control mode the page also starts and stops the model-free agents
  (`pi/tools/prod-emulator.mjs` and a built-in test agent) and seeds or resets the
  databases, so the whole transfer runs from the browser without a model. One button runs a
  complete test from a clean slate to a pass/fail verdict.

## Tech stack

- **Agents:** [Pi](https://pi.dev) coding agents with TypeScript extensions (`pg` is the
  only dependency).
- **Data:** PostgreSQL 16 in one container holding `fintechP`, `fintechT`, and the `bus`
  message database, plus a local pgAdmin.
- **Mock data:** Python + Faker generating a related bank dataset (customers, addresses,
  accounts, cards, transactions).
- **Tests:** Node's built-in test runner against the pure masking module.
- **UI:** a dependency-free Node server (Server-Sent Events over the bus table) and one
  static HTML page; containerised with the emulators for the home-lab deployment.

## Limitations

This is a proof of concept. The allow-list holds only while the producer extension is
loaded, the mailbox accepts arbitrary JSON, watermark sync covers new ids but not updates
or deletes, and message claiming is transactional while processing after the claim is not
exactly-once. The development credentials in `docker-compose.yml` are demo values and the
ports bind to localhost only.

## Documentation

- [docs/INSTALLATION.md](docs/INSTALLATION.md): setup, running the demo, the CDC scenario,
  verifying the boundary, reset and teardown.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): layout, components, and how the pieces fit
  together.
