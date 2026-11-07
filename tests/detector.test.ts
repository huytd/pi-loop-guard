import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";
import { stableStringify, TextRepetitionDetector, ToolLoopDetector, toolSignature } from "../src/detector.ts";

const feed = (d: TextRepetitionDetector, text: string, chunk = 5) => {
	for (let i = 0; i < text.length; i += chunk) {
		const hit = d.push(text.slice(i, i + chunk));
		if (hit) return hit;
	}
	return undefined;
};

describe("stableStringify", () => {
	it("ignores key order", () => {
		assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
	});
});

describe("ToolLoopDetector", () => {
	const sig = (path: string) => toolSignature("read", { path });

	it("flags the same call repeated", () => {
		const d = new ToolLoopDetector({ minRepeats: 3, maxPeriod: 4 });
		assert.equal(d.record(sig("a")), undefined);
		assert.equal(d.record(sig("a")), undefined);
		assert.deepEqual(d.record(sig("a"))?.period, 1);
	});

	it("flags an A B A B A B cycle", () => {
		const d = new ToolLoopDetector({ minRepeats: 3, maxPeriod: 4 });
		const seq = ["a", "b", "a", "b", "a"];
		for (const s of seq) assert.equal(d.record(sig(s)), undefined);
		const hit = d.record(sig("b"));
		assert.equal(hit?.period, 2);
		assert.equal(hit?.repeats, 3);
	});

	it("does not flag progress", () => {
		const d = new ToolLoopDetector({ minRepeats: 3, maxPeriod: 4 });
		for (const s of ["a", "b", "a", "c", "a", "d", "a", "a", "e"]) assert.equal(d.record(sig(s)), undefined);
	});

	it("resets", () => {
		const d = new ToolLoopDetector({ minRepeats: 3, maxPeriod: 4 });
		d.record(sig("a"));
		d.record(sig("a"));
		d.reset();
		assert.equal(d.record(sig("a")), undefined);
	});
});

describe("TextRepetitionDetector", () => {
	const opts = DEFAULT_CONFIG.text;

	it("flags a repeated phrase", () => {
		const hit = feed(new TextRepetitionDetector(opts), "Sure. " + "I will now fix the bug. ".repeat(40));
		assert.equal(hit?.kind, "periodic");
		assert.equal(hit!.unit.length, "I will now fix the bug. ".length);
	});

	it("flags a repeated token", () => {
		assert.equal(feed(new TextRepetitionDetector(opts), "ok " + "the ".repeat(200))?.kind, "periodic");
	});

	it("flags a repeated paragraph", () => {
		const para = `${"Let me re-check the configuration file and see what values are in there. ".repeat(1)}Then I will look at index.ts again to confirm the export is correct.\n\n`;
		assert.equal(feed(new TextRepetitionDetector(opts), para.repeat(6))?.kind, "periodic");
	});

	it("flags a line that keeps coming back with varying text between", () => {
		let text = "";
		for (let i = 0; i < 12; i++) text += `Wait, let me reconsider this.\nMaybe option ${i} works.\n`;
		const hit = feed(new TextRepetitionDetector(opts), text);
		assert.equal(hit?.kind, "line");
	});

	it("ignores short legit runs", () => {
		const text = `| a | b |\n|---|---|\n| 1 | 2 |\n\n${"=".repeat(80)}\n${"Normal prose sentence number ".concat("x. ")}`;
		assert.equal(feed(new TextRepetitionDetector(opts), text), undefined);
	});

	it("ignores ordinary prose and code", () => {
		const text = `
I looked at the failing test. The problem is that \`parseConfig\` returns undefined
when the file is empty, so the caller crashes on \`.tool\`.

\`\`\`ts
export function parseConfig(raw: string) {
  if (!raw.trim()) return {};
  const value = JSON.parse(raw);
  if (typeof value !== "object" || value === null) return {};
  return value;
}
\`\`\`

I also added a test for the empty-file case and ran the suite; all 42 tests pass.
`.repeat(2);
		assert.equal(feed(new TextRepetitionDetector(opts), text), undefined);
	});
});

describe("loadConfig", () => {
	it("returns defaults when no files exist", () => {
		assert.deepEqual(loadConfig(["/nonexistent/loop-guard.json"]).config, DEFAULT_CONFIG);
	});
});
