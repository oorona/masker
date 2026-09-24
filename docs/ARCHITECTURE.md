# Architecture

Components, topology, and where the trust boundaries sit, in the shape of the
`/architecture` canon. See [SPEC.md](SPEC.md) for the contract this implements and
[INSTALLATION.md](INSTALLATION.md) for running it.

## 1. Stack at a glance

| Layer | Choice |
|---|---|
| Agents | two [Pi](https://pi.dev) coding agents, roles set by environment (`PI_AGENT_ID`, `PI_DB_ROLE`) |
| Model | `openai-codex` / `gpt-6-luna`, pinned per agent in `pi/<agent>/.pi/settings.json` |
| Agent extensions | TypeScript, `pg` as the only dependency, loaded natively by Pi |
| Masking boundary | `pi/lib/mask.ts`, a pure per-entity function |
| Transport | one Postgres table, `mq.messages`, in the `bus` database |
| Data | PostgreSQL 16 in one project container holding `fintechP` (raw), `fintechT` (masked), `bus` |
| Mock data | Python 3.13 + Faker (`db/seed.py`), run natively or in the `masker-seed` container |
| UI and control plane | Node 24 HTTP server with Server-Sent Events, one static HTML page, no build step |
| Agent runtime on the box | Pi installed in the `masker-ui` image; login and sessions on the `masker-pi-home` volume; one `pi --mode json` run per request or prompt |
| Model-free fallback | `pi/tools/prod-emulator.mjs` (producer), the UI server's test consumer, baseline and delta sync tools |
| Ingress (home lab) | shared Traefik v3 on the external `intranet` network, Cloudflare DNS-01 certificates, LAN allowlist |
| Deployment | `deploy.sh projects.home.iktdts.com`, two-env convention, `docker compose up -d --build` |
| Tests | Node's test runner on the masking module; the full test run in the UI verifies the transfer end to end |

## 2. Data flow

```
              ┌──────────────── masker-db (postgres:16) ─────────────────────────┐
              │  "fintechP" (raw PII)    "fintechT" (masked only)   bus (mq.messages)  │
              └──────▲──────────────────────▲───────────────────────────▲─────────┘
   query + mask ─────┘            insert ───┘                send / claim ┘
        ┌─────────────────┐                          ┌─────────────────┐
        │  PROD agent      │   ── request ──▶  bus  ──▶   │  TEST agent      │
        │  (data steward)  │   ◀── masked reply ──────    │  (consumer)      │
        └─────────────────┘                          └─────────────────┘
                 │ trace (HTTP)                                  ▲ start / stop / requests
                 ▼                                               │
        ┌──────────────────────────── masker-ui ─────────────────┴──┐
        │  tails mq.messages → browser (SSE) · control plane          │
        └────────────────────────────────────────────────────────────┘
```

The masking lives in code, not in a prompt: the producer's `query_masked` tool runs every
row through `maskRow` before the model sees it. There is no tool that returns a raw row, and
the producer's `tool_call` hook blocks shell, file, and edit tools, so the model cannot read
around the function.

## 3. Services (`docker-compose.yml`)

Service keys are project-prefixed, and every internal URL uses the prefixed hostname, per
the canon's rule for shared networks.

| Service | Image | Role | Networks | Ports |
|---|---|---|---|---|
| `masker-db` | `postgres:16` | the three databases; init scripts create them and apply the schema on first boot | project default | `127.0.0.1:5432` |
| `masker-pgadmin` | `dpage/pgadmin4` | browse the data; the three servers are pre-registered | project default | `127.0.0.1:5050` |
| `masker-ui` (profile `ui`) | `masker-ui`, built from `pi/Dockerfile` | bus monitor and control plane; runs the two Pi agents (or their emulators) and the seeder as child processes | project default (+ `intranet` on the home box) | `127.0.0.1:5056` locally, Traefik on the home box |
| `masker-seed` (profile `seed`) | `python:3.13-slim` | one-shot seeder for hosts without Python | project default | none |

`masker-ui` carries the canon hardening block: `user` 1000:1000, `read_only`, `cap_drop:
[ALL]`, `no-new-privileges`, `pids_limit 200`, `mem_limit 512m`, `tmpfs /tmp`. The
prod emulator and the seeder run as child processes inside it, so they inherit the same
limits. `docker-compose.home.yml` adds the Traefik labels and the external `intranet`
network; the deployed `.env` selects it through `COMPOSE_FILE`.

The Pi agents run inside `masker-ui`: Pi is installed in the image and the control plane
launches `pi --mode json` in `pi/prod` or `pi/test` with the same environment the shell
scripts set. The Codex login lives in `/home/node/.pi` on the `masker-pi-home` volume and is
done once, interactively, with `docker exec -it masker-ui pi` → `/login`. On a workstation the
same agents also run natively (`pi/prod/run.sh`, `pi/test/run.sh`) against the published port.

## 4. Repository layout

```
masker/
├── docker-compose.yml          # masker-db, masker-pgadmin (+ profiles: masker-ui, masker-seed)
├── docker-compose.home.yml     # overlay: Traefik labels + intranet for the home-lab deployment
├── .env.example                # connection-string and UI overrides
├── .env.test / .env.prod       # per-env values (gitignored; deploy.sh → remote .env)
├── secrets.test/ secrets.prod/ # per-env secrets sources (gitignored, empty for this PoC)
├── db/
│   ├── 01-create-databases.sql # "fintechP", "fintechT", bus
│   ├── bank-ddl.sql            # the bank schema, applied to P and T
│   ├── 02-schema.sql           # \i bank-ddl into P and T; mq.messages in bus
│   ├── seed.py                 # Faker → related mock data; --append adds new prod rows
│   ├── reset.sh                # reseed prod, empty test, clear bus
│   ├── sync_baseline.sh / sync_delta.sh   # model-free copies without the bus
│   └── pgadmin-servers.json
├── docs/                       # SPEC, ARCHITECTURE, INSTALLATION
└── pi/
    ├── package.json            # extension dep: pg
    ├── Dockerfile              # masker-ui image: node:24 + python3/Faker (context = repo root)
    ├── lib/
    │   ├── mask.ts             # ★ the masking control
    │   ├── schema.ts           # table, column, and filter metadata shared by everything
    │   └── pg.ts               # pools from PI_PG_URL / PI_BUS_URL
    ├── extensions/
    │   ├── mailbox.ts          # mailbox_send, mailbox_wait (identical on both agents)
    │   └── bank-db.ts          # role-gated: query_masked | insert_rows, local_watermark, query_local
    ├── tools/                  # model-free: prod-emulator, sync-baseline, sync-delta
    ├── ui/                     # server.mjs (SSE tail + control plane), index.html, run.sh
    ├── prod/                   # .pi/settings.json (model), .pi/APPEND_SYSTEM.md, run.sh, trace.mjs
    └── test/                   # .pi/settings.json (model), .pi/APPEND_SYSTEM.md, run.sh
```

## 5. Configuration and secrets

Tier 1, `.env`: connection strings (`PROD_PG_URL`, `TEST_PG_URL`, `BUS_URL`), UI host and
port, `MASKER_CONTROL`, `MASKER_UI_URL` for trace forwarding, `APP_UID`/`APP_GID`, and on
the home box `COMPOSE_FILE`, `COMPOSE_PROFILES`, `MASKER_HOST`. `pi/*/run.sh` and compose
read the same file.

Tiers 2 and 3 are present as structure only: `secrets.test/` and `secrets.prod/` exist for
the deploy convention but hold nothing, because every credential in this PoC is a demo value
for mock data. The one real credential, the Pi Codex login, is never in the repository: on a
workstation it is Pi's global auth store, on the box it is the `masker-pi-home` volume.

## 6. Deployment

`deploy.sh projects.home.iktdts.com` from the project root: `checkdeploy.sh` gate, code
rsync with `--delete` (excluding `.env*`, `secrets/`, and `.gitignore` entries), `.env.test`
to the remote `.env`, `secrets.test/` to `secrets/`. Then, over ssh, `docker compose up -d
--build` in `~/apps/labs/masker`. The remote `.env` selects the home overlay and the `ui`
profile, so one command brings up `masker-db`, `masker-pgadmin`, and `masker-ui`; the page
seeds the databases itself.

DNS: `masker.home.iktdts.com` is a CNAME to `projects` in the `home.iktdts.com` zone
(Technitium). TLS is the shared Traefik's Cloudflare DNS-01 certificate.

## 7. Threat model and trust boundaries

```
        LAN browser ──(B1)──▶ Traefik ──▶ masker-ui ──(B2)──▶ bus + fintechT
                                             │
                                             ├── spawns prod emulator ──(B3)──▶ fintechP
                                             └── spawns seeder ─────────(B3)──▶ fintechP
        Pi prod agent (model, inside masker-ui) ──(B3)──▶ query_masked ──▶ fintechP
        Pi test agent (model, inside masker-ui) ──(B2)──▶ bus + fintechT
```

| # | Boundary | Vector | Control |
|---|---|---|---|
| B1 | LAN ↔ UI | anyone on the LAN can drive the demo; edge abuse | Traefik TLS; `ipallowlist` of LAN ranges; no public exposure; hardened, non-root, read-only container; body size caps on every endpoint |
| B2 | UI / test agent ↔ bus, `fintechT` | a poisoned reply on the bus | replies are inserted with bound parameters into a fixed column list; foreign-key failures skip rows; the consumer only ever holds masked data |
| **B3** | **producer ↔ `fintechP`** | **the boundary the PoC exists for**: the model, or a request on the bus, tries to get raw rows out | `query_masked` is the only reader and masks in code; the tool allow-list blocks shell, file, and edit tools; the emulator and seeder are the only other readers and never return rows to anyone; `masker-ui` itself only counts rows |
| B3 | bus request ↔ producer | prompt injection through the JSON body | the producer's protocol is fixed in its system prompt and its tools are the enforcement, not the prompt; a malformed request gets an error reply |
| all | the bus itself | raw PII crossing the wire | the leak check (`***-**-` and 16-digit patterns) runs live in the UI and in the full test run; the pinned masking tests |

The residual risk is the one the README states: the allow-list holds only while the
producer extension is loaded, and the mailbox accepts arbitrary JSON.

## 8. How the pieces fit together

- **Transport is symmetric.** Both agents use the same `mailbox` extension against the same
  table. `PI_AGENT_ID` is each agent's address.
- **Roles are config, not forks.** `bank-db.ts` reads `PI_DB_ROLE`: `producer` registers
  only `query_masked` and blocks everything else; `consumer` registers `insert_rows`,
  `local_watermark`, and `query_local`.
- **The prod loop** polls the bus with a cheap SQL count, no model cost while idle, and runs
  the agent once per request with its full trace printed and forwarded to the UI.
- **The bus is the only thing the UI watches.** `server.mjs` polls for new ids and
  `consumed_at` flips and pushes them over SSE; the page pairs each reply to the request it
  echoes. The prod-side trace arrives as an HTTP POST, never from the data database.
- **Emulators speak the same protocol** and import the same `mask.ts`, so any combination of
  real and emulated sides has the identical boundary.
- **The control plane is a supervisor, not a data path.** It starts and stops workers, runs
  the seeder, and truncates tables; starting, stopping, seeding, and the full test run are
  HTTP endpoints, so a deployment needs no shell access to run the demo.
