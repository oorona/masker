/**
 * Postgres connection helpers for the Pi extensions.
 *
 * Two pools, chosen by env so the same extension code works for both agents:
 *   PI_PG_URL  - the agent's own data DB (fintechP for prod, fintechT for test)
 *   PI_BUS_URL - the shared mailbox DB (bus), identical for both agents
 *
 * `pg` is a CommonJS package; import the default export then destructure so this
 * resolves cleanly under Pi's jiti loader.
 */
import pgPkg from "pg";

const { Pool } = pgPkg;
type PoolType = InstanceType<typeof Pool>;

let dataPool: PoolType | undefined;
let busPoolInstance: PoolType | undefined;

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`${name} is not set. Export it from the agent's run.sh.`);
	}
	return value;
}

/** Pool for the agent's own data database (PI_PG_URL). */
export function dbPool(): PoolType {
	if (!dataPool) {
		dataPool = new Pool({ connectionString: requireEnv("PI_PG_URL"), max: 4 });
	}
	return dataPool;
}

/** Pool for the shared mailbox database (PI_BUS_URL). */
export function busPool(): PoolType {
	if (!busPoolInstance) {
		busPoolInstance = new Pool({ connectionString: requireEnv("PI_BUS_URL"), max: 4 });
	}
	return busPoolInstance;
}
