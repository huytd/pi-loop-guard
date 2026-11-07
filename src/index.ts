import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { configPaths, DEFAULT_CONFIG, type LoopGuardConfig, loadConfig } from "./config.ts";
import { TextRepetitionDetector, ToolLoopDetector, toolSignature } from "./detector.ts";

/**
 * Loop Guard: stops the agent when the model gets stuck repeating itself —
 * the same tool call(s) over and over, or degenerate repeated output while
 * streaming. Common with small / heavily quantized local models.
 */
export default function loopGuard(pi: ExtensionAPI): void {
	let config: LoopGuardConfig = structuredClone(DEFAULT_CONFIG);
	let enabled = config.enabled;
	let toolDetector = new ToolLoopDetector(config.tool);
	/** One detector per streamed content block of the current assistant message. */
	let textDetectors = new Map<string, TextRepetitionDetector>();
	let nudgesUsed = 0;
	let stopped = false;
	let lastTrigger: string | undefined;

	const applyConfig = (ctx: ExtensionContext) => {
		const loaded = loadConfig(configPaths(getAgentDir(), ctx.cwd, CONFIG_DIR_NAME, ctx.isProjectTrusted()));
		config = loaded.config;
		enabled = config.enabled;
		toolDetector = new ToolLoopDetector(config.tool);
		textDetectors = new Map();
		for (const err of loaded.errors) report(ctx, `loop-guard: bad config ${err}`, "warning");
	};

	const detectorFor = (key: string, isToolArgs: boolean) => {
		let d = textDetectors.get(key);
		if (!d) {
			d = new TextRepetitionDetector(
				isToolArgs
					? {
							...config.text,
							minRepeatChars: config.text.minRepeatChars * config.text.toolArgsMultiplier,
							// File contents legitimately repeat lines; only flag exact periodic runs.
							lineRepeats: 0,
						}
					: config.text,
			);
			textDetectors.set(key, d);
		}
		return d;
	};

	const stop = (ctx: ExtensionContext, why: string) => {
		if (stopped) return;
		stopped = true;
		lastTrigger = why;
		pi.appendEntry("loop-guard", { reason: why, timestamp: Date.now() });
		report(ctx, `Loop guard stopped the agent: ${why}`, "error");
		ctx.abort();
	};

	pi.on("session_start", (_event, ctx) => {
		applyConfig(ctx);
		nudgesUsed = 0;
		stopped = false;
	});

	// A new user prompt starts a fresh tool-call history.
	pi.on("before_agent_start", () => {
		toolDetector.reset();
		nudgesUsed = 0;
	});

	pi.on("agent_start", () => {
		stopped = false;
	});

	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") textDetectors = new Map();
	});

	pi.on("message_update", (event, ctx) => {
		if (!enabled || stopped || !config.text.enabled) return;
		const e = event.assistantMessageEvent;
		let kind: string;
		if (e.type === "text_delta") kind = "text";
		else if (e.type === "thinking_delta") kind = "thinking";
		else if (e.type === "toolcall_delta" && config.text.scanToolArgs) kind = "tool-call arguments";
		else return;

		const hit = detectorFor(`${kind}:${e.contentIndex}`, kind === "tool-call arguments").push(e.delta);
		if (!hit) return;
		const what =
			hit.kind === "periodic"
				? `"${hit.unit}" repeated ${hit.repeats}+ times in a row`
				: `line "${hit.unit}" repeated ${hit.repeats} times`;
		stop(ctx, `repetitive ${kind}: ${what}`);
	});

	pi.on("tool_call", (event, ctx) => {
		if (!enabled || !config.tool.enabled) return;
		if (stopped) return { block: true, reason: "Loop guard: agent stopped.", terminate: true };

		const loop = toolDetector.record(toolSignature(event.toolName, event.input));
		if (!loop) return;

		const what =
			loop.period === 1
				? `same ${event.toolName} call with identical arguments ${loop.repeats} times in a row`
				: `the same ${loop.period} tool calls (${loop.cycle.map((s) => s.split(" ", 1)[0]).join(" → ")}) repeated ${loop.repeats} times`;

		if (nudgesUsed < config.tool.nudges) {
			nudgesUsed++;
			report(ctx, `Loop guard: blocked a repeated tool call (${what}). Warning the model.`, "warning");
			return {
				block: true,
				reason:
					`Loop guard: you have made ${what}. Repeating it will not give a different result. ` +
					"Stop and take a different approach, or explain what is blocking you and ask the user.",
			};
		}

		stop(ctx, what);
		return { block: true, reason: `Loop guard: stopped the agent — ${what}.`, terminate: true };
	});

	pi.registerCommand("loop-guard", {
		description: "Loop guard: on | off | status | reload",
		getArgumentCompletions: (prefix) => {
			const items = ["on", "off", "status", "reload"]
				.filter((v) => v.startsWith(prefix))
				.map((v) => ({ value: v, label: v }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			switch (args.trim()) {
				case "on":
					enabled = true;
					break;
				case "off":
					enabled = false;
					break;
				case "reload":
					applyConfig(ctx);
					break;
				case "":
				case "status":
					break;
				default:
					ctx.ui.notify("Usage: /loop-guard on | off | status | reload", "warning");
					return;
			}
			const t = config.tool;
			const x = config.text;
			ctx.ui.notify(
				[
					`Loop guard: ${enabled ? "on" : "off"}`,
					`  tool loops: ${t.enabled ? `cycle ≤${t.maxPeriod} calls × ${t.minRepeats}, nudges ${t.nudges}` : "off"}`,
					`  text loops: ${x.enabled ? `unit ≤${x.maxPeriod} chars × ${x.minRepeats} (≥${x.minRepeatChars} chars), line × ${x.lineRepeats}` : "off"}`,
					`  last trigger: ${lastTrigger ?? "none"}`,
				].join("\n"),
				"info",
			);
		},
	});
}

function report(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else console.error(message);
}
