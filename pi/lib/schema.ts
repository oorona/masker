/**
 * Shared bank-schema metadata: the single source of truth for table names,
 * column order, and how each entity is scoped/joined. Imported by the bank-db
 * extension and by the sync tooling so they can never drift apart.
 */
import type { Entity } from "./mask";

export const ENTITY_ORDER: Entity[] = ["customers", "addresses", "accounts", "cards", "transactions"];

export const TABLE: Record<Entity, string> = {
	customers: "bank.customers",
	addresses: "bank.addresses",
	accounts: "bank.accounts",
	cards: "bank.cards",
	transactions: "bank.transactions",
};

export const COLUMNS: Record<Entity, string[]> = {
	customers: ["id", "first_name", "last_name", "email", "phone", "ssn", "date_of_birth", "created_at"],
	addresses: ["id", "customer_id", "line1", "line2", "city", "state", "postal_code", "country"],
	accounts: ["id", "customer_id", "account_number", "routing_number", "account_type",
		"balance", "currency", "status", "opened_at"],
	cards: ["id", "account_id", "card_number", "cardholder_name", "brand",
		"expiry_month", "expiry_year", "cvv", "status"],
	transactions: ["id", "account_id", "occurred_at", "amount", "direction", "merchant", "category", "description"],
};

// Which request parameter scopes each entity, and the column it maps to.
export const FILTERS: Record<Entity, Record<string, string>> = {
	customers: { customer_id: "id" },
	addresses: { customer_id: "customer_id" },
	accounts: { customer_id: "customer_id" },
	cards: { account_id: "account_id" },
	transactions: { account_id: "account_id" },
};
