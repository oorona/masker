# masker — masking PII between two Pi agents

A proof of concept for one pattern: **mask sensitive data at the producer, before it crosses
the wire between two agents.** Companion to the article *"Two Pi Agents and a Customer
Table: Masking PII Before It Crosses the Wire."*

> **Status: built and deployed.** The two Pi agents, the bus, the masking boundary, and the
> control-plane UI implement the spec in `docs/SPEC.md`. The home-lab instance at
> `https://masker.home.iktdts.com` runs the real agents (gpt-6-luna) inside its container
> and drives the whole demonstration from the browser, including a one-button full test with
> a pass/fail verdict. A model-free emulated mode exists as a fallback switch.

Two independent [Pi](https://pi.dev) agents talk over a shared mailbox:

- **prod** sits on a production database (`fintechP`) holding a realistic relational bank
  dataset (customers, addresses, accounts, cards, transactions) full of sensitive PII. It
  serves data requests but **masks every row in code** before replying. There is no tool that
  returns raw rows, so the model on the prod side cannot leak PII even if asked.
- **test** owns a test database (`fintechT`) with the **same schema but no live data**. It
  asks prod for rows of any entity and loads the **masked** results it gets back.

```
              ┌──────────────── masker-db (one Postgres container) ──────────────┐
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
- **Model-free change data capture.** Baseline and delta sync reuse the same masking
  module, so test can be brought to a masked mirror of prod and later receive only new rows,
  with or without an agent in the loop.
- **Symmetric transport.** Both agents share one `mailbox` extension over a Postgres
  `mq.messages` table. Roles (`producer` / `consumer`) are environment config, not forks.
- **Visible traces and a control plane.** A web page tails the bus and shows the two agents
  talking: paired requests and masked replies, round-trip times, both agents' traces with the
  model that answered, and prod versus test row counts. In control mode it starts and stops
  the Pi agents, sends prompts to the test agent, seeds or resets the databases, and runs a
  complete test from a clean slate to a verdict.

## Docs

| File | Contents |
|---|---|
| [`docs/SPEC.md`](docs/SPEC.md) | Master spec: the data, the masking contract, the two agents and their tools, the bus protocol, model-free emulation, the UI and control plane, the full test run, architecture per the `/architecture` canon with its deliberate deviations, non-goals |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Stack at a glance, data flow, services and networks, repository layout, configuration, deployment, threat model and trust boundaries |
| [`docs/INSTALLATION.md`](docs/INSTALLATION.md) | Setup, model configuration, running with the real agents or from the browser, verifying the boundary, deploying to the home lab, reset and teardown |

## Running it

```bash
docker compose up -d                                    # Postgres with the three databases
docker compose run --rm masker-seed                     # seed production with mock PII
docker compose --profile ui up -d --build               # control plane at http://127.0.0.1:5056
```

Open the page, press **run one full test**, and watch the transfer: the agents start, a
slice of customers crosses masked, new production rows are appended and synced, the result
is verified, and the agents stop. Or run the real Pi agents in two terminals
(`./pi/prod/run.sh`, `./pi/test/run.sh`) with the monitor beside them (`./pi/ui/run.sh`).

## Tech stack

- **Agents:** Pi coding agents with TypeScript extensions (`pg` is the only dependency),
  model `openai-codex` / `gpt-6-luna` pinned per agent.
- **Data:** PostgreSQL 16 in one project container holding `fintechP`, `fintechT`, and the
  `bus` message database, plus a local pgAdmin.
- **Mock data:** Python + Faker generating a related bank dataset.
- **UI:** a dependency-free Node server (Server-Sent Events over the bus table) and one
  static page, shipped as a hardened container behind the shared Traefik on the home box.
- **Tests:** Node's built-in test runner against the pure masking module; the full test run
  in the UI verifies the transfer end to end.

## Key decisions (already made)

- The boundary is one pure function, and the producer's tools are the enforcement; prompts
  narrate, they do not protect.
- The Pi agents run inside the deployed container (Pi is in the image, the login on a
  volume), so the demo on the box is the real thing. Every side of the protocol also exists as
  plain code, a fallback that verifies the transfer without a model.
- The PoC keeps its own Postgres with demo credentials and no auth on the LAN-only page;
  these are documented deviations from the `/architecture` canon (SPEC §9), the rest of the
  canon (prefixed services, hardening, two-env deploy, Traefik ingress) is followed.

## Limitations

The allow-list holds only while the producer extension is loaded, the mailbox accepts
arbitrary JSON, watermark sync covers new ids but not updates or deletes, and message
claiming is transactional while processing after the claim is not exactly-once. The
development credentials in `docker-compose.yml` are demo values and the ports bind to
localhost only.
