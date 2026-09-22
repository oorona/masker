#!/usr/bin/env python3
"""Seed the PRODUCTION database (fintechP) with a realistic, related fintech dataset.

Generates a connected graph of fake-but-realistic data across the whole bank schema:

    customers ──┬── addresses
                ├── accounts ──┬── cards
                │              └── transactions

All data is fake (Faker) but realistically shaped: real-looking SSNs, Luhn-valid
card numbers, 9-digit account/routing numbers. This is the sensitive data the
production agent must mask before any of it leaves its process.

fintechT is intentionally left EMPTY — it only fills with masked rows the test
agent pulls across the bus.

Usage:
    pip install -r db/requirements.txt
    python db/seed.py                 # ~80 customers and everything hanging off them
    python db/seed.py --customers 200
"""
from __future__ import annotations

import argparse
import os
import random
from datetime import datetime, timedelta

import psycopg
from faker import Faker

PROD_URL = os.environ.get(
    "MASKER_PROD_URL",
    "postgresql://masker:masker@localhost:5432/fintechP",
)

MERCHANT_CATEGORIES = {
    "Amazon": "shopping", "Whole Foods": "groceries", "Shell": "fuel",
    "Netflix": "subscriptions", "Uber": "transport", "Starbucks": "dining",
    "Delta Air Lines": "travel", "CVS Pharmacy": "health", "Home Depot": "home",
    "Spotify": "subscriptions", "Target": "shopping", "Chipotle": "dining",
}


def luhn_card_number(prefix: int) -> str:
    """16-digit number passing the Luhn check, starting from `prefix`."""
    digits = [int(c) for c in str(prefix)]
    digits += [random.randint(0, 9) for _ in range(15 - len(digits))]

    def checksum(partial: list[int]) -> int:
        total = 0
        for i, d in enumerate(reversed(partial)):
            if i % 2 == 0:
                d *= 2
                if d > 9:
                    d -= 9
            total += d
        return total

    digits.append((10 - (checksum(digits) % 10)) % 10)
    return "".join(str(d) for d in digits)


CARD_BRANDS = [("visa", 4), ("mastercard", 5), ("amex", 37)]


class Ids:
    """Hands out monotonic ids per table, continuing from an optional starting map."""

    def __init__(self, start: dict[str, int] | None = None) -> None:
        self.counters: dict[str, int] = dict(start or {})

    def next(self, table: str) -> int:
        self.counters[table] = self.counters.get(table, 0) + 1
        return self.counters[table]


def build_dataset(fake: Faker, n_customers: int, start: dict[str, int] | None = None) -> dict[str, list[dict]]:
    ids = Ids(start)
    customers, addresses, accounts, cards, transactions = [], [], [], [], []

    for _ in range(n_customers):
        cid = ids.next("customers")
        first, last = fake.first_name(), fake.last_name()
        cust = {
            "id": cid,
            "first_name": first,
            "last_name": last,
            "email": f"{first}.{last}@{fake.free_email_domain()}".lower(),
            "phone": fake.phone_number(),
            "ssn": fake.ssn(),
            "date_of_birth": fake.date_of_birth(minimum_age=18, maximum_age=85),
            "created_at": fake.date_time_between(start_date="-6y", end_date="now"),
        }
        customers.append(cust)

        for _ in range(random.randint(1, 2)):
            addresses.append({
                "id": ids.next("addresses"),
                "customer_id": cid,
                "line1": fake.street_address(),
                "line2": random.choice([None, None, f"Apt {random.randint(1, 40)}"]),
                "city": fake.city(),
                "state": fake.state_abbr(),
                "postal_code": fake.postcode(),
                "country": "US",
            })

        for _ in range(random.randint(1, 3)):
            aid = ids.next("accounts")
            opened = fake.date_time_between(start_date="-6y", end_date="-1m")
            accounts.append({
                "id": aid,
                "customer_id": cid,
                "account_number": "".join(str(random.randint(0, 9)) for _ in range(9)),
                "routing_number": "".join(str(random.randint(0, 9)) for _ in range(9)),
                "account_type": random.choice(["checking", "savings", "credit"]),
                "balance": round(random.uniform(-2_000, 120_000), 2),
                "currency": "USD",
                "status": random.choice(["active", "active", "active", "frozen", "closed"]),
                "opened_at": opened,
            })

            for _ in range(random.randint(0, 2)):
                brand, prefix = random.choice(CARD_BRANDS)
                cards.append({
                    "id": ids.next("cards"),
                    "account_id": aid,
                    "card_number": luhn_card_number(prefix),
                    "cardholder_name": f"{cust['first_name']} {cust['last_name']}".upper(),
                    "brand": brand,
                    "expiry_month": random.randint(1, 12),
                    "expiry_year": random.randint(2026, 2031),
                    "cvv": "".join(str(random.randint(0, 9)) for _ in range(3)),
                    "status": random.choice(["active", "active", "frozen"]),
                })

            for _ in range(random.randint(5, 20)):
                merchant = random.choice(list(MERCHANT_CATEGORIES))
                occurred = opened + timedelta(
                    seconds=random.randint(0, int((datetime.now() - opened.replace(tzinfo=None)).total_seconds())),
                )
                transactions.append({
                    "id": ids.next("transactions"),
                    "account_id": aid,
                    "occurred_at": occurred,
                    "amount": round(random.uniform(1.5, 1_200), 2),
                    "direction": random.choice(["debit", "debit", "debit", "credit"]),
                    "merchant": merchant,
                    "category": MERCHANT_CATEGORIES[merchant],
                    "description": f"{merchant} purchase",
                })

    return {
        "customers": customers, "addresses": addresses, "accounts": accounts,
        "cards": cards, "transactions": transactions,
    }


COLUMNS = {
    "customers": ["id", "first_name", "last_name", "email", "phone", "ssn", "date_of_birth", "created_at"],
    "addresses": ["id", "customer_id", "line1", "line2", "city", "state", "postal_code", "country"],
    "accounts": ["id", "customer_id", "account_number", "routing_number", "account_type",
                 "balance", "currency", "status", "opened_at"],
    "cards": ["id", "account_id", "card_number", "cardholder_name", "brand",
              "expiry_month", "expiry_year", "cvv", "status"],
    "transactions": ["id", "account_id", "occurred_at", "amount", "direction",
                     "merchant", "category", "description"],
}


TABLES = ["customers", "addresses", "accounts", "cards", "transactions"]


def current_max_ids(cur) -> dict[str, int]:
    start: dict[str, int] = {}
    for table in TABLES:
        cur.execute(f"SELECT COALESCE(MAX(id), 0) FROM bank.{table}")
        start[table] = cur.fetchone()[0]
    return start


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed (or append to) fintechP with a related dataset.")
    parser.add_argument("--customers", type=int, default=80, help="number of customers to generate")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--append", action="store_true",
                        help="add NEW customers (ids continue from the current max) without wiping prod")
    args = parser.parse_args()

    # In append mode vary the RNG so new rows differ from the baseline batch.
    seed = args.seed + (1000 if args.append else 0)
    random.seed(seed)
    Faker.seed(seed)
    fake = Faker("en_US")

    with psycopg.connect(PROD_URL) as conn:
        with conn.cursor() as cur:
            if args.append:
                start = current_max_ids(cur)
                data = build_dataset(fake, args.customers, start)
            else:
                cur.execute("TRUNCATE bank.transactions, bank.cards, bank.accounts, "
                            "bank.addresses, bank.customers RESTART IDENTITY CASCADE")
                data = build_dataset(fake, args.customers)

            for table in TABLES:
                cols = COLUMNS[table]
                placeholders = ", ".join(f"%({c})s" for c in cols)
                cur.executemany(
                    f"INSERT INTO bank.{table} ({', '.join(cols)}) VALUES ({placeholders})",
                    data[table],
                )
        conn.commit()

    verb = "Appended to" if args.append else "Seeded"
    print(f"{verb} fintechP (bank schema):")
    for table in TABLES:
        rows = data[table]
        id_range = f"ids {rows[0]['id']}–{rows[-1]['id']}" if rows else "no new rows"
        print(f"  bank.{table:<13} {len(rows):>5} new rows  ({id_range})")
    if data["customers"]:
        s = data["customers"][0]
        print("Sample customer (RAW, sensitive):")
        print(f"  {s['first_name']} {s['last_name']} | {s['email']} | ssn={s['ssn']} | dob={s['date_of_birth']}")


if __name__ == "__main__":
    main()
