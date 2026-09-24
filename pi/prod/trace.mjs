#!/usr/bin/env node
/**
 * Pretty-prints the production agent's JSON event stream so you can SEE what it
 * is doing each cycle: its thinking, every tool call with arguments, every tool
 * result, and its narration — all before the masked data goes back to test.
 *
 * Usage:  pi --mode json "..." 2>/dev/null | node trace.mjs
 *
 * Every event line is also forwarded to the bus monitor UI (pi/ui) so the same trace
 * shows up in the browser. Set MASKER_UI_URL=off to disable; failures are silent.
 */
import readline from "node:readline";

const UI_URL = process.env.MASKER_UI_URL ?? "http://127.0.0.1:5055/trace";
const FORWARDED = new Set(["agent_start", "tool_execution_start", "tool_execution_end", "message_end", "agent_end"]);

function forward(line, e) {
	if (UI_URL === "off" || !FORWARDED.has(e.type)) return;
	if (e.type === "message_end" && e.message?.role !== "assistant") return;
	fetch(UI_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: line }).catch(() => {});
}

const C = {
	dim: (s) => `\x1b[2m${s}\x1b[0m`,
	cyan: (s) => `\x1b[36m${s}\x1b[0m`,
	green: (s) => `\x1b[32m${s}\x1b[0m`,
	yellow: (s) => `\x1b[33m${s}\x1b[0m`,
	red: (s) => `\x1b[31m${s}\x1b[0m`,
	mag: (s) => `\x1b[35m${s}\x1b[0m`,
	bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function clip(s, n = 600) {
	s = String(s ?? "");
	return s.length > n ? s.slice(0, n) + C.dim(` …(+${s.length - n} chars)`) : s;
}

function compactArgs(args) {
	try {
		const j = JSON.stringify(args);
		return clip(j, 400);
	} catch {
		return String(args);
	}
}

function summarizeResult(result, isError) {
	const d = result?.details;
	if (d && typeof d === "object") {
		if (typeof d.count === "number") return `${d.count} row(s) [masked]`;
		if (d.id && d.to) return `message #${d.id} → ${d.to}`;
		if (d.from !== undefined && d.body !== undefined) {
			return `message #${d.id} from ${d.from}: ${clip(JSON.stringify(d.body), 300)}`;
		}
		if (d.empty) return "no message (idle)";
	}
	const text = result?.content?.find?.((c) => c.type === "text")?.text;
	return clip(text ?? JSON.stringify(result), 300);
}

function parts(message, kind) {
	const out = [];
	for (const c of message?.content ?? []) {
		if (kind === "thinking" && (c.type === "thinking" || c.type === "reasoning")) {
			out.push(c.thinking ?? c.text ?? "");
		}
		if (kind === "text" && c.type === "text") out.push(c.text ?? "");
	}
	return out.filter((s) => s && s.trim());
}

const ts = () => new Date().toLocaleTimeString();
const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
	let e;
	try {
		e = JSON.parse(line);
	} catch {
		return;
	}
	forward(line, e);
	switch (e.type) {
		case "agent_start":
			console.log("\n" + C.dim("─".repeat(70)));
			console.log(C.bold(C.mag(`[prod] ${ts()} — handling a cycle`)));
			break;
		case "tool_execution_start":
			console.log(`${C.cyan("🔧 " + e.toolName)}  ${C.dim(compactArgs(e.args))}`);
			break;
		case "tool_execution_end": {
			const tag = e.isError ? C.red("✗") : C.green("✓");
			console.log(`   ${tag} ${C.dim(summarizeResult(e.result, e.isError))}`);
			break;
		}
		case "message_end": {
			if (e.message?.role !== "assistant") break;
			for (const t of parts(e.message, "thinking")) {
				console.log(C.yellow("💭 thinking: ") + C.dim(clip(t, 800)));
			}
			for (const t of parts(e.message, "text")) {
				console.log(C.green("💬 ") + clip(t, 800));
			}
			break;
		}
		case "agent_end":
			console.log(C.dim(`[prod] ${ts()} — cycle done`));
			break;
	}
});
