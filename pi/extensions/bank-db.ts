/**
 * bank-db extension — multi-entity DB access for both agents, role-gated by PI_DB_ROLE.
 *
 *   producer (prod agent, PI_PG_URL=fintechP):
 *     query_masked   - SELECT from any bank table and mask EVERY row in code before
 *                      returning. The only data reader; raw rows can never be emitted.
 *
 *   consumer (test agent, PI_PG_URL=fintechT):
 *     insert_rows    - INSERT (already-masked) rows into a bank table in the test DB.
 *     query_local    - read rows back from the test DB (to prove they're masked).
 *
 * The producer is additionally locked (via tool_call blocking) to ONLY mailbox_wait,
 * mailbox_send and query_masked — no bash/read/write/edit — so masking is its sole
 * path to data.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { dbPool } from "../lib/pg";
import { maskRow, ENTITIES, type Entity } from "../lib/mask";
import { TABLE, COLUMNS, FILTERS } from "../lib/schema";

const ROLE = process.env.PI_DB_ROLE ?? "consumer";

const PRODUCER_TOOLS = ["mailbox_wait", "mailbox_send", "query_masked"];

// Per-entity table + column metadata (shared source of truth in lib/schema.ts).
const SCHEMA: Record<Entity, { table: string; cols: string[]; filters: Record<string, string> }> =
	Object.fromEntries(
		ENTITIES.map((e) => [e, { table: TABLE[e], cols: COLUMNS[e], filters: FILTERS[e] }]),
	) as Record<Entity, { table: string; cols: string[]; filters: Record<string, string> }>;

const entityEnum = StringEnum(ENTITIES as unknown as string[]);

const QueryParams = Type.Object({
	entity: entityEnum,
	limit: Type.Optional(Type.Number({ description: "Max rows (default 10, cap 200)." })),
	customer_id: Type.Optional(Type.Number({ description: "Scope to a customer (customers/addresses/accounts)." })),
	account_id: Type.Optional(Type.Number({ description: "Scope to an account (cards/transactions)." })),
	since_id: Type.Optional(Type.Number({ description: "Only rows with id greater than this (incremental sync)." })),
});

const InsertParams = Type.Object({
	entity: entityEnum,
	rows: Type.Array(Type.Record(Type.String(), Type.Unknown()), {
		description: "Masked rows (objects) to insert into the test DB for this entity.",
	}),
});

const QueryLocalParams = Type.Object({
	entity: entityEnum,
	limit: Type.Optional(Type.Number({ description: "Max rows (default 10)." })),
});

export default function (pi: ExtensionAPI) {
	if (ROLE === "producer") {
		// HARD ENFORCEMENT: block every tool not on the allow-list. The producer
		// model cannot run bash, read files, or hand-roll raw SQL — query_masked is
		// its only route to data, and that route always masks.
		pi.on("tool_call", async (event) => {
			if (!PRODUCER_TOOLS.includes(event.toolName)) {
				return {
					block: true,
					reason:
						`Blocked: the production agent may only use ${PRODUCER_TOOLS.join(", ")}. ` +
						`Do not use "${event.toolName}". To read data, call query_masked (it returns masked rows).`,
				};
			}
		});

		pi.registerTool({
			name: "query_masked",
			label: "Query (masked)",
			description:
				"Query a production bank table and return MASKED rows. Sensitive columns are masked " +
				"in code before they leave this process. entity ∈ {customers, addresses, accounts, cards, " +
				"transactions}. Optional customer_id (customers/addresses/accounts) or account_id " +
				"(cards/transactions) scopes the result; since_id returns only rows newer than an id " +
				"(for incremental sync). This is the only way to read data.",
			promptSnippet: "Read any production bank table as masked rows (raw PII never returned).",
			promptGuidelines: [
				"Use query_masked to fulfill any data request; it is the only reader and always masks.",
			],
			parameters: QueryParams,
			async execute(_id, params) {
				const meta = SCHEMA[params.entity as Entity];
				const limit = Math.min(Math.max(params.limit ?? 10, 1), 200);
				const where: string[] = [];
				const args: unknown[] = [];
				for (const [param, column] of Object.entries(meta.filters)) {
					const val = (params as Record<string, unknown>)[param];
					if (val !== undefined) {
						args.push(val);
						where.push(`${column} = $${args.length}`);
					}
				}
				if (params.since_id !== undefined) {
					args.push(params.since_id);
					where.push(`id > $${args.length}`); // incremental sync: only newer rows
				}
				args.push(limit);
				const sql =
					`SELECT ${meta.cols.join(", ")} FROM ${meta.table} ` +
					(where.length ? `WHERE ${where.join(" AND ")} ` : "") +
					`ORDER BY id LIMIT $${args.length}`;

				const { rows } = await dbPool().query(sql, args);
				// THE BOUNDARY: mask every row here, before it is returned to the model.
				const masked = rows.map((r) => maskRow(params.entity as Entity, r));
				return {
					content: [{ type: "text", text: JSON.stringify(masked, null, 2) }],
					details: { entity: params.entity, count: masked.length, rows: masked },
				};
			},
		});
	} else {
		pi.registerTool({
			name: "insert_rows",
			label: "Insert Rows",
			description:
				"Insert (already-masked) rows into a bank table in the local test DB (fintechT). " +
				"Insert in dependency order: customers → addresses/accounts → cards/transactions.",
			promptSnippet: "Insert masked rows into a bank table in the local test DB.",
			parameters: InsertParams,
			async execute(_id, params) {
				const meta = SCHEMA[params.entity as Entity];
				const pool = dbPool();
				let inserted = 0;
				for (const row of params.rows) {
					const vals = meta.cols.map((c) => (row as Record<string, unknown>)[c] ?? null);
					const placeholders = meta.cols.map((_, i) => `$${i + 1}`).join(", ");
					await pool.query(
						`INSERT INTO ${meta.table} (${meta.cols.join(", ")}) VALUES (${placeholders}) ` +
							`ON CONFLICT (id) DO NOTHING`,
						vals,
					);
					inserted += 1;
				}
				return {
					content: [{ type: "text", text: `Inserted ${inserted} row(s) into ${meta.table}.` }],
					details: { entity: params.entity, inserted },
				};
			},
		});

		pi.registerTool({
			name: "local_watermark",
			label: "Local Watermark",
			description:
				"Return the highest id currently in a bank table in the local test DB (or 0 if empty). " +
				"Use this as `since_id` when asking prod for new rows, so you only pull what you don't have yet.",
			promptSnippet: "Get the highest id in a local bank table (the incremental-sync watermark).",
			parameters: Type.Object({ entity: entityEnum }),
			async execute(_id, params) {
				const meta = SCHEMA[params.entity as Entity];
				const { rows } = await dbPool().query(`SELECT COALESCE(MAX(id), 0) AS max_id FROM ${meta.table}`);
				const maxId = Number(rows[0].max_id);
				return {
					content: [{ type: "text", text: `${params.entity} watermark (max id) = ${maxId}` }],
					details: { entity: params.entity, max_id: maxId },
				};
			},
		});

		pi.registerTool({
			name: "query_local",
			label: "Query Local",
			description: "Read rows back from a bank table in the local test DB (fintechT).",
			promptSnippet: "Read rows back from a bank table in the local test DB.",
			parameters: QueryLocalParams,
			async execute(_id, params) {
				const meta = SCHEMA[params.entity as Entity];
				const limit = Math.min(Math.max(params.limit ?? 10, 1), 200);
				const { rows } = await dbPool().query(
					`SELECT ${meta.cols.join(", ")} FROM ${meta.table} ORDER BY id LIMIT $1`,
					[limit],
				);
				return {
					content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
					details: { entity: params.entity, count: rows.length, rows },
				};
			},
		});
	}
}
