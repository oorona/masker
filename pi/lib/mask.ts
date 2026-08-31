/**
 * The masking control — the single, auditable choke point, now per-entity.
 *
 * Pure functions: no DB, no network, no model. The production agent's data tool
 * runs every row through `maskRow(entity, row)` before returning, so the model
 * never sees raw PII and cannot leak it. Each table masks only its sensitive
 * columns; non-sensitive columns (balances, dates, categories) pass through so
 * the test side still gets realistically-shaped data.
 *
 * Masked values stay insert-compatible with the same column types (e.g. a masked
 * date_of_birth is still a valid DATE: the year is kept, month/day zeroed).
 */

export type Entity = "customers" | "addresses" | "accounts" | "cards" | "transactions";

export const ENTITIES: Entity[] = ["customers", "addresses", "accounts", "cards", "transactions"];

type Row = Record<string, unknown>;

const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");

/** Keep the last `keep` digits, star the rest (length-preserving on the digits). */
function tail(v: unknown, keep: number): string {
	const d = digits(v);
	if (d.length <= keep) return "*".repeat(d.length);
	return "*".repeat(d.length - keep) + d.slice(-keep);
}

function maskEmail(v: unknown): string {
	const [name, domain] = String(v ?? "").split("@");
	return name && domain ? `${name[0]}***@${domain}` : "***@***";
}

function yearOnly(v: unknown): string {
	const y = new Date(String(v)).getFullYear();
	return Number.isFinite(y) ? `${y}-01-01` : "1900-01-01";
}

const MASKERS: Record<Entity, (row: Row) => Row> = {
	customers: (r) => ({
		...r,
		last_name: r.last_name ? `${String(r.last_name)[0]}***` : "***",
		email: maskEmail(r.email),
		phone: `***-***-${tail(r.phone, 4).slice(-4)}`,
		ssn: `***-**-${digits(r.ssn).slice(-4) || "****"}`,
		date_of_birth: yearOnly(r.date_of_birth), // keep year only (age band)
	}),
	addresses: (r) => ({
		...r,
		line1: "**** [redacted]",
		line2: r.line2 ? "***" : null,
		postal_code: `${String(r.postal_code ?? "").slice(0, 2)}***`,
		// city, state, country kept (coarse geo, not identifying on their own)
	}),
	accounts: (r) => ({
		...r,
		account_number: `****${tail(r.account_number, 4).slice(-4)}`,
		routing_number: `****${tail(r.routing_number, 4).slice(-4)}`,
		// balance, account_type, currency, status, opened_at kept
	}),
	cards: (r) => {
		const d = digits(r.card_number);
		return {
			...r,
			card_number: d.length >= 8 ? `${d.slice(0, 4)} **** **** ${d.slice(-4)}` : "**** **** **** ****",
			cardholder_name: r.cardholder_name
				? `${String(r.cardholder_name).split(/\s+/)[0]} ***`
				: "*** ***",
			cvv: "***",
			// brand, expiry_month, expiry_year, status kept
		};
	},
	// Transactions carry no direct identifiers — pass through unchanged.
	transactions: (r) => ({ ...r }),
};

export function maskRow(entity: Entity, row: Row): Row {
	const fn = MASKERS[entity];
	if (!fn) throw new Error(`Unknown entity: ${entity}`);
	return fn(row);
}
