/**
 * mailbox extension — the symmetric channel between the two agents.
 *
 * IDENTICAL on both agents. Each agent knows its own address from PI_AGENT_ID
 * ("prod" | "test"). Messages live in the shared `mq.messages` table (bus DB), so both
 * agents send and read through the exact same mechanism and can see each other's
 * traffic.
 *
 *   mailbox_send  - INSERT a message addressed to the other agent
 *   mailbox_wait  - long-poll for the next message addressed to me, mark consumed
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { busPool } from "../lib/pg";

const ME = process.env.PI_AGENT_ID ?? "unknown";

const SendParams = Type.Object({
	to: Type.String({ description: "Recipient agent id: 'prod' or 'test'." }),
	body: Type.Unknown({ description: "JSON payload (request or response)." }),
});

const WaitParams = Type.Object({
	timeout_ms: Type.Optional(
		Type.Number({ description: "Max time to wait for a message (default 25000)." }),
	),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "mailbox_send",
		label: "Mailbox Send",
		description:
			"Send a JSON message to the other agent over the shared bus. " +
			"Use to ask 'prod' for data, or (on prod) to return a masked response to 'test'.",
		promptSnippet: "Send a JSON message to the other agent (prod/test) over the shared bus.",
		parameters: SendParams,
		async execute(_id, params) {
			const pool = busPool();
			const { rows } = await pool.query(
				"INSERT INTO mq.messages (sender, recipient, body) VALUES ($1, $2, $3) RETURNING id",
				[ME, params.to, JSON.stringify(params.body)],
			);
			return {
				content: [{ type: "text", text: `Sent message #${rows[0].id} from ${ME} to ${params.to}.` }],
				details: { id: rows[0].id, from: ME, to: params.to },
			};
		},
	});

	pi.registerTool({
		name: "mailbox_wait",
		label: "Mailbox Wait",
		description:
			"Wait for the next message addressed to me and return it. Returns { empty: true } " +
			"if nothing arrives before the timeout. Marks the message consumed.",
		promptSnippet: "Block until the next message addressed to me arrives, then return it.",
		parameters: WaitParams,
		async execute(_id, params, signal) {
			const pool = busPool();
			const timeoutMs = params.timeout_ms ?? 25_000;
			const deadline = Date.now() + timeoutMs;

			// Poll the inbox. FOR UPDATE SKIP LOCKED makes the claim safe even if
			// something else is reading concurrently.
			while (Date.now() < deadline) {
				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Aborted." }], details: { empty: true } };
				}
				const client = await pool.connect();
				try {
					await client.query("BEGIN");
					const { rows } = await client.query(
						`SELECT id, sender, body
						   FROM mq.messages
						  WHERE recipient = $1 AND consumed_at IS NULL
						  ORDER BY id
						  LIMIT 1
						  FOR UPDATE SKIP LOCKED`,
						[ME],
					);
					if (rows.length > 0) {
						const msg = rows[0];
						await client.query("UPDATE mq.messages SET consumed_at = now() WHERE id = $1", [msg.id]);
						await client.query("COMMIT");
						return {
							content: [
								{
									type: "text",
									text: `Message #${msg.id} from ${msg.sender}:\n${JSON.stringify(msg.body, null, 2)}`,
								},
							],
							details: { id: msg.id, from: msg.sender, body: msg.body },
						};
					}
					await client.query("COMMIT");
				} finally {
					client.release();
				}
				await sleep(1_000);
			}

			return {
				content: [{ type: "text", text: "No message arrived before the timeout." }],
				details: { empty: true },
			};
		},
	});
}
