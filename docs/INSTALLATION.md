# Installation and usage

How to configure, run, and tear down the demo. See [README.md](../README.md) for what it is and [ARCHITECTURE.md](ARCHITECTURE.md) for how it is put together.

Prerequisites: Docker with Compose, Node 22.18+ (native TypeScript stripping), Python 3.11+, and [Pi](https://pi.dev) with a configured model provider.

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

## Watch the agents talk (web UI)

The bus monitor is a small web page that tails the mailbox and renders the conversation:
every `test → prod` request and `prod → test` masked reply, paired with round-trip times,
the masked cells highlighted, the prod agent's live trace, and the row counts of both
databases side by side (raw prod vs masked test). The header shows a live **raw PII on
bus** counter, the same leak check as below: it must stay at `0`.

```bash
./pi/ui/run.sh            # http://127.0.0.1:5055  (localhost only) — observer mode
```

Run it next to the two agent terminals. The prod responder forwards its trace to the page
automatically (`pi/prod/trace.mjs` posts to `MASKER_UI_URL`, default
`http://127.0.0.1:5055/trace`; set it to `off` to disable).

### Control plane: run the whole demo from the browser

With `MASKER_CONTROL=1` the same page becomes the control plane. Nothing else has to be
started by hand; every piece is a button:

- **prod agent — start / stop.** Runs `pi/tools/prod-emulator.mjs` as a child process: the
  model-free stand-in for the production agent. It claims requests addressed to `prod`, runs
  them through the same `mask.ts` boundary and replies `{ ok, entity, rows, echo }` exactly
  like the real agent. Its trace shows in the page, marked *emulated*. While it is stopped,
  requests queue on the bus (the timeline shows them *waiting for prod*).
- **test agent — start / stop.** Runs in the server: a `mailbox_wait` loop that consumes
  replies and inserts the masked rows into `fintechT`. When it is running, the *Ask prod for
  data* form sends single requests (entity, limit, `customer_id`, `account_id`, `since_id`),
  and the scenario buttons run *copy 5 customers + everything* (FK order) or *incremental
  sync* (watermark → `since_id`, paged). **Auto-sync** repeats the incremental sync every
  30 s / 60 s / 5 min, so new production rows appear in test on their own.
- **Full test run — one button.** *run one full test* does the whole thing from a clean
  slate and reports a verdict: stop everything → clear the bus, empty test, reseed prod →
  start both agents → copy a slice of customers with everything → append new customers to
  prod → incremental sync → verify → stop both agents. The verification checks that every
  request got a reply, nothing is left unread on the bus, no raw SSN or card number crossed
  the wire, test holds the same row counts as prod, and every sensitive column in test is
  masked. Only one run can be active at a time, and the manual buttons are locked while it
  runs. The seed size, slice size and append count are inputs on the card.
- **Delete messages.** The 🗑 button on the timeline (and *clear bus* on the Databases card)
  truncates `mq.messages`, which empties the timeline and the trace for every viewer.
- **Databases.** *seed prod* wipes and reseeds `fintechP` with N customers (runs
  `db/seed.py`), *append new* adds N new customers to prod (the CDC scenario: append, then
  sync), *empty test*, *clear bus*, and *reset all* (bus + test + reseed).

The activity card logs every action; the page reflects the state for every viewer.

```bash
MASKER_CONTROL=1 ./pi/ui/run.sh                 # natively (uses ./.venv for seed.py)
docker compose --profile ui up -d --build       # or containerised: http://127.0.0.1:5056
```

The control plane never selects a production column: it holds the `fintechP` URL only to
`count(*)` per table and to hand it to the two workers it starts (emulator, seeder).
The real Pi agents and the emulated ones are interchangeable per side because the bus
protocol is the same: a real test agent can talk to the emulated prod and vice versa.

## Deployed instance (home lab)

`https://masker.home.iktdts.com` is the containerised stack on `projects.home.iktdts.com`
(LAN only): Postgres with the three databases and the control-plane UI. Open the page,
press *start* on both agents, and run a scenario; seed or reset the databases from the same
page. Deploy with the shared script from the project root:

```bash
~/apps/infra/scripts/deploy.sh projects.home.iktdts.com    # rsync + .env.test → .env
ssh projects.home.iktdts.com 'cd apps/labs/masker && docker compose up -d --build'
```

`.env.test` sets `COMPOSE_FILE` (adds `docker-compose.home.yml` with the Traefik labels),
`COMPOSE_PROFILES=ui` and `MASKER_CONTROL=1`; the DNS name is a CNAME to `projects` in the
`home.iktdts.com` zone (Technitium). Anyone on the LAN who can open the page can drive it.

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

Unit-check the per-entity masking alone (Node's native TS support). The test file runs the real `pi/lib/mask.ts` with no model or database:

```bash
node --test pi/tests/mask.test.mjs
```

Or a one-off call:

```bash
node --experimental-strip-types -e '
import("./pi/lib/mask.ts").then(({maskRow}) =>
  console.log(maskRow("customers",{id:1,first_name:"Danielle",last_name:"Johnson",
    email:"danielle.johnson@yahoo.com",phone:"(555) 123-4567",ssn:"224-30-8280",
    date_of_birth:"1981-06-01",created_at:"2022-01-01T00:00:00Z"})));'
```


## Reset

Put the databases back to a clean start (prod reseeded with canonical data, test emptied,
bus cleared) without recreating the container. The seeder is the local `.venv` when
present, otherwise the `seed` compose service (no local Python needed):

```bash
./db/reset.sh                    # reseed fintechP, empty fintechT, clear the bus
./db/reset.sh --customers 200    # reseed prod with a different volume
```

## Teardown

```bash
docker compose down          # stop container, keep data volume
docker compose down -v       # also delete the data volume (fresh start next time)
```
