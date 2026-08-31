#!/usr/bin/env node
/**
 * Incremental (delta) sync: pull only the NEW production rows into test, masked.
 *
 * This is the model-free equivalent of what the test agent does on its own:
 * for each entity, read the local watermark (max id in test), ask prod for rows
 * with a greater id, mask them, and insert. Run it to verify/seed the pipeline
 * without spending model tokens; the live demo uses the agent instead.
 *
 *   node --experimental-strip-types pi/tools/sync-delta.mjs   (or db/sync_delta.sh)
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

	// 1. local watermark — the highest id test already holds
	const wm = Number((await test.query(`SELECT COALESCE(MAX(id),0) AS m FROM ${table}`)).rows[0].m);

	// 2. ask prod only for rows newer than the watermark
	const { rows } = await prod.query(
		`SELECT ${cols.join(", ")} FROM ${table} WHERE id > $1 ORDER BY id`,
		[wm],
	);

	// 3. mask + insert
	const ph = cols.map((_, i) => `$${i + 1}`).join(", ");
	for (const raw of rows) {
		const masked = maskRow(entity, raw);
		await test.query(
			`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${ph}) ON CONFLICT (id) DO NOTHING`,
			cols.map((c) => masked[c] ?? null),
		);
	}
	return { wm, added: rows.length };
}

async function main() {
	console.log("Delta sync: new fintechP rows → fintechT (masked, since local watermark)");
	for (const entity of ENTITY_ORDER) {
		const { wm, added } = await syncEntity(entity);
		console.log(`  ${entity.padEnd(13)} watermark=${String(wm).padStart(5)}  +${added} new masked rows`);
	}
	await prod.end();
	await test.end();
	console.log("Done — test is caught up with production.");
}

main().catch((e) => {
	console.error("sync-delta failed:", e.message);
	process.exit(1);
});
