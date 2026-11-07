# pi-loop-guard

A [pi coding agent](https://pi.dev) extension that stops the agent when the model gets stuck in a loop. This happens often with small or heavily quantized local models.

It catches two kinds of loop:

| Loop | Example | How it's detected |
|------|---------|-------------------|
| **Tool-call loop** | `read package.json` → `read package.json` → `read package.json`, or `edit X` → `bash test` → `edit X` → `bash test` … | Each call is reduced to its tool name plus its arguments, with keys sorted. If the most recent calls form one cycle of 1–4 calls repeated 3 times, the call that completes the 3rd repeat is blocked before it runs, and the agent is stopped. |
| **Repetitive output** | `I will now fix the bug. I will now fix the bug. I will now fix the bug. …` in text or thinking | While the model streams, the guard checks whether the end of the output is one unit (1–1000 chars) repeated at least 3 times over at least 300 chars. It also flags any line (12+ chars) that appears 8 times within 60 lines. The stream is aborted, which closes the HTTP request, so llama.cpp and similar servers stop generating too. |

Streamed tool-call arguments, such as a file being written, are scanned too, but with 4× the character threshold and no line check, because file contents often repeat lines legitimately.

The tool-call history resets on every new user prompt.

## Install

```bash
# global, auto-discovered (hot-reload with /reload)
ln -s ~/code/pi-loop-guard ~/.pi/agent/extensions/pi-loop-guard

# or just try it once
pi -e ~/code/pi-loop-guard/src/index.ts
```

pi loads the TypeScript source directly, so there is no build step.

## Commands

`/loop-guard [status|on|off|reload]` shows the current settings and the last trigger, turns the guard on or off for the session, or reloads the config.

## Config

Optional. Put a `loop-guard.json` in `~/.pi/agent/`. For trusted projects you can also put one in `<project>/.pi/`, which overrides the global file. Only include the keys you want to change. The defaults are:

```json
{
  "enabled": true,
  "tool": {
    "enabled": true,
    "minRepeats": 3,
    "maxPeriod": 4,
    "nudges": 0
  },
  "text": {
    "enabled": true,
    "minRepeats": 3,
    "minRepeatChars": 300,
    "maxPeriod": 1000,
    "lineRepeats": 8,
    "minLineLength": 12,
    "lineWindow": 60,
    "checkEvery": 32,
    "scanToolArgs": true,
    "toolArgsMultiplier": 4
  }
}
```

- `tool.nudges`: the number of times to block the looping call and tell the model it is looping before stopping the agent. For example, `1` gives the model one chance to change course.
- `tool.minRepeats`: raise this if you legitimately repeat the same command, such as a polling `bash` call.
- `text.lineRepeats`: set to `0` to turn off the line check.

## Notes

- When the guard stops a text loop, the repeated text stays in the session. If you just say "continue", the model may start looping again. Use `/tree` or `/fork` to branch from before the loop, or tell the model what to do differently.
- Each trigger is recorded in the session as a `loop-guard` custom entry, which is not sent to the model.

## Development

```bash
npm install
npm test          # detector unit tests (node --test, no build)
npm run typecheck
```
