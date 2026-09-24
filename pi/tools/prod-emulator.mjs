#!/usr/bin/env node
/**
 * prod emulator — a model-free stand-in for the production agent.
 *
 * Speaks the exact same bus protocol as pi/prod (claim the next message addressed
 * to `prod`, run the request through the SAME masking boundary, reply to `test`
 * with `{ ok, entity, rows, echo }`), but with no LLM in the loop. Use it to
 * demonstrate the transfer end to end where Pi or a model provider is not
 * available (e.g. the deployed bus monitor), or to run the pipeline for free.
 *
 * It reuses pi/lib/mask.ts and pi/lib/schema.ts, so what crosses the wire is
 * byte-for-byte what the real producer's `query_masked` tool would return. It also
 * forwards a trace in the same event shape as pi/prod/trace.mjs so the UI shows
 * each step (marked as emulated).
 *
 *   node pi/tools/prod-emulator.mjs        (Node 22.18+; type stripping is built in)
 *
 * Env: MASKER_PROD_URL, BUS_URL, MASKER_UI_URL (trace sink, "off" to disable).
 */
import pgPkg from "pg";
import { maskRow, ENTITIES } from "../lib/mask.ts";
import { TABLE, COLUMNS, FILTERS } from "../lib/schema.ts";

const { Pool } = pgPkg;
const PROD_URL = process.env.MASKER_PROD_URL ?? process.env.PROD_PG_URL ?? "postgresql://masker:masker@localhost:5432/fintechP";
const BUS_URL = process.env.BUS_URL ?? "postgresql://masker:masker@localhost:5432/bus";
const UI_URL = process.env.MASKER_UI_URL ?? "http://127.0.0.1:5055/trace";
const POLL_MS = Number(process.env.MASKER_EMU_POLL_MS ?? 1000);
const ME = "prod";

const prod = new Pool({ connectionString: PROD_URL, max: 2 });
const bus = new Pool({ connectionString: BUS_URL, max: 2 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(`[prod-emu] ${new Date().toLocaleTimeString()} ${s}`);

// ------------------------------------------------------------ trace sink
function trace(event) {
	if (UI_URL === "off") return;
	fetch(UI_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ emulated: true, ...event }),
	}).catch(() => {});
}
const say = (text) => { log(text); trace({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }); };
const toolStart = (toolName, args) => trace({ type: "tool_execution_start", toolName, args });
const toolEnd = (toolName, details, isError = false) => trace({ type: "tool_execution_end", toolName, isError, result: { details } });

// ------------------------------------------------------------ mailbox (same SQL as extensions/mailbox.ts)
async function claimNext() {
	const client = await bus.connect();
	try {
		await client.query("BEGIN");
		const { rows } = await client.query(
			`SELECT id, sender, body FROM mq.messages
			  WHERE recipient = $1 AND consumed_at IS NULL
			  ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
			[ME],
		);
		if (rows.length === 0) { await client.query("COMMIT"); return null; }
		await client.query("UPDATE mq.messages SET consumed_at = now() WHERE id = $1", [rows[0].id]);
		await client.query("COMMIT");
		return { id: Number(rows[0].id), from: rows[0].sender, body: rows[0].body };
	} catch (e) {
		await client.query("ROLLBACK").catch(() => {});
		throw e;
	} finally {
		client.release();
	}
}

async function send(to, body) {
	const { rows } = await bus.query(
		"INSERT INTO mq.messages (sender, recipient, body) VALUES ($1, $2, $3) RETURNING id",
		[ME, to, JSON.stringify(body)],
	);
	return Number(rows[0].id);
}

// ------------------------------------------------------------ query_masked (same SQL builder as extensions/bank-db.ts)
async function queryMasked(params) {
	const entity = params.entity;
	const limit = Math.min(Math.max(Number(params.limit ?? 10) || 10, 1), 200);
	const where = [];
	const args = [];
	for (const [param, column] of Object.entries(FILTERS[entity])) {
		if (params[param] !== undefined && params[param] !== null && params[param] !== "") {
			args.push(params[param]);
			where.push(`${column} = $${args.length}`);
		}
	}
	if (params.since_id !== undefined && params.since_id !== null && params.since_id !== "") {
		args.push(params.since_id);
		where.push(`id > $${args.length}`);
	}
	args.push(limit);
	const sql =
		`SELECT ${COLUMNS[entity].join(", ")} FROM ${TABLE[entity]} ` +
		(where.length ? `WHERE ${where.join(" AND ")} ` : "") +
		`ORDER BY id LIMIT $${args.length}`;
	const { rows } = await prod.query(sql, args);
	// THE BOUNDARY: every row is masked here, before anything leaves this process.
	return rows.map((r) => maskRow(entity, r));
}

// ------------------------------------------------------------ one cycle = one request
async function handle(msg) {
	trace({ type: "agent_start" });
	toolStart("mailbox_wait", {});
	toolEnd("mailbox_wait", { id: msg.id, from: msg.from, body: msg.body });

	const req = msg.body && typeof msg.body === "object" ? msg.body : {};
	if (!ENTITIES.includes(req.entity)) {
		say(`Request #${msg.id} has no valid entity (${JSON.stringify(req.entity)}); replying with an error.`);
		const body = { ok: false, error: `unknown entity; expected one of ${ENTITIES.join(", ")}`, echo: msg.body };
		toolStart("mailbox_send", { to: msg.from, body });
		const id = await send(msg.from, body);
		toolEnd("mailbox_send", { id, from: ME, to: msg.from });
		trace({ type: "agent_end" });
		return;
	}

	const scope = Object.entries(req).filter(([k]) => k !== "entity").map(([k, v]) => `${k}=${v}`).join(" ");
	say(`Got a request for ${req.entity}${scope ? ` (${scope})` : ""}. Querying production and masking in code.`);
	toolStart("query_masked", req);
	const rows = await queryMasked(req);
	toolEnd("query_masked", { entity: req.entity, count: rows.length });

	say(`Masked ${rows.length} row(s); returning them to ${msg.from}. No raw column leaves this process.`);
	const body = { ok: true, entity: req.entity, rows, echo: msg.body };
	toolStart("mailbox_send", { to: msg.from, body: { ok: true, entity: req.entity, rows: `[${rows.length} masked rows]`, echo: msg.body } });
	const id = await send(msg.from, body);
	toolEnd("mailbox_send", { id, from: ME, to: msg.from });
	trace({ type: "agent_end" });
}

async function main() {
	log(`data steward (emulated, no model) online — polling the bus every ${POLL_MS}ms`);
	let down = false;
	for (;;) {
		try {
			const msg = await claimNext();
			if (down) { down = false; log("bus reachable again"); }
			if (!msg) { await sleep(POLL_MS); continue; }
			await handle(msg);
		} catch (e) {
			if (!down) { down = true; log(`error: ${e.message} (retrying)`); }
			await sleep(POLL_MS * 3);
		}
	}
}

main();
