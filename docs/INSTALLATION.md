# Installation and usage

How to configure, run, verify, and deploy the demo. See [README.md](../README.md) for what it
is, [SPEC.md](SPEC.md) for the contract, and [ARCHITECTURE.md](ARCHITECTURE.md) for the
topology.

## Requirements

- Docker with Compose (everything containerised runs on this alone).
- For the real Pi agents on a workstation: [Pi](https://pi.dev) with a ChatGPT Plus/Pro
  login for the `openai-codex` provider, and Node 22.18+ (native TypeScript stripping).
- For running the seeder or the UI natively: Python 3.11+ and Node 22.18+.

## Setup (once)

```bash
docker compose up -d                 # masker-db (three databases) + masker-pgadmin
cd pi && npm install && cd ..        # the extensions' one dependency, pg
python3 -m venv .venv && ./.venv/bin/pip install -r db/requirements.txt
./.venv/bin/python db/seed.py        # seed fintechP; --customers N to change volume
```

Without a local Python, seed from the container instead: `docker compose run --rm
masker-seed`. `db/reset.sh` reseeds prod, empties test, and clears the bus, using whichever
seeder is available.

## Model

The two agents pin their model in project settings, `pi/prod/.pi/settings.json` and
`pi/test/.pi/settings.json`:

```json
{ "defaultProvider": "openai-codex", "defaultModel": "gpt-6-luna", "defaultThinkingLevel": "medium" }
```

Project settings override the global `~/.pi/agent/settings.json`, so the rest of your Pi
setup is untouched. Pi's built-in model registry does not list `gpt-6-luna`; Pi prints a
one-line warning and passes the id through to the Codex provider as a custom model. To use
another model, change these two files (or run `pi --model provider/id` for one session).

Pi's Codex login is an OAuth token. On a workstation, start `pi` interactively and run
`/login`. In the containerised stack (locally or on the home box) Pi lives inside
`masker-ui`, so log in there once; the login persists on the `masker-pi-home` volume:

```bash
docker exec -it masker-ui pi        # then type /login, pick OpenAI Codex
```

Pi prints a login URL. Open it in any browser, finish the login, and paste the redirect URL
back into the terminal when Pi asks (the headless flow). Leave Pi with `/exit`. Until this
is done, starting an agent in Pi mode logs `No API key found for the selected model` and
leaves the request on the bus.

## Browse the data (pgAdmin)

`docker compose up` also starts pgAdmin on **http://localhost:5050** (login
`admin@masker.com` / `masker`). The three databases are pre-registered under the server
group **masker**: `fintechP`, `fintechT`, `bus`. Expand one → Schemas → `bank` → Tables
(or `mq` → `messages` on the bus) → right-click → *View/Edit Data*. Database password on
first connect: `masker`.

## Run the demo with the real agents

Three terminals:

```bash
./pi/prod/run.sh          # 1. production responder (autonomous; Ctrl+C to stop)
./pi/test/run.sh          # 2. test agent (interactive)
./pi/ui/run.sh            # 3. bus monitor at http://127.0.0.1:5055 (observer mode)
```

Terminal 1 prints the production agent's full trace each cycle and forwards it to the
monitor. In the test agent, type a request such as:

> Pull 5 customers and their accounts and cards from production into the test database,
> then show me what landed.

The test agent sends one request per entity over the mailbox, prod answers each with masked
rows, and the test agent inserts them into `fintechT` in foreign-key order. Requests are
`{ entity, limit?, customer_id?, account_id?, since_id? }`; see SPEC §5.

**Keep test in sync (CDC).** Baseline both sides, add new data to production, and let the
agent ship just the new masked rows:

```bash
./db/reset.sh && ./db/sync_baseline.sh            # test := masked mirror of prod
./.venv/bin/python db/seed.py --append --customers 5
# then in the test agent: "Sync new data from production into the test database."
```

`./db/sync_delta.sh` does the same without the model, for verification or quota-free runs.

## Run the demo from the browser (control plane)

With `MASKER_CONTROL=1` the monitor becomes the control plane and nothing else has to be
started by hand:

```bash
MASKER_CONTROL=1 ./pi/ui/run.sh                # natively, http://127.0.0.1:5055
docker compose --profile ui up -d --build      # or containerised, http://127.0.0.1:5056
```

On the page, each agent has a mode switch, **Pi agent** (the default when Pi is installed)
or **emulated** (plain code, no model), and the card shows the configured model and the
model that actually answered:

- **prod agent** start / stop. In Pi mode this is the real producer with gpt-6-luna: it polls
  the bus and runs the agent once per pending request, trace on the right. While it is
  stopped, requests wait on the bus.
- **test agent** start / stop. In Pi mode the page shows a prompt box: type what you would
  type in the terminal ("Pull 5 customers and their accounts…"), and the real test agent runs
  with its own trace card. In emulated mode the *Ask prod for data* form and the scenario
  buttons drive requests directly. **Auto-sync** sends the sync prompt (Pi) or repeats the
  incremental sync (emulated) every 30 s, 60 s, or 5 min.
- **Databases** shows prod and test counts side by side, with *seed prod*, *append new*,
  *empty test*, *clear bus*, and *reset all*.
- **Full test run** does the whole demonstration from a clean slate and reports PASS or
  FAIL with every step's detail (SPEC §8). The prod agent runs in its selected mode, so with
  Pi mode every request is answered by gpt-6-luna; the test consumer is emulated for the run
  because the run drives the requests itself. One run at a time.
- **delete messages** on the timeline truncates the bus.
- **Replay a recorded run.** Every full test run is recorded (messages, tool calls, traces,
  counts, steps, with their timing). Pick a recording, a speed (1× to 20×), and press
  *replay*: the page plays it back exactly as it happened, only faster, so a four-minute run
  with the real model reviews in under a minute at 5×. *exit replay* returns to live.

The real agents and the emulated ones share the protocol, so a real test agent can talk to
the emulated prod and the other way round.

## Verify the boundary

```bash
# Test DB, masked (customer → account → card join)
docker exec masker-db psql -U masker -d fintechT -c "
  SELECT c.id, c.last_name, c.ssn, c.email, a.account_number, k.card_number
  FROM bank.customers c JOIN bank.accounts a ON a.customer_id=c.id
  LEFT JOIN bank.cards k ON k.account_id=a.id ORDER BY c.id LIMIT 10;"

# Production DB, raw (same join)
docker exec masker-db psql -U masker -d fintechP -c "
  SELECT c.id, c.last_name, c.ssn, c.email, a.account_number, k.card_number
  FROM bank.customers c JOIN bank.accounts a ON a.customer_id=c.id
  LEFT JOIN bank.cards k ON k.account_id=a.id ORDER BY c.id LIMIT 10;"

# Leak check on the bus, expect 0
docker exec masker-db psql -U masker -d bus -t \
  -c "SELECT count(*) FROM mq.messages WHERE body::text ~ '[0-9]{3}-[0-9]{2}-[0-9]{4}' OR body::text ~ '[0-9]{16}';"
```

Expected: `fintechT` shows `***-**-1234`, `4111 **** **** 1234`, `J***`; `fintechP` shows the
real values; the leak check returns `0`. The masking rules alone:

```bash
node --test pi/tests/mask.test.mjs
```

## Deploy to the home lab

The deployed instance is **https://masker.home.iktdts.com** on `projects.home.iktdts.com`,
LAN only. From the project root:

```bash
~/apps/infra/scripts/deploy.sh projects.home.iktdts.com      # rsync + .env.test → .env
ssh projects.home.iktdts.com 'cd apps/labs/masker && docker compose up -d --build --remove-orphans'
```

`.env.test` sets `COMPOSE_FILE=docker-compose.yml:docker-compose.home.yml`,
`COMPOSE_PROFILES=ui`, and `MASKER_CONTROL=1`, so that one compose command brings up the
database, pgAdmin, and the control-plane UI behind Traefik. Seed and reset from the page.
The DNS name is a CNAME to `projects` in the `home.iktdts.com` zone.

After the first deploy, log Pi in once on the box (the token persists across rebuilds):

```bash
ssh projects.home.iktdts.com
docker exec -it masker-ui pi        # /login → OpenAI Codex → open the URL → paste the redirect
```

## Reset and teardown

```bash
./db/reset.sh                    # reseed fintechP, empty fintechT, clear the bus
./db/reset.sh --customers 200    # different volume
docker compose down              # stop, keep data volumes
docker compose down -v           # also delete the volumes (fresh start next time)
```
