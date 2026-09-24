# masker — master specification

Status: **built.** This document is the contract the code implements: the two agents, the
bus protocol between them, the masking rules, the model-free emulation, the control-plane
UI, the test run, and the architecture decisions (per the `/architecture` canon, with the
deviations a proof of concept needs). `README.md` is the overview, `docs/ARCHITECTURE.md`
the topology and threat model, `docs/INSTALLATION.md` the runbook.

## 1. What this is

masker is a proof of concept for one pattern: **mask sensitive data at the producer, before
it crosses the wire between two agents.** It is the companion to the article *"Two Pi
Agents and a Customer Table: Masking PII Before It Crosses the Wire."*

Two independent [Pi](https://pi.dev) coding agents share a mailbox:

- **prod** owns a production bank database, `fintechP`, full of realistic PII. It serves
  data requests but has exactly one way to read data, and that way masks every row in code.
- **test** owns a test database, `fintechT`, with the same schema and no live data. It asks
  prod for rows and loads the masked results it gets back.

Everything the article claims is checkable here: the masking lives in one pure function, the
producer cannot reach the raw tables around it, and a leak check on the bus stays at zero.

## 2. Data

Both data databases carry the same `bank` schema (`db/bank-ddl.sql`): five related tables,
`customers` → `addresses`, `accounts` → `cards`, `transactions`. `db/seed.py` fills
`fintechP` with Faker data that is fake but realistically shaped: real-looking SSNs,
Luhn-valid card numbers, nine-digit account and routing numbers. `fintechT` starts empty.
The third database, `bus`, holds one table, `mq.messages`.

Naming follows the requested convention *mock-data base name + `P`/`T`*. The names are
mixed case, so they stay double-quoted in SQL and exact-case in connection URLs.

## 3. The masking contract

`pi/lib/mask.ts` is the entire security boundary: a pure function, `maskRow(entity, row)`,
with no database, network, or model. Masked values stay insert-compatible with the same
column types.

| Entity | Masked columns | Rule |
|---|---|---|
| customers | `last_name` | initial + `***` |
| | `email` | first letter + `***@` + domain |
| | `phone` | `***-***-` + last four digits |
| | `ssn` | `***-**-` + last four digits |
| | `date_of_birth` | year kept, month and day set to January 1st |
| addresses | `line1` | `**** [redacted]` |
| | `line2` | `***` when present |
| | `postal_code` | first two characters + `***` |
| accounts | `account_number`, `routing_number` | `****` + last four digits |
| cards | `card_number` | BIN (first four) + ` **** **** ` + last four |
| | `cardholder_name` | first name + ` ***` |
| | `cvv` | `***` |
| transactions | none | pass through unchanged (no direct identifiers) |

Non-sensitive columns (balances, dates, categories, city, state, brand, status) pass through
so the test side still gets realistically shaped data. `pi/tests/mask.test.mjs` pins the
rules with Node's test runner and no model or database.

## 4. The two agents

Both agents load the same two Pi extensions; roles are environment, not forks.

**Transport, `pi/extensions/mailbox.ts`, identical on both sides.** `PI_AGENT_ID` (`prod`
or `test`) is the agent's address. `mailbox_send(to, body)` inserts a row into
`mq.messages`. `mailbox_wait(timeout_ms)` long-polls for the next unconsumed message
addressed to me, claims it with `FOR UPDATE SKIP LOCKED`, marks `consumed_at`, and returns
it, or `{ empty: true }` on timeout.

**Data, `pi/extensions/bank-db.ts`, gated by `PI_DB_ROLE`.**

| Role | Agent | Tools registered | Enforcement |
|---|---|---|---|
| producer | prod | `query_masked` | a `tool_call` hook blocks every tool except `mailbox_wait`, `mailbox_send`, `query_masked`; shell, file, and edit tools are refused |
| consumer | test | `insert_rows`, `local_watermark`, `query_local` | none needed; it only ever sees masked rows |

`query_masked(entity, limit?, customer_id?, account_id?, since_id?)` builds one `SELECT`
from the shared metadata in `pi/lib/schema.ts`, runs every row through `maskRow`, and
returns the masked rows. There is no tool that returns a raw row.

**Prompts.** `pi/prod/.pi/APPEND_SYSTEM.md` fixes the producer's protocol: wait, query
masked, reply, stop, and narrate every step. `pi/test/.pi/APPEND_SYSTEM.md` tells the
consumer to request in foreign-key order and how to do an incremental sync.

**Model.** Both agents pin `openai-codex` / `gpt-6-luna` in their project settings
(`pi/<agent>/.pi/settings.json`), which override the global Pi settings. Thinking level is
medium on prod and low on test. Pi's built-in registry does not list this model id, so Pi
passes it through as a custom id on the Codex provider.

**The prod loop.** `pi/prod/run.sh` polls the bus with a cheap SQL count and only invokes
the model when a request is pending. Each run handles one request, and `pi/prod/trace.mjs`
prints the full trace and forwards it to the UI.

## 5. Bus protocol

One table, `mq.messages(id, sender, recipient, body jsonb, created_at, consumed_at)`, with
an index on `(recipient, consumed_at, id)`.

Request, test → prod:

```json
{ "entity": "accounts", "limit": 10, "customer_id": 3 }
{ "entity": "customers", "since_id": 42, "limit": 200 }
```

`entity` is one of `customers`, `addresses`, `accounts`, `cards`, `transactions`.
`customer_id` scopes customers, addresses, and accounts; `account_id` scopes cards and
transactions; `since_id` returns only rows with a greater id; `limit` defaults to 10 and is
capped at 200.

Reply, prod → test:

```json
{ "ok": true,  "entity": "accounts", "rows": [ ...masked rows... ], "echo": { ...the request... } }
{ "ok": false, "error": "unknown entity; expected one of ...", "echo": { ...the request... } }
```

`echo` carries the request back, which is how a consumer matches a reply to what it asked.
JSONB reorders object keys, so matching compares canonical JSON, not strings.

Two flows are specified. **Slice:** customers, then addresses and accounts per customer,
then cards and transactions per account. **Incremental sync:** per entity in foreign-key
order, read the local watermark (the highest id in the test table), request `since_id` past
it, and page while a reply is full.

## 6. Model-free emulation

Every part of the protocol also exists as plain code, so the transfer runs where no model or
Pi is available and costs nothing to run for verification.

- `pi/tools/prod-emulator.mjs` is the producer without a model: the same claim SQL as
  `mailbox_wait`, the same query builder and `maskRow` as `query_masked`, the same reply
  shape. It forwards a trace in the same event shape as the real agent, marked *emulated*.
- The UI server's test agent is the consumer without a model: a `mailbox_wait` loop that
  inserts replies into `fintechT`, plus the two flows above.
- `pi/tools/sync-baseline.mjs` and `sync-delta.mjs` do the copy without the bus at all.

Any side can be real or emulated. The boundary is identical in every combination because
the emulators import the same `mask.ts`.

## 7. The UI and control plane

`pi/ui` is a dependency-free Node server plus one HTML page. It tails `mq.messages` and
streams it to the browser over Server-Sent Events.

**Observer (always).** Paired request and reply cards with pick-up latency and round trip,
masked cells highlighted, rows in schema column order, the prod trace, prod and test row
counts per table, and header stats including a live **raw PII on bus** leak counter.

**Control plane (`MASKER_CONTROL=1`).** The page starts, stops, seeds, and resets
everything:

| Control | Does |
|---|---|
| prod agent start / stop | supervises `prod-emulator.mjs` as a child process; stop waits for exit |
| test agent start / stop | the in-process consumer loop; replies queue on the bus while it is stopped |
| request form | one request with entity, limit, `customer_id`, `account_id`, `since_id` |
| scenarios | *copy 5 customers + everything*, *incremental sync* |
| auto-sync | repeats the incremental sync every 30 s, 60 s, or 5 min |
| databases | seed prod (N customers), append new, empty test, clear bus, reset all |
| delete messages | truncates the bus; the timeline and trace empty for every viewer |
| full test run | §8 |

Endpoints are `POST /api/prod/start|stop`, `/api/test/start|stop|autosync`,
`/api/request`, `/api/scenario`, `/api/db/seed|append|empty-test|clear-bus|reset`,
`/api/run`, `/api/start-all`, `/api/stop-all`; `GET /api/state`, `/api/history`, and the
`/events` stream. `POST /trace` receives trace lines from the prod side.

The control plane never selects a production column. It holds the `fintechP` URL only to
`count(*)` per table and to hand it to the two workers it starts.

## 8. The full test run

One button runs the whole demonstration from a clean slate and reports a verdict. Only one
run can be active; a second request is refused and the manual buttons lock until it ends.

1. Stop both agents and auto-sync.
2. Clear the bus, empty `fintechT`, reseed `fintechP` (default 20 customers).
3. Start the prod agent, then the test agent.
4. Copy a slice (default 3 customers) with everything hanging off them.
5. Append new customers to prod (default 2).
6. Incremental sync, so only the new rows cross.
7. Verify.
8. Stop both agents.

Verification passes when all five hold: every request got a reply; nothing is left unread on
the bus; no raw SSN or 16-digit number crossed the wire; test holds the same row counts as
prod in all five tables; every sensitive column in test matches its mask pattern from §3.

## 9. Architecture (per the /architecture canon)

The canon's stack is a Next.js frontend and a FastAPI backend behind the shared Traefik,
with Postgres as an infra-level service. A proof of concept with three databases and a
raw-versus-masked split does not fit that shape, so the following is what is kept and what
deliberately deviates. `docs/ARCHITECTURE.md` has the topology and threat model.

**Kept from the canon**

- Project-prefixed service names on every network: `masker-db`, `masker-pgadmin`,
  `masker-ui`, `masker-seed`, and prefixed hostnames in every internal URL.
- Hardening block on the exposed service (`masker-ui`): non-root, `read_only`,
  `cap_drop: [ALL]`, `no-new-privileges`, `pids_limit`, `mem_limit`, scoped `tmpfs`.
- Traefik ingress on the shared external `intranet` network with the `cloudflare`
  certresolver and a LAN `ipallowlist` middleware, in the `docker-compose.home.yml` overlay.
- The two-env deploy convention: `.env.test` / `.env.prod`, `secrets.test/` /
  `secrets.prod/`, full `.gitignore` coverage, `deploy.sh projects.home.iktdts.com`.
- Base images `node:24` and `python:3.13-slim`; `package-lock.json` committed.
- No native browser popouts except one confirm on the destructive reset; no LangChain.

**Deliberate deviations**

- **Own Postgres container.** The PoC needs three databases in one place, one of them a
  stand-in for production, and the infra `postgres` on `dbnet` is shared by real projects.
  `masker-db` stays on the project's private network and binds to `127.0.0.1` only.
- **Demo credentials in compose, no Docker secrets.** All data is mock; the single
  `masker`/`masker` role is part of the demo and documented as such.
- **No frontend framework, no FastAPI.** One static page and a small Node server are the
  whole UI; the agents' extensions are TypeScript because Pi extensions are.
- **No auth.** The deployed page is reachable only from the LAN ranges in the allowlist, and
  anyone who can open it can drive the demo.
- **Requirements not fully pinned.** `db/requirements.txt` uses minimum versions; the seeder
  is a one-shot dev tool.

## 10. Non-goals and known limits

- The tool allow-list holds only while the producer extension is loaded.
- The mailbox accepts arbitrary JSON; a malformed request gets an error reply, nothing more.
- Watermark sync covers new ids, not updates or deletes.
- Message claiming is transactional; processing after the claim is not exactly-once.
- Two consumers on the same address race for replies; run either the real test agent or the
  emulated one against a given bus, not both.
