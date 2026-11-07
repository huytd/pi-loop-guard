import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TextRepetitionOptions, ToolLoopOptions } from "./detector.ts";

export interface LoopGuardConfig {
	enabled: boolean;
	tool: ToolLoopOptions & {
		enabled: boolean;
		/**
		 * Times to block the looping call with a warning to the model before
		 * stopping the agent. 0 = stop on first detection.
		 */
		nudges: number;
	};
	text: TextRepetitionOptions & {
		enabled: boolean;
		/** Also scan streamed tool-call arguments (with relaxed thresholds). */
		scanToolArgs: boolean;
		/** minRepeatChars is multiplied by this for tool-call arguments. */
		toolArgsMultiplier: number;
	};
}

export const DEFAULT_CONFIG: LoopGuardConfig = {
	enabled: true,
	tool: {
		enabled: true,
		minRepeats: 3,
		maxPeriod: 4,
		nudges: 0,
	},
	text: {
		enabled: true,
		minRepeats: 3,
		minRepeatChars: 300,
		maxPeriod: 1000,
		lineRepeats: 8,
		minLineLength: 12,
		lineWindow: 60,
		checkEvery: 32,
		scanToolArgs: true,
		toolArgsMultiplier: 4,
	},
};

export const CONFIG_FILE = "loop-guard.json";

/**
 * Merge the global config (<agentDir>/loop-guard.json) and, for trusted
 * projects, the project config (<cwd>/<configDir>/loop-guard.json) over the defaults.
 */
export function loadConfig(paths: string[]): { config: LoopGuardConfig; errors: string[] } {
	let config = structuredClone(DEFAULT_CONFIG);
	const errors: string[] = [];
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			config = merge(config, JSON.parse(readFileSync(path, "utf8")));
		} catch (err) {
			errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return { config, errors };
}

export function configPaths(agentDir: string, cwd: string, configDirName: string, projectTrusted: boolean): string[] {
	const paths = [join(agentDir, CONFIG_FILE)];
	if (projectTrusted) paths.push(join(cwd, configDirName, CONFIG_FILE));
	return paths;
}

function merge<T>(base: T, override: unknown): T {
	if (!isPlainObject(base) || !isPlainObject(override)) {
		return (override === undefined || typeof override !== typeof base ? base : override) as T;
	}
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (key in out) out[key] = merge(out[key], value);
	}
	return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
