#!/usr/bin/env node
/**
 * Baseline sync: make the TEST database a fully-masked mirror of PRODUCTION.
 *
 * This is the "start both databases in sync" step. It copies every row of every
 * bank table from fintechP to fintechT, running each row through the SAME masking
 * code the production agent uses (lib/mask.ts), in foreign-key order. It is an
 * upsert, so it is safe to re-run.
 *
 * After this, you introduce new rows to prod (db/seed.py --append) and let the
 * PRODUCTION AGENT ship just the new masked rows to test.
 *
 * Run from the repo root via db/sync_baseline.sh, or directly:
 *   node --experimental-strip-types pi/tools/sync-baseline.mjs
 */
import pgPkg from "pg";
import { maskRow } from "../lib/mask.ts";
import { ENTITY_ORDER, TABLE, COLUMNS } from "../lib/schema.ts";

const { Pool } = pgPkg;

const PROD_URL = process.env.MASKER_PROD_URL ?? "postgresql://masker:masker@localhost:5432/fintechP";
const TEST_URL = process.env.MASKER_TEST_URL ?? "postgresql://masker:masker@localhost:5432/fintechT";

const prod = new Pool({ connectionString: PROD_URL });
const test = new Pool({ connectionString: TEST_URL });

async function syncEntity(entity) {
	const cols = COLUMNS[entity];
	const table = TABLE[entity];
	const { rows } = await prod.query(`SELECT ${cols.join(", ")} FROM ${table} ORDER BY id`);

	const ph = cols.map((_, i) => `$${i + 1}`).join(", ");
	const updates = cols.filter((c) => c !== "id").map((c) => `${c} = EXCLUDED.${c}`).join(", ");
	let n = 0;
	for (const raw of rows) {
		const masked = maskRow(entity, raw); // <-- the same boundary the agent uses
		const vals = cols.map((c) => masked[c] ?? null);
		await test.query(
			`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${ph}) ` +
				`ON CONFLICT (id) DO UPDATE SET ${updates}`,
			vals,
		);
		n++;
	}
	return n;
}

async function main() {
	console.log("Baseline sync: fintechP → fintechT (masked, FK order)");
	for (const entity of ENTITY_ORDER) {
		const n = await syncEntity(entity);
		console.log(`  ${entity.padEnd(13)} ${String(n).padStart(5)} rows synced (masked)`);
	}
	await prod.end();
	await test.end();
	console.log("Done — the two databases are now in sync (test holds masked copies).");
}

main().catch((e) => {
	console.error("sync-baseline failed:", e.message);
	process.exit(1);
});
