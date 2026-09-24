#!/usr/bin/env node
/**
 * Bus monitor + control plane — the web UI that shows the two agents talking and,
 * with MASKER_CONTROL=1, starts/stops everything from the page.
 *
 * Observer (always): tails `mq.messages` in the bus database (the ONLY channel
 * between prod and test), streams every message to the browser over Server-Sent
 * Events, relays the prod-side trace (pi/prod/trace.mjs or the emulator), and reports
 * row counts per database.
 *
 * Control plane (MASKER_CONTROL=1). Each agent has two modes:
 *   prod agent   - "pi": the real Pi agent (pi/prod, model from its .pi/settings.json):
 *                  the same loop as pi/prod/run.sh — poll the bus, run `pi --mode json`
 *                  once per pending request, stream its trace to the page.
 *                  "emulated": pi/tools/prod-emulator.mjs as a child process (no model).
 *   test agent   - "pi": the real Pi agent (pi/test); the page sends it prompts, each
 *                  prompt is one `pi --mode json` run whose trace streams to the page.
 *                  "emulated": an in-process mailbox_wait loop that inserts replies into
 *                  fintechT, plus the request form, the scenarios and auto-sync.
 *   databases    - seed / append prod (db/seed.py as a child process), empty test,
 *                  clear the bus, full reset
 *
 * Data access of THIS process: bus (read/write), fintechT (read/write, masked rows
 * only) and, for the control plane, fintechP for `count(*)` per table and to pass
 * the URL to the workers. It never selects a prod column.
 */
import http from "node:http";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pgPkg from "pg";
import { ENTITY_ORDER, TABLE, COLUMNS } from "../lib/schema.ts";

const { Pool } = pgPkg;

const HOST = process.env.MASKER_UI_HOST ?? "127.0.0.1";
const PORT = Number(process.env.MASKER_UI_PORT ?? 5055);
const BUS_URL = process.env.BUS_URL ?? "postgresql://masker:masker@localhost:5432/bus";
const TEST_URL = process.env.TEST_PG_URL ?? "postgresql://masker:masker@localhost:5432/fintechT";
const PROD_URL = process.env.MASKER_PROD_URL ?? process.env.PROD_PG_URL ?? "postgresql://masker:masker@localhost:5432/fintechP";
const CONTROL = /^(1|true|yes)$/i.test(process.env.MASKER_CONTROL ?? process.env.MASKER_EMULATE_TEST ?? "");
const POLL_MS = 1000;
const STATS_MS = 3000;
const HISTORY_LIMIT = 500;
const TRACE_KEEP = 300;
const LOG_KEEP = 200;
const REPLY_TIMEOUT_MS = 180_000;
const RECORDINGS_DIR = process.env.MASKER_RECORDINGS_DIR ?? path.join(process.env.HOME ?? os.homedir(), ".pi", "masker-recordings");
const RECORDINGS_KEEP = 30;

const here = path.dirname(fileURLToPath(import.meta.url));
const PI_ROOT = path.resolve(here, "..");
const REPO_ROOT = path.resolve(PI_ROOT, "..");
const PI_BIN = process.env.MASKER_PI_BIN ?? "pi";
const PI_VERSION = (() => {
	try { const r = spawnSync(PI_BIN, ["--version"], { timeout: 20000, encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; } catch { return null; }
})();
const PI_AVAILABLE = PI_VERSION !== null;
/** provider/model an agent will use, read from its project settings (pi/<agent>/.pi/settings.json). */
function agentModel(agent) {
	try {
		const s = JSON.parse(readFileSync(path.join(PI_ROOT, agent, ".pi", "settings.json"), "utf8"));
		return s.defaultModel ? `${s.defaultProvider ? s.defaultProvider + "/" : ""}${s.defaultModel}` : null;
	} catch { return null; }
}
const PROD_PROMPT = "There are pending requests in your mailbox. Using only your provided tools, call mailbox_wait to read one, then query_masked to fetch the rows, then mailbox_send to return them to test — narrating each step. Then call mailbox_wait again with timeout_ms 6000 and repeat while requests keep arriving; stop when it returns empty.";
const SYNC_PROMPT = "Sync new data from production into the test database: for each entity in foreign-key order use local_watermark, ask prod with since_id, wait for the reply and insert the masked rows. Report what landed.";
const bus = new Pool({ connectionString: BUS_URL, max: 3 });
const test = new Pool({ connectionString: TEST_URL, max: 2 });
const prodCounts = CONTROL ? new Pool({ connectionString: PROD_URL, max: 1 }) : null; // count(*) only
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- SSE + logs
const clients = new Set();
const traceLog = [];
const opsLog = [];

function frame(event, data) {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
function broadcast(event, data) {
	const f = frame(event, data);
	for (const res of clients) res.write(f);
	if (recording) recording.events.push({ t: Date.now() - recording.t0, event, data });
}

// ---------------------------------------------------------------- recordings (every full run)
// Everything the page receives during a run — bus messages, pick-ups, both agents' traces
// with tool calls, the activity log, database counts, agent state, run steps — with a
// millisecond offset, so the page can replay it at any speed.
let recording = null;

function startRecording(meta) {
	recording = { id: new Date().toISOString().replace(/[:.]/g, "-"), t0: Date.now(), meta, events: [] };
}

async function stopRecording(extra) {
	if (!recording) return null;
	const rec = recording; recording = null;
	const out = { id: rec.id, startedAt: new Date(rec.t0).toISOString(), durationMs: Date.now() - rec.t0, ...rec.meta, ...extra, eventCount: rec.events.length, events: rec.events };
	try {
		await mkdir(RECORDINGS_DIR, { recursive: true });
		await writeFile(path.join(RECORDINGS_DIR, `${rec.id}.json`), JSON.stringify(out));
		log("ui", `recording saved: ${rec.id} (${out.eventCount} events, ${fmtMs(out.durationMs)})`);
		const files = (await readdir(RECORDINGS_DIR)).filter((f) => f.endsWith(".json")).sort();
		for (const f of files.slice(0, Math.max(0, files.length - RECORDINGS_KEEP))) await import("node:fs/promises").then((fs) => fs.unlink(path.join(RECORDINGS_DIR, f)).catch(() => {}));
	} catch (e) {
		log("ui", `recording NOT saved (${e.message}) — kept in memory for this session only`);
		memoryRecordings.set(rec.id, out);
	}
	return out;
}
const memoryRecordings = new Map();

async function listRecordings() {
	const out = [...memoryRecordings.values()];
	try {
		for (const f of (await readdir(RECORDINGS_DIR)).filter((f) => f.endsWith(".json"))) {
			try {
				const r = JSON.parse(await readFile(path.join(RECORDINGS_DIR, f), "utf8"));
				out.push({ id: r.id, startedAt: r.startedAt, durationMs: r.durationMs, params: r.params, verdict: r.verdict, summary: r.summary, eventCount: r.eventCount, prodModel: r.prodModel });
			} catch { /* skip unreadable */ }
		}
	} catch { /* no dir yet */ }
	return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).map(({ events, ...h }) => h);
}

async function getRecording(id) {
	if (!/^[\w-]+$/.test(id)) throw new Error("bad recording id");
	if (memoryRecordings.has(id)) return memoryRecordings.get(id);
	return JSON.parse(await readFile(path.join(RECORDINGS_DIR, `${id}.json`), "utf8"));
}
function log(src, text) {
	const line = { at: new Date().toISOString(), src, text: String(text).trimEnd() };
	console.log(`[${src}] ${new Date().toLocaleTimeString()} ${line.text}`);
	opsLog.push(line);
	while (opsLog.length > LOG_KEEP) opsLog.shift();
	broadcast("log", line);
}

const norm = (m) => ({
	id: Number(m.id),
	sender: m.sender,
	recipient: m.recipient,
	body: m.body,
	created_at: m.created_at,
	consumed_at: m.consumed_at,
});

// ---------------------------------------------------------------- state
let busOk = null;
const DEFAULT_MODE = PI_AVAILABLE ? "pi" : "emulated";
const prodAgent = { mode: DEFAULT_MODE, running: false, pid: null, since: null, cycles: 0, child: null, stopping: false, loop: null, modelSeen: null };
const testAgent = { mode: DEFAULT_MODE, running: false, since: null, autoSync: false, intervalMs: 60_000, timer: null, scenario: null, loop: null, handled: 0, busy: false, child: null, modelSeen: null };
const job = { name: null, since: null };

function statePayload() {
	return {
		control: CONTROL,
		bus: busOk,
		pi: { available: PI_AVAILABLE, version: PI_VERSION },
		prod: { mode: prodAgent.mode, running: prodAgent.running, pid: prodAgent.pid, since: prodAgent.since, cycles: prodAgent.cycles, model: agentModel("prod"), modelSeen: prodAgent.modelSeen },
		test: { mode: testAgent.mode, running: testAgent.running, since: testAgent.since, autoSync: testAgent.autoSync, intervalMs: testAgent.intervalMs, scenario: testAgent.scenario, handled: testAgent.handled, busy: testAgent.busy, model: agentModel("test"), modelSeen: testAgent.modelSeen },
		job: job.name ? { name: job.name, since: job.since } : null,
		run: runSummary(),
	};
}
const pushState = () => broadcast("state", statePayload());

// ---------------------------------------------------------------- bus tailing
let lastId = 0;
const unconsumed = new Set();

async function tick() {
	try {
		const { rows: mx } = await bus.query("SELECT COALESCE(MAX(id), 0)::bigint AS max FROM mq.messages");
		const max = Number(mx[0].max);
		if (max < lastId) {
			// bus truncated (RESTART IDENTITY) — start over.
			lastId = 0;
			unconsumed.clear();
			broadcast("reset", { at: new Date().toISOString() });
		}
		const { rows } = await bus.query(
			`SELECT id, sender, recipient, body, created_at, consumed_at
			   FROM mq.messages
			  WHERE id > $1 OR id = ANY($2::bigint[])
			  ORDER BY id`,
			[lastId, [...unconsumed]],
		);
		for (const raw of rows) {
			const m = norm(raw);
			if (m.id > lastId) {
				lastId = m.id;
				if (!m.consumed_at) unconsumed.add(m.id);
				broadcast("message", m);
			} else if (m.consumed_at) {
				unconsumed.delete(m.id);
				broadcast("consumed", { id: m.id, consumed_at: m.consumed_at });
			}
		}
		if (busOk !== true) { busOk = true; pushState(); }
	} catch (err) {
		if (busOk !== false) {
			busOk = false;
			log("ui", `bus unreachable: ${err.message}`);
			broadcast("state", { ...statePayload(), error: err.message });
		}
	}
}

const COUNTS_SQL = `
	SELECT (SELECT count(*) FROM bank.customers)::int    AS customers,
	       (SELECT count(*) FROM bank.addresses)::int    AS addresses,
	       (SELECT count(*) FROM bank.accounts)::int     AS accounts,
	       (SELECT count(*) FROM bank.cards)::int        AS cards,
	       (SELECT count(*) FROM bank.transactions)::int AS transactions`;

async function stats() {
	const out = { at: new Date().toISOString() };
	try {
		const { rows } = await bus.query(`
			SELECT count(*)::int                                                     AS messages,
			       count(*) FILTER (WHERE sender = 'test')::int                      AS requests,
			       count(*) FILTER (WHERE sender = 'prod')::int                      AS replies,
			       count(*) FILTER (WHERE consumed_at IS NULL)::int                  AS pending,
			       COALESCE(SUM(CASE WHEN sender = 'prod' AND jsonb_typeof(body->'rows') = 'array'
			                          THEN jsonb_array_length(body->'rows') ELSE 0 END), 0)::int AS rows_shipped,
			       count(*) FILTER (WHERE body::text ~ '[0-9]{3}-[0-9]{2}-[0-9]{4}'
			                            OR body::text ~ '[0-9]{16}')::int             AS leaks
			  FROM mq.messages`);
		Object.assign(out, rows[0]);
	} catch {
		out.bus = false;
	}
	try { out.test_db = (await test.query(COUNTS_SQL)).rows[0]; } catch { out.test_db = null; }
	if (prodCounts) {
		try { out.prod_db = (await prodCounts.query(COUNTS_SQL)).rows[0]; } catch { out.prod_db = null; }
	}
	broadcast("stats", out);
}

// ---------------------------------------------------------------- trace ingestion (from trace.mjs, the emulator, or a pi run)
function ingestTrace(agent, ev) {
	const out = { at: new Date().toISOString(), agent, ...ev };
	if (ev.type === "message_end" && ev.message?.role === "assistant" && ev.message?.model) {
		const seen = `${ev.message.provider ? ev.message.provider + "/" : ""}${ev.message.model}`;
		const a = agent === "test" ? testAgent : prodAgent;
		if (a.modelSeen !== seen) { a.modelSeen = seen; log(agent, `model answering: ${seen}`); pushState(); }
	}
	if (ev.type === "agent_end" && agent === "prod") { prodAgent.cycles += 1; pushState(); }
	if (ev.type === "error" || ev.error) log(agent, `error: ${ev.error ?? ev.message ?? JSON.stringify(ev).slice(0, 200)}`);
	traceLog.push(out);
	while (traceLog.length > TRACE_KEEP) traceLog.shift();
	broadcast("trace", out);
}

// ---------------------------------------------------------------- real Pi agents (one `pi --mode json` run per request / prompt)
function piEnv(agent) {
	const common = { HOME: process.env.HOME ?? "/home/node", PI_BUS_URL: BUS_URL, MASKER_UI_URL: "off" };
	return agent === "prod"
		? { ...common, PI_AGENT_ID: "prod", PI_DB_ROLE: "producer", PI_PG_URL: PROD_URL }
		: { ...common, PI_AGENT_ID: "test", PI_DB_ROLE: "consumer", PI_PG_URL: TEST_URL };
}

/** Run the real agent once (like pi/prod/run.sh does per request). Resolves with the exit code. */
function runPi(agent, prompt, holder) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(PI_BIN, ["--mode", "json", "--approve", prompt], {
				cwd: path.join(PI_ROOT, agent),
				env: { ...process.env, ...piEnv(agent) },
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (e) { log(agent, `cannot start pi: ${e.message}`); return resolve(-1); }
		holder.child = child;
		const rl = readline.createInterface({ input: child.stdout });
		rl.on("line", (line) => {
			let ev;
			try { ev = JSON.parse(line); } catch { return; }
			if (["agent_start", "tool_execution_start", "tool_execution_end", "agent_end", "error"].includes(ev.type)
				|| (ev.type === "message_end" && ev.message?.role === "assistant")) ingestTrace(agent, ev);
		});
		child.stderr.on("data", (b) => {
			for (const l of b.toString().split("\n")) {
				if (l.trim() && !/docs\/(providers|models)\.md$/.test(l.trim())) log(agent, l.trim());
			}
		});
		child.on("error", (e) => { log(agent, `pi failed: ${e.message}`); });
		child.on("exit", (code, signal) => { if (holder.child === child) holder.child = null; resolve(signal ? -1 : code ?? -1); });
	});
}

async function piProdLoop() {
	log("prod", `Pi agent online (${agentModel("prod") ?? "model from global settings"}) — polling the bus, one model run per pending request`);
	try {
		while (prodAgent.running) {
			let n = 0;
			try { n = (await bus.query("SELECT count(*)::int AS n FROM mq.messages WHERE recipient = 'prod' AND consumed_at IS NULL")).rows[0].n; }
			catch (e) { log("prod", `bus error: ${e.message}`); await sleep(3000); continue; }
			if (n === 0) { await sleep(2000); continue; }
			const code = await runPi("prod", PROD_PROMPT, prodAgent);
			if (code !== 0 && prodAgent.running) { log("prod", `pi run exited with ${code} — request left on the bus, retrying in 15s (is pi logged in? docker exec -it masker-ui pi → /login)`); await sleep(15000); }
		}
	} finally {
		prodAgent.running = false; prodAgent.pid = null; prodAgent.since = null; prodAgent.loop = null;
		log("prod", "stopped");
		pushState();
	}
}

async function runTestPrompt(text) {
	if (!testAgent.running || testAgent.mode !== "pi") throw new Error("test agent is not running in Pi mode");
	if (testAgent.busy) throw new Error("the test agent is still working on the previous prompt");
	testAgent.busy = true; pushState();
	log("test", `prompt → Pi agent: ${text.slice(0, 120)}`);
	try {
		const code = await runPi("test", text, testAgent);
		if (code !== 0) log("test", `pi run exited with ${code} (is pi logged in? docker exec -it masker-ui pi → /login)`);
		testAgent.handled += 1;
	} finally { testAgent.busy = false; pushState(); stats(); }
}

// ---------------------------------------------------------------- prod agent (emulated: child process; pi: loop above)
function startProd() {
	if (prodAgent.running) return;
	if (prodAgent.mode === "pi") {
		if (!PI_AVAILABLE) throw new Error("pi is not installed in this container — switch the prod agent to emulated");
		prodAgent.running = true; prodAgent.since = new Date().toISOString(); prodAgent.stopping = false; prodAgent.pid = null;
		prodAgent.loop = piProdLoop();
		pushState();
		return;
	}
	const child = spawn(process.execPath, ["tools/prod-emulator.mjs"], {
		cwd: PI_ROOT,
		env: { ...process.env, MASKER_PROD_URL: PROD_URL, BUS_URL, MASKER_UI_URL: `http://127.0.0.1:${PORT}/trace`, MASKER_EMU_POLL_MS: "1000" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	prodAgent.child = child;
	prodAgent.running = true;
	prodAgent.pid = child.pid;
	prodAgent.since = new Date().toISOString();
	prodAgent.stopping = false;
	const onLine = (buf) => {
		for (const l of buf.toString().split("\n")) if (l.trim()) log("prod", l.replace(/^\[prod-emu\] \S+ (AM|PM)? ?/, ""));
	};
	child.stdout.on("data", onLine);
	child.stderr.on("data", onLine);
	child.on("exit", (code, signal) => {
		log("prod", prodAgent.stopping ? "stopped" : `exited unexpectedly (${signal ?? code})`);
		prodAgent.running = false; prodAgent.pid = null; prodAgent.child = null; prodAgent.since = null;
		pushState();
	});
	log("ui", `prod agent started (pid ${child.pid})`);
	pushState();
}

/** Stop the prod agent and resolve once the process has actually exited. */
function stopProd() {
	if (!prodAgent.running) return Promise.resolve();
	if (prodAgent.mode === "pi") {
		prodAgent.running = false;
		prodAgent.child?.kill("SIGTERM");
		return (prodAgent.loop ?? Promise.resolve()).then(() => {});
	}
	if (!prodAgent.child) return Promise.resolve();
	const child = prodAgent.child;
	prodAgent.stopping = true;
	return new Promise((resolve) => {
		const t = setTimeout(() => { if (prodAgent.child === child) child.kill("SIGKILL"); }, 3000);
		child.once("exit", () => { clearTimeout(t); resolve(); });
		child.kill("SIGTERM");
	});
}

// ---------------------------------------------------------------- test agent (in-process)
// Same protocol as pi/test: mailbox_send a request → mailbox_wait the reply → insert_rows.
// One consumer loop claims every reply addressed to `test`; scenario steps register a
// waiter keyed by the request they sent (the reply carries it back as `echo`).
const waiters = new Map(); // canon(echo) -> resolve(reply)
const deferred = new Set(); // canon(request) whose rows the caller inserts itself (FK order)

/** Stable JSON (sorted keys) so a request and its JSONB `echo` compare equal. */
function canon(v) {
	if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
	if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
	return JSON.stringify(v);
}

async function mailboxSend(body) {
	const { rows } = await bus.query(
		"INSERT INTO mq.messages (sender, recipient, body) VALUES ('test', 'prod', $1) RETURNING id",
		[JSON.stringify(body)],
	);
	return Number(rows[0].id);
}

async function claimReply() {
	const client = await bus.connect();
	try {
		await client.query("BEGIN");
		const { rows } = await client.query(
			`SELECT id, body FROM mq.messages
			  WHERE recipient = 'test' AND consumed_at IS NULL
			  ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
		);
		if (!rows.length) { await client.query("COMMIT"); return null; }
		await client.query("UPDATE mq.messages SET consumed_at = now() WHERE id = $1", [rows[0].id]);
		await client.query("COMMIT");
		return { id: Number(rows[0].id), body: rows[0].body };
	} catch (e) {
		await client.query("ROLLBACK").catch(() => {});
		throw e;
	} finally {
		client.release();
	}
}

async function insertRows(entity, rows) {
	const cols = COLUMNS[entity];
	const ph = cols.map((_, i) => `$${i + 1}`).join(", ");
	let inserted = 0, skipped = 0, reason = "";
	for (const row of rows) {
		try {
			const r = await test.query(
				`INSERT INTO ${TABLE[entity]} (${cols.join(", ")}) VALUES (${ph}) ON CONFLICT (id) DO NOTHING`,
				cols.map((c) => row[c] ?? null),
			);
			inserted += r.rowCount;
		} catch (e) {
			// e.g. FK violation: the parent row was never pulled — same as the real agent
			// inserting out of dependency order. Skip the row, keep going.
			skipped += 1; reason = e.code === "23503" ? "parent row missing (FK)" : e.message;
		}
	}
	return { inserted, skipped, reason };
}

async function handleReply(reply) {
	const b = reply.body ?? {};
	const rows = Array.isArray(b.rows) ? b.rows : [];
	const entity = ENTITY_ORDER.includes(b.entity) ? b.entity : b.echo?.entity;
	const key = b.echo !== undefined ? canon(b.echo) : null;
	if (key && deferred.has(key)) {
		log("test", `reply #${reply.id}: ${rows.length} masked ${entity ?? "?"} row(s) received (inserted in FK order below)`);
	} else if (b.ok === true && rows.length && ENTITY_ORDER.includes(entity)) {
		const { inserted, skipped, reason } = await insertRows(entity, rows);
		log("test", `reply #${reply.id}: ${rows.length} masked ${entity} row(s) → inserted ${inserted} new into fintechT` + (skipped ? ` · ${skipped} skipped: ${reason}` : ""));
	} else if (b.ok === false) {
		log("test", `reply #${reply.id}: error from prod: ${b.error ?? "?"}`);
	} else {
		log("test", `reply #${reply.id}: ${entity ?? "?"} — nothing new`);
	}
	testAgent.handled += 1;
	if (key && waiters.has(key)) { waiters.get(key)(reply); waiters.delete(key); }
}

async function consumerLoop() {
	while (testAgent.running) {
		try {
			const reply = await claimReply();
			if (reply) {
				try { await handleReply(reply); }
				catch (e) {
					log("test", `reply #${reply.id}: ${e.message}`);
					const key = reply.body?.echo !== undefined ? canon(reply.body.echo) : null;
					if (key && waiters.has(key)) { waiters.get(key)(reply); waiters.delete(key); }
				}
				continue;
			}
		} catch (e) {
			log("test", `error: ${e.message}`);
			await sleep(3000);
		}
		await sleep(300);
	}
}

/** One round trip as the test agent does it. Resolves with the masked rows (or [] on timeout).
 *  With defer=true the rows are NOT inserted on arrival; the caller inserts them (FK order). */
function requestAndLoad(req, defer = false) {
	if (!testAgent.running) throw new Error("test agent is stopped");
	const key = canon(req);
	if (defer) deferred.add(key);
	return new Promise(async (resolve) => {
		const timer = setTimeout(() => {
			if (waiters.get(key) === done) { waiters.delete(key); log("test", `no reply to ${key} within ${REPLY_TIMEOUT_MS / 1000}s — is the prod agent running?`); resolve([]); }
		}, REPLY_TIMEOUT_MS);
		const done = (reply) => { clearTimeout(timer); deferred.delete(key); resolve(Array.isArray(reply.body?.rows) ? reply.body.rows : []); };
		waiters.set(key, done);
		try {
			const id = await mailboxSend(req);
			log("test", `→ prod #${id} ${JSON.stringify(req)}`);
		} catch (e) {
			clearTimeout(timer); waiters.delete(key); log("test", `send failed: ${e.message}`); resolve([]);
		}
	});
}

async function localWatermark(entity) {
	const { rows } = await test.query(`SELECT COALESCE(MAX(id), 0) AS m FROM ${TABLE[entity]}`);
	return Number(rows[0].m);
}

function cleanRequest(input) {
	if (!input || typeof input !== "object" || !ENTITY_ORDER.includes(input.entity)) {
		throw new Error(`entity must be one of ${ENTITY_ORDER.join(", ")}`);
	}
	const req = { entity: input.entity };
	for (const k of ["limit", "customer_id", "account_id", "since_id"]) {
		if (input[k] === undefined || input[k] === null || input[k] === "") continue;
		const n = Number(input[k]);
		if (!Number.isInteger(n) || n < 0) throw new Error(`${k} must be a non-negative integer`);
		req[k] = n;
	}
	if (req.limit !== undefined) req.limit = Math.min(Math.max(req.limit, 1), 500);
	return req;
}

// The flows documented in pi/test/.pi/APPEND_SYSTEM.md, strictly one hop at a time so the
// timeline shows each message cross. Each hop carries a whole table (up to PAGE rows); the
// prod agent keeps waiting a few seconds after each reply, so a chain of hops is one run.
const PAGE = 500;
const SCENARIOS = {
	// copy every table, table by table, in FK order (paged past the watermark while full)
	async copy() {
		for (const entity of ENTITY_ORDER) {
			for (let pages = 0; pages < 50 && testAgent.running; pages++) {
				const wm = await localWatermark(entity);
				const rows = await requestAndLoad({ entity, since_id: wm, limit: PAGE });
				if (rows.length < PAGE) break;
			}
		}
	},
	// copy N customers and everything hanging off them, one scoped request at a time
	async slice({ customers = 5 }) {
		const n = Math.min(Math.max(Number(customers) || 5, 1), 50);
		const cs = await requestAndLoad({ entity: "customers", limit: n });
		const accounts = [];
		for (const c of cs) {
			await requestAndLoad({ entity: "addresses", customer_id: Number(c.id), limit: PAGE });
			accounts.push(...(await requestAndLoad({ entity: "accounts", customer_id: Number(c.id), limit: PAGE })));
		}
		for (const a of accounts) {
			await requestAndLoad({ entity: "cards", account_id: Number(a.id), limit: PAGE });
			await requestAndLoad({ entity: "transactions", account_id: Number(a.id), limit: PAGE });
		}
	},
	// incremental sync: same as copy (watermark → since_id), which is the point of the CDC flow
	async sync() { return SCENARIOS.copy(); },
};

async function runScenario(kind, params, quiet = false) {
	if (!SCENARIOS[kind]) throw new Error(`unknown scenario '${kind}'`);
	if (!testAgent.running) throw new Error("test agent is stopped — start it first");
	if (testAgent.mode === "pi") throw new Error("the test agent is in Pi mode — send it a prompt instead");
	if (testAgent.scenario) throw new Error(`scenario '${testAgent.scenario}' is still running`);
	testAgent.scenario = kind;
	pushState();
	if (!quiet) log("test", `scenario '${kind}' started ${JSON.stringify(params ?? {})}`);
	SCENARIOS[kind](params ?? {})
		.then(() => { if (!quiet) log("test", `scenario '${kind}' finished`); })
		.catch((e) => log("test", `scenario '${kind}' failed: ${e.message}`))
		.finally(() => { testAgent.scenario = null; pushState(); });
}

function startTest() {
	if (testAgent.running) return;
	if (testAgent.mode === "pi" && !PI_AVAILABLE) throw new Error("pi is not installed in this container — switch the test agent to emulated");
	testAgent.running = true;
	testAgent.since = new Date().toISOString();
	if (testAgent.mode === "emulated") testAgent.loop = consumerLoop();
	setAutoSync(testAgent.autoSync, testAgent.intervalMs);
	log("ui", testAgent.mode === "pi"
		? `test agent started in Pi mode (${agentModel("test") ?? "model from global settings"}) — send it a prompt from the page`
		: "test agent started (emulated: consuming replies, inserting masked rows into fintechT)");
	pushState();
}

function stopTest() {
	if (!testAgent.running) return;
	testAgent.running = false;
	testAgent.since = null;
	if (testAgent.timer) { clearInterval(testAgent.timer); testAgent.timer = null; }
	for (const [key, done] of waiters) { waiters.delete(key); done({ body: {} }); }
	testAgent.child?.kill("SIGTERM");
	log("ui", "test agent stopped (replies will queue on the bus until it restarts)");
	pushState();
}

function setMode(agent, mode) {
	if (!["pi", "emulated"].includes(mode)) throw new Error("mode must be pi or emulated");
	if (mode === "pi" && !PI_AVAILABLE) throw new Error("pi is not installed in this container");
	const a = agent === "prod" ? prodAgent : testAgent;
	if (a.running) throw new Error(`stop the ${agent} agent before changing its mode`);
	a.mode = mode;
	log("ui", `${agent} agent mode: ${mode}${mode === "pi" ? ` (${agentModel(agent) ?? "model from global settings"})` : " (no model)"}`);
	pushState();
}

function setAutoSync(enabled, intervalMs) {
	testAgent.autoSync = !!enabled;
	testAgent.intervalMs = Math.min(Math.max(Number(intervalMs) || 60_000, 10_000), 3_600_000);
	if (testAgent.timer) { clearInterval(testAgent.timer); testAgent.timer = null; }
	if (testAgent.autoSync && testAgent.running) {
		testAgent.timer = setInterval(() => {
			if (testAgent.mode === "pi") { if (!testAgent.busy) runTestPrompt(SYNC_PROMPT).catch((e) => log("test", e.message)); }
			else if (!testAgent.scenario) runScenario("sync", {}, true).catch(() => {});
		}, testAgent.intervalMs);
	}
	pushState();
}

// ---------------------------------------------------------------- database jobs
function pythonBin() {
	const venv = path.join(REPO_ROOT, ".venv", "bin", "python");
	return existsSync(venv) ? venv : "python3";
}

function runJob(name, fn) {
	if (job.name) throw new Error(`'${job.name}' is still running`);
	job.name = name; job.since = new Date().toISOString();
	pushState();
	log("db", `${name}: started`);
	Promise.resolve()
		.then(fn)
		.then(() => log("db", `${name}: done`))
		.catch((e) => log("db", `${name}: FAILED — ${e.message}`))
		.finally(() => { job.name = null; job.since = null; pushState(); stats(); });
}

function seedProd({ customers = 80, append = false }) {
	const n = Math.min(Math.max(Number(customers) || 80, 1), 2000);
	return new Promise((resolve, reject) => {
		const args = [path.join(REPO_ROOT, "db", "seed.py"), "--customers", String(n)];
		if (append) args.push("--append");
		const child = spawn(pythonBin(), args, { cwd: REPO_ROOT, env: { ...process.env, MASKER_PROD_URL: PROD_URL }, stdio: ["ignore", "pipe", "pipe"] });
		const onLine = (buf) => {
			for (const l of buf.toString().split("\n")) {
				// never echo the seeder's sample raw customer into the UI
				if (l.trim() && !/Sample customer|ssn=/.test(l)) log("db", l);
			}
		};
		child.stdout.on("data", onLine);
		child.stderr.on("data", onLine);
		child.on("error", reject);
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`seed.py exited with ${code}`))));
	});
}

async function emptyTest() {
	await test.query("TRUNCATE bank.transactions, bank.cards, bank.accounts, bank.addresses, bank.customers RESTART IDENTITY CASCADE");
	log("db", "fintechT emptied");
}

async function clearBus() {
	await bus.query("TRUNCATE mq.messages RESTART IDENTITY");
	traceLog.length = 0;
	log("db", "bus cleared");
}

// ---------------------------------------------------------------- full test run (one at a time)
// One button: clean start → both agents → copy a slice → append new prod rows → incremental
// sync → verify (counts equal, everything masked, no raw PII on the bus) → stop the agents.
const run = { active: false, aborting: false, params: null, steps: [], startedAt: null, finishedAt: null, verdict: null, summary: null };
const RUN_STEPS = [
	"stop agents and auto-sync",
	"reset: clear bus, empty test, seed prod",
	"start prod agent",
	"start test agent",
	"copy production table by table (one hop each)",
	"append new customers to prod",
	"incremental sync (only the new rows cross)",
	"verify the transfer",
	"stop both agents",
];
function runSummary() {
	return { active: run.active, aborting: run.aborting, params: run.params, steps: run.steps, startedAt: run.startedAt, finishedAt: run.finishedAt, verdict: run.verdict, summary: run.summary };
}
const pushRun = () => broadcast("run", runSummary());

async function verifyTransfer() {
	const checks = [];
	const { rows: b } = await bus.query(`
		SELECT count(*) FILTER (WHERE sender='test')::int AS requests,
		       count(*) FILTER (WHERE sender='prod')::int AS replies,
		       count(*) FILTER (WHERE consumed_at IS NULL)::int AS pending,
		       count(*) FILTER (WHERE body::text ~ '[0-9]{3}-[0-9]{2}-[0-9]{4}' OR body::text ~ '[0-9]{16}')::int AS leaks
		  FROM mq.messages`);
	checks.push({ name: "every request got a reply", ok: b[0].requests > 0 && b[0].requests === b[0].replies, detail: `${b[0].requests} requests / ${b[0].replies} replies` });
	checks.push({ name: "nothing left unread on the bus", ok: b[0].pending === 0, detail: `${b[0].pending} pending` });
	checks.push({ name: "no raw SSN or card number crossed the wire", ok: b[0].leaks === 0, detail: `${b[0].leaks} leak(s)` });
	const p = (await prodCounts.query(COUNTS_SQL)).rows[0];
	const t = (await test.query(COUNTS_SQL)).rows[0];
	const diff = ENTITY_ORDER.filter((e) => p[e] !== t[e]);
	checks.push({ name: "test holds the same row counts as prod", ok: diff.length === 0, detail: ENTITY_ORDER.map((e) => `${e} ${t[e]}/${p[e]}`).join(", ") });
	const { rows: m } = await test.query(`
		SELECT (SELECT count(*) FROM bank.customers WHERE ssn !~ '^\\*{3}-\\*{2}-[0-9]{4}$' OR email !~ '^.\\*{3}@' OR last_name !~ '^.\\*{3}$' OR phone !~ '^\\*{3}-\\*{3}-[0-9]{4}$')::int AS customers,
		       (SELECT count(*) FROM bank.accounts WHERE account_number !~ '^\\*{4}[0-9]{4}$' OR routing_number !~ '^\\*{4}[0-9]{4}$')::int AS accounts,
		       (SELECT count(*) FROM bank.cards WHERE card_number !~ '^[0-9]{4} \\*{4} \\*{4} [0-9]{4}$' OR cvv <> '***')::int AS cards,
		       (SELECT count(*) FROM bank.addresses WHERE line1 <> '**** [redacted]')::int AS addresses`);
	const bad = Object.entries(m[0]).filter(([, n]) => n > 0);
	checks.push({ name: "every sensitive column in test is masked", ok: bad.length === 0, detail: bad.length ? bad.map(([k, n]) => `${n} unmasked ${k}`).join(", ") : `${t.customers} customers, ${t.accounts} accounts, ${t.cards} cards, ${t.addresses} addresses checked` });
	return checks;
}

async function fullRun(params) {
	if (run.active) throw new Error("a test run is already in progress — only one at a time");
	if (job.name) throw new Error(`'${job.name}' is still running`);
	if (testAgent.scenario) throw new Error(`scenario '${testAgent.scenario}' is still running`);
	const seed = Math.min(Math.max(Number(params.seed) || 5, 1), 500);
	const append = Math.min(Math.max(Number(params.append) || 1, 1), 50);
	const testModeBefore = testAgent.mode;
	Object.assign(run, { active: true, aborting: false, params: { seed, append, prod: prodAgent.mode, prodModel: prodAgent.mode === "pi" ? agentModel("prod") : null }, startedAt: new Date().toISOString(), finishedAt: null, verdict: null, summary: null,
		steps: RUN_STEPS.map((name) => ({ name, status: "pending", detail: "" })) });
	job.name = "test run"; job.since = run.startedAt;      // greys out the DB buttons
	testAgent.scenario = "test run";                        // greys out the request buttons
	startRecording({ params: run.params, prodModel: run.params.prodModel });
	pushState(); pushRun();
	log("run", `full test run started (seed ${seed} customers, copy everything table by table, append ${append}, sync)`);

	const step = async (i, fn) => {
		if (run.aborting) throw new Error("aborted");
		run.steps[i].status = "running"; pushRun();
		try {
			run.steps[i].detail = (await fn()) ?? "";
			run.steps[i].status = "done"; pushRun();
		} catch (e) {
			run.steps[i].status = "failed"; run.steps[i].detail = e.message; pushRun();
			throw e;
		}
	};
	const loaded = (rows) => `${rows.length} row(s) crossed masked`;
	try {
		await step(0, async () => { setAutoSync(false, testAgent.intervalMs); stopTest(); await stopProd(); return "clean slate"; });
		await step(1, async () => { await clearBus(); await emptyTest(); await seedProd({ customers: seed }); return `prod reseeded with ${seed} customers, test empty, bus empty`; });
		await step(2, async () => { startProd(); await sleep(800); if (!prodAgent.running) throw new Error("prod agent did not start"); return prodAgent.mode === "pi" ? `Pi agent, ${agentModel("prod") ?? "global model"}` : `emulated, pid ${prodAgent.pid}`; });
		await step(3, async () => { testAgent.mode = "emulated"; startTest(); testAgent.scenario = "test run"; return "emulated consumer (the run drives the requests), inserting into fintechT"; });
		await step(4, async () => {
			const before = testAgent.handled;
			await SCENARIOS.copy();
			const t = (await test.query(COUNTS_SQL)).rows[0];
			return `${testAgent.handled - before} round trips · test now ${ENTITY_ORDER.map((e) => `${t[e]} ${e}`).join(", ")}`;
		});
		await step(5, async () => { await seedProd({ customers: append, append: true }); const p = (await prodCounts.query(COUNTS_SQL)).rows[0]; return `prod now has ${p.customers} customers`; });
		await step(6, async () => { const before = testAgent.handled; await SCENARIOS.sync(); return `${testAgent.handled - before} round trips, watermark-based`; });
		let checks;
		await step(7, async () => { checks = await verifyTransfer(); const failed = checks.filter((c) => !c.ok); if (failed.length) throw new Error(failed.map((c) => `${c.name} (${c.detail})`).join("; ")); return checks.map((c) => `✓ ${c.name} — ${c.detail}`).join("\n"); });
		await step(8, async () => { testAgent.scenario = null; stopTest(); await stopProd(); return "both stopped"; });
		run.verdict = "pass";
		run.summary = `PASS · ${checks.length} checks · ${fmtMs(Date.now() - new Date(run.startedAt))} · prod ${run.params.prod === "pi" ? (prodAgent.modelSeen ?? run.params.prodModel ?? "Pi") : "emulated"}`;
	} catch (e) {
		run.verdict = "fail";
		run.summary = run.aborting ? `ABORTED by the user after ${fmtMs(Date.now() - new Date(run.startedAt))}` : `FAIL · ${e.message}`;
		for (const st of run.steps) if (st.status === "running") { st.status = "failed"; st.detail = run.aborting ? "aborted" : st.detail; }
		try { testAgent.scenario = null; stopTest(); await stopProd(); } catch {}
	} finally {
		run.active = false; run.finishedAt = new Date().toISOString();
		job.name = null; job.since = null; testAgent.scenario = null; testAgent.mode = testModeBefore;
		log("run", run.summary);
		pushRun(); pushState(); await stats();
		const saved = await stopRecording({ verdict: run.verdict, summary: run.summary, prodModelSeen: prodAgent.modelSeen });
		if (saved) broadcast("recordings", await listRecordings());
	}
}
/** Abort the active run: stop both agents (which fails the current step) and mark it. */
async function abortRun() {
	if (!run.active) return;
	run.aborting = true; pushRun();
	log("run", "abort requested — stopping both agents");
	testAgent.scenario = null;
	stopTest();
	await stopProd();
}
const fmtMs = (ms) => (ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);

// ---------------------------------------------------------------- HTTP
function json(res, code, data) {
	res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(data));
}

async function readBody(req, limit = 1_000_000) {
	const chunks = [];
	let size = 0;
	for await (const c of req) {
		size += c.length;
		if (size > limit) throw new Error("body too large");
		chunks.push(c);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req) {
	const text = await readBody(req, 100_000);
	return text.trim() ? JSON.parse(text) : {};
}

const needControl = () => { if (!CONTROL) throw new Error("control plane is off (MASKER_CONTROL=1 to enable)"); };

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://${req.headers.host}`);
	const p = url.pathname;
	try {
		if (req.method === "GET" && p === "/") {
			const html = await readFile(path.join(here, "index.html"));
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			return res.end(html);
		}

		if (req.method === "GET" && p === "/api/history") {
			const { rows } = await bus.query(
				`SELECT id, sender, recipient, body, created_at, consumed_at
				   FROM (SELECT * FROM mq.messages ORDER BY id DESC LIMIT $1) t
				  ORDER BY id`,
				[HISTORY_LIMIT],
			);
			return json(res, 200, { messages: rows.map(norm) });
		}

		if (req.method === "GET" && p === "/api/state") return json(res, 200, statePayload());
		if (req.method === "GET" && p === "/api/recordings") return json(res, 200, { recordings: await listRecordings() });
		if (req.method === "GET" && p.startsWith("/api/recordings/")) {
			try { return json(res, 200, await getRecording(p.slice("/api/recordings/".length))); }
			catch (e) { return json(res, 404, { error: `recording not found (${e.message})` }); }
		}

		if (req.method === "GET" && p === "/events") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-store",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			});
			res.write(frame("state", statePayload()));
			res.write(frame("run", runSummary()));
			listRecordings().then((l) => { if (clients.has(res)) res.write(frame("recordings", l)); });
			for (const l of opsLog) res.write(frame("log", l));
			for (const t of traceLog) res.write(frame("trace", t));
			clients.add(res);
			req.on("close", () => clients.delete(res));
			stats();
			return;
		}

		if (req.method === "POST" && p === "/trace") {
			const text = await readBody(req);
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				try { ingestTrace("prod", JSON.parse(line)); } catch { /* ignore malformed lines */ }
			}
			res.writeHead(204);
			return res.end();
		}

		if (req.method !== "POST" || !p.startsWith("/api/")) { res.writeHead(404); return res.end("not found"); }
		needControl();
		const body = await readJson(req);
		if (run.active) {
			if (["/api/run/abort", "/api/stop-all", "/api/prod/stop", "/api/test/stop"].includes(p)) { await abortRun(); return json(res, 200, statePayload()); }
			if (p !== "/api/run") throw new Error("a test run is in progress — abort it or wait for it to finish");
		}

		switch (p) {
			case "/api/prod/start": startProd(); return json(res, 200, statePayload());
			case "/api/prod/stop": await stopProd(); return json(res, 200, statePayload());
			case "/api/test/start": startTest(); return json(res, 200, statePayload());
			case "/api/test/stop": stopTest(); return json(res, 200, statePayload());
			case "/api/test/autosync": setAutoSync(body.enabled, body.intervalMs ?? testAgent.intervalMs); return json(res, 200, statePayload());
			case "/api/prod/mode": setMode("prod", body.mode); return json(res, 200, statePayload());
			case "/api/test/mode": setMode("test", body.mode); return json(res, 200, statePayload());
			case "/api/test/say": {
				const text = String(body.text ?? "").trim().slice(0, 2000);
				if (!text) throw new Error("text must not be empty");
				runTestPrompt(text).catch((e) => log("test", e.message));
				return json(res, 202, statePayload());
			}
			case "/api/request": {
				if (!testAgent.running) throw new Error("test agent is stopped — start it first");
				if (testAgent.mode === "pi") throw new Error("the test agent is in Pi mode — send it a prompt instead");
				const r = cleanRequest(body);
				requestAndLoad(r);
				return json(res, 202, { request: r });
			}
			case "/api/scenario": {
				const { kind, ...params } = body;
				await runScenario(kind, params);
				return json(res, 202, { started: kind });
			}
			case "/api/db/seed": runJob("seed prod", () => seedProd({ customers: body.customers })); return json(res, 202, statePayload());
			case "/api/db/append": runJob("append prod", () => seedProd({ customers: body.customers ?? 5, append: true })); return json(res, 202, statePayload());
			case "/api/db/empty-test": runJob("empty test", emptyTest); return json(res, 202, statePayload());
			case "/api/db/clear-bus": runJob("clear bus", clearBus); return json(res, 202, statePayload());
			case "/api/db/reset":
				runJob("reset all", async () => { await clearBus(); await emptyTest(); await seedProd({ customers: body.customers }); });
				return json(res, 202, statePayload());
			case "/api/stop-all": stopTest(); await stopProd(); return json(res, 200, statePayload());
			case "/api/run/abort": return json(res, 200, statePayload());
			case "/api/run": {
				if (run.active) throw new Error("a test run is already in progress — only one at a time");
				fullRun(body).catch((e) => log("run", `failed: ${e.message}`));
				return json(res, 202, runSummary());
			}
			case "/api/start-all": startProd(); startTest(); return json(res, 200, statePayload());
		}
		res.writeHead(404);
		res.end("not found");
	} catch (err) {
		const code = /must be|unknown scenario|still running|stopped|too large|JSON|control plane|in progress|not installed|Pi mode|before changing|not running|previous prompt|not empty/.test(err.message) ? 400 : 503;
		return json(res, code, { error: err.message });
	}
});

process.on("SIGTERM", () => { stopProd(); setTimeout(() => process.exit(0), 500); });
process.on("SIGINT", () => { stopProd(); setTimeout(() => process.exit(0), 500); });

server.listen(PORT, HOST, () => {
	log("ui", `bus monitor on http://${HOST}:${PORT}  (bus: ${BUS_URL.replace(/\/\/.*@/, "//…@")})`);
	log("ui", CONTROL ? "control plane ON — agents and databases are driven from the page" : "observer only (MASKER_CONTROL=1 enables the control plane)");
	if (CONTROL) log("ui", PI_AVAILABLE ? `pi ${PI_VERSION} available — prod: ${agentModel("prod") ?? "global model"}, test: ${agentModel("test") ?? "global model"} (log in once: docker exec -it masker-ui pi → /login)` : "pi not installed — agents run emulated only");
	tick();
	setInterval(tick, POLL_MS);
	setInterval(() => clients.size && !recording && stats(), STATS_MS);
	setInterval(() => recording && stats(), 1000);   // dense count snapshots while a run is recorded
});
