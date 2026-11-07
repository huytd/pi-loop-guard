/**
 * Pure loop-detection logic. No pi imports, so it can be unit tested directly.
 */

export interface ToolLoopOptions {
	/** How many times a cycle must repeat back-to-back to count as a loop. */
	minRepeats: number;
	/** Longest cycle to look for, in tool calls (1 = same call over and over). */
	maxPeriod: number;
}

export interface ToolLoop {
	period: number;
	repeats: number;
	/** Signatures of one cycle, oldest first. */
	cycle: string[];
}

export interface TextRepetitionOptions {
	/** Minimum number of back-to-back copies of the repeated unit. */
	minRepeats: number;
	/** Minimum total length of the repeated span, so short runs like "----" are ignored. */
	minRepeatChars: number;
	/** Longest repeated unit to look for, in characters. */
	maxPeriod: number;
	/** Same (trimmed) line seen this many times in the recent window. 0 disables. */
	lineRepeats: number;
	/** Lines shorter than this are ignored by the line check. */
	minLineLength: number;
	/** How many recent lines the line check looks at. */
	lineWindow: number;
	/** Run the (more expensive) periodic check after this many new characters. */
	checkEvery: number;
}

export interface TextRepetition {
	kind: "periodic" | "line";
	/** The repeated unit (truncated for display). */
	unit: string;
	repeats: number;
}

/** JSON.stringify with recursively sorted object keys, so arg order does not matter. */
export function stableStringify(value: unknown): string {
	return JSON.stringify(value, (_key, v) => {
		if (v && typeof v === "object" && !Array.isArray(v)) {
			return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
		}
		return v;
	});
}

export function toolSignature(toolName: string, input: unknown): string {
	return `${toolName} ${stableStringify(input)}`;
}

/**
 * Tracks the sequence of tool calls in an agent run and reports when the tail of
 * that sequence is one cycle (A A A, or A B A B A B, ...) repeated `minRepeats` times.
 */
export class ToolLoopDetector {
	private history: string[] = [];
	private readonly opts: ToolLoopOptions;

	constructor(opts: ToolLoopOptions) {
		this.opts = opts;
	}

	record(signature: string): ToolLoop | undefined {
		this.history.push(signature);
		const keep = this.opts.maxPeriod * this.opts.minRepeats;
		if (this.history.length > keep * 2) this.history = this.history.slice(-keep);
		return this.check();
	}

	reset(): void {
		this.history = [];
	}

	private check(): ToolLoop | undefined {
		const h = this.history;
		const n = h.length;
		for (let p = 1; p <= this.opts.maxPeriod && p * this.opts.minRepeats <= n; p++) {
			// Length of the longest suffix of h that has period p.
			let len = p;
			while (len < n && h[n - 1 - len] === h[n - 1 - len + p]) len++;
			const repeats = Math.floor(len / p);
			if (repeats >= this.opts.minRepeats) {
				return { period: p, repeats, cycle: h.slice(n - p) };
			}
		}
		return undefined;
	}
}

/**
 * Watches a stream of text deltas and reports degenerate repetition:
 * - periodic: the tail of the stream is some unit repeated back-to-back
 *   (catches "foo foo foo ..." and whole paragraphs repeated verbatim)
 * - line: the same non-trivial line keeps coming back within a short window
 *   (catches loops where the lines in between vary slightly)
 */
export class TextRepetitionDetector {
	private buf = "";
	private sinceCheck = 0;
	private partialLine = "";
	private inFence = false;
	/** Recent lines; null for lines the line check skipped (short or code). */
	private recentLines: (string | null)[] = [];
	private lineCounts = new Map<string, number>();
	private readonly window: number;
	private readonly opts: TextRepetitionOptions;

	constructor(opts: TextRepetitionOptions) {
		this.opts = opts;
		this.window = Math.max(opts.maxPeriod * opts.minRepeats, opts.minRepeatChars) + opts.checkEvery;
	}

	push(delta: string): TextRepetition | undefined {
		if (!delta) return undefined;
		this.buf += delta;
		if (this.buf.length > this.window * 2) this.buf = this.buf.slice(-this.window);

		const line = this.pushLines(delta);
		if (line) return line;

		this.sinceCheck += delta.length;
		if (this.sinceCheck < this.opts.checkEvery) return undefined;
		this.sinceCheck = 0;
		return this.checkPeriodic();
	}

	reset(): void {
		this.buf = "";
		this.sinceCheck = 0;
		this.partialLine = "";
		this.inFence = false;
		this.recentLines = [];
		this.lineCounts.clear();
	}

	private checkPeriodic(): TextRepetition | undefined {
		const s = this.buf;
		const n = s.length;
		const { minRepeats, minRepeatChars, maxPeriod } = this.opts;
		for (let p = 1; p <= maxPeriod && p * minRepeats <= n; p++) {
			const need = Math.max(p * minRepeats, minRepeatChars);
			if (need > n) continue;
			// Does the last `need` chars have period p? Compare from the end so
			// non-repetitive text bails out after a character or two.
			let ok = true;
			for (let i = n - 1; i >= n - need + p; i--) {
				if (s.charCodeAt(i) !== s.charCodeAt(i - p)) {
					ok = false;
					break;
				}
			}
			if (ok) {
				const unit = s.slice(n - p);
				return { kind: "periodic", unit: truncate(unit), repeats: Math.floor(need / p) };
			}
		}
		return undefined;
	}

	private pushLines(delta: string): TextRepetition | undefined {
		if (this.opts.lineRepeats <= 0) return undefined;
		const parts = (this.partialLine + delta).split("\n");
		this.partialLine = parts.pop() ?? "";
		for (const raw of parts) {
			const line = raw.trim().replace(/\s+/g, " ");
			const fence = /^(```|~~~)/.test(line);
			if (fence) this.inFence = !this.inFence;
			// Code legitimately repeats lines (`#[serde(default)]`, `}`, `if err != nil {`),
			// so only prose counts. Exact repeated code is still caught by the periodic check.
			const counted =
				!fence && !this.inFence && line.length >= this.opts.minLineLength && looksLikeProse(raw, line);
			this.recentLines.push(counted ? line : null);
			if (counted) {
				const count = (this.lineCounts.get(line) ?? 0) + 1;
				this.lineCounts.set(line, count);
				if (count >= this.opts.lineRepeats) {
					return { kind: "line", unit: truncate(line), repeats: count };
				}
			}
			if (this.recentLines.length > this.opts.lineWindow) {
				const old = this.recentLines.shift();
				const c = old == null ? undefined : this.lineCounts.get(old);
				if (old != null && c !== undefined) {
					if (c <= 1) this.lineCounts.delete(old);
					else this.lineCounts.set(old, c - 1);
				}
			}
		}
		return undefined;
	}
}

/**
 * Rough test for a natural-language line, as opposed to unfenced code: not
 * indented, no code punctuation, and mostly plain words.
 */
function looksLikeProse(raw: string, line: string): boolean {
	if (/^(\t| {2,})(?![-*+] |\d+\. )/.test(raw)) return false;
	if (/[{}[\];=]|::|->|^[#@/]/.test(line)) return false;
	const tokens = line.split(" ");
	const words = tokens.filter((t) => /^[("'`]*[A-Za-z][\w'’.-]*[)"'`,.!?:…]*$/.test(t)).length;
	return words >= 3 && words / tokens.length >= 0.75;
}

function truncate(s: string, max = 80): string {
	const flat = JSON.stringify(s).slice(1, -1);
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
