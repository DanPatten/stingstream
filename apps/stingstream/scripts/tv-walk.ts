#!/usr/bin/env bun
/**
 * tv-walk — replay a D-pad sequence on the Android TV emulator and capture it.
 *
 * The TV build cannot be checked the way the web build is: there is no DOM to
 * query, no accessibility tree worth reading over adb, and the acceptance
 * criteria are about *focus* — which element is lit, whether RIGHT out of the
 * rail lands on content, whether a screen can be left at all. All of that is
 * visible in a screenshot and in nothing else, so the loop is: press a key,
 * wait for the focus animation to settle, grab the framebuffer, look.
 *
 * Usage
 * -----
 *   bun scripts/tv-walk.ts --flow tv-flow.json --out ../../.win-temp/ui-loop/wp-tv-shell/shots/pass-01
 *   bun scripts/tv-walk.ts --flow flow.json --out shots --serial emulator-5556 --meminfo
 *   bun scripts/tv-walk.ts --keys 20,20,23 --screen home --out shots
 *
 * Options
 * -------
 *   --flow <path>     JSON file: [{ screen, keys, settleMs?, note? }, ...]
 *   --keys <list>     A single ad-hoc step: comma-separated Android keycodes.
 *   --screen <name>   Name for the ad-hoc step. Default "walk".
 *   --out <dir>       Where the PNGs go. Created if absent. Required.
 *   --serial <id>     adb device. Default $ANDROID_SERIAL or emulator-5556.
 *   --package <id>    App package for meminfo. Default org.stingstream.app.
 *   --settle <ms>     Default settle time per key. Default 600.
 *   --meminfo         Record dumpsys meminfo before and after the whole run.
 *   --launch <url>    Deep link to open before the first step.
 *   --logcat          Dump `adb logcat -d *:E` to the output directory at the end.
 *
 * A flow file is a list of steps; each step is a screen name and the keys that
 * get you through it. One PNG per key press, named
 * `<index>-<screen>-<keyname>.png`, so the sequence reads in file order and a
 * regression is a diff of two directories.
 *
 * Keycodes worth knowing (`adb shell input keyevent <n>`):
 *   19 UP · 20 DOWN · 21 LEFT · 22 RIGHT · 23 CENTER/OK · 4 BACK · 3 HOME
 *   82 MENU · 85 PLAY_PAUSE · 89 REWIND · 90 FAST_FORWARD
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface WalkStep {
  /** Screen this step is walking, used in the capture filenames. */
  screen: string;
  /** Android keycodes, in order. */
  keys: number[];
  /** Milliseconds to wait after each key before capturing. */
  settleMs?: number;
  /** Free text, echoed to the console so a long flow is readable as it runs. */
  note?: string;
}

const KEY_NAMES: Record<number, string> = {
  0: "wait",
  3: "home",
  4: "back",
  19: "up",
  20: "down",
  21: "left",
  22: "right",
  23: "ok",
  66: "enter",
  82: "menu",
  85: "playpause",
  89: "rewind",
  90: "forward",
  111: "escape",
};

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const exact = args.indexOf(`--${name}`);
  if (exact !== -1) {
    const next = args[exact + 1];
    return next && !next.startsWith("--") ? next : "true";
  }
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

const SERIAL = flag("serial") ?? process.env.ANDROID_SERIAL ?? "emulator-5556";
const PACKAGE = flag("package") ?? "org.stingstream.app";
const OUT = flag("out");
const DEFAULT_SETTLE = Number(flag("settle") ?? 600);
const WANT_MEMINFO = flag("meminfo") === "true";
const WANT_LOGCAT = flag("logcat") === "true";
const LAUNCH = flag("launch");

if (!OUT) {
  console.error("tv-walk: --out <dir> is required");
  process.exit(2);
}

const outDir = resolve(OUT);
mkdirSync(outDir, { recursive: true });

/** adb, with the serial already applied. Text output. */
function adb(...argv: string[]): string {
  const result = spawnSync("adb", ["-s", SERIAL, ...argv], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `adb ${argv.join(" ")} failed (${result.status}): ${result.stderr}`,
    );
  }
  return result.stdout;
}

/**
 * A framebuffer grab.
 *
 * `exec-out` rather than `shell`, and a Buffer rather than a string: `shell`
 * translates LF to CRLF on some devices and corrupts every PNG it touches,
 * which is a mistake you only make once.
 */
function screencap(file: string): void {
  const result = spawnSync(
    "adb",
    ["-s", SERIAL, "exec-out", "screencap", "-p"],
    {
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`screencap failed (${result.status})`);
  }
  writeFileSync(file, result.stdout);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Total PSS in kB, from `dumpsys meminfo`. */
function totalPssKb(): number | null {
  try {
    const out = adb("shell", "dumpsys", "meminfo", PACKAGE);
    const match = out.match(/TOTAL(?:\s+PSS)?:\s+(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * The shape `tools/ui-shots/tv-flow.json` is written in: named keys, grouped
 * per screen. It is the file the loop actually maintains, so this reads it as
 * well as the flat array, rather than making somebody keep two of them.
 */
interface NamedFlow {
  keys: Record<string, number>;
  screens: Array<{
    id: string;
    steps: Array<{ keys: string[]; settleMs?: number; note?: string }>;
  }>;
}

function isNamedFlow(value: unknown): value is NamedFlow {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as NamedFlow).screens) &&
    typeof (value as NamedFlow).keys === "object"
  );
}

function flattenNamedFlow(flow: NamedFlow): WalkStep[] {
  return flow.screens.flatMap((screen) =>
    screen.steps
      .map((step) => ({
        screen: screen.id,
        keys: step.keys.map((name) => {
          const code = flow.keys[name];
          if (code === undefined) {
            throw new Error(`unknown key name "${name}" in ${screen.id}`);
          }
          return code;
        }),
        settleMs: step.settleMs,
        note: step.note,
      }))
      // A step with no keys is a pure wait, which the capture loop cannot
      // express: give it one harmless press so the wait still produces a frame.
      .map((step) =>
        step.keys.length === 0 ? { ...step, keys: [KEY_NOOP] } : step,
      ),
  );
}

/** DPAD_CENTER on a non-focusable surface does nothing; used to force a frame. */
const KEY_NOOP = 0;

function loadFlow(): WalkStep[] {
  const flowPath = flag("flow");
  if (flowPath) {
    const parsed = JSON.parse(readFileSync(resolve(flowPath), "utf8"));
    if (isNamedFlow(parsed)) return flattenNamedFlow(parsed);
    if (!Array.isArray(parsed)) {
      throw new Error(
        "flow file must be a JSON array of steps, or a { keys, screens } document",
      );
    }
    return parsed as WalkStep[];
  }

  const keys = flag("keys");
  if (!keys) {
    throw new Error("tv-walk: pass --flow <file> or --keys <codes>");
  }
  return [
    {
      screen: flag("screen") ?? "walk",
      keys: keys.split(",").map((k) => Number(k.trim())),
    },
  ];
}

async function main() {
  const steps = loadFlow();

  const before = WANT_MEMINFO ? totalPssKb() : null;
  if (before !== null) console.log(`meminfo before: ${before} kB PSS`);

  if (LAUNCH) {
    adb(
      "shell",
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      LAUNCH,
    );
    // The dev client has to fetch and evaluate the bundle; nothing below is
    // worth capturing until it has.
    await sleep(8000);
  }

  let index = 0;
  for (const step of steps) {
    if (step.note) console.log(`\n# ${step.screen}: ${step.note}`);
    const settle = step.settleMs ?? DEFAULT_SETTLE;

    for (const key of step.keys) {
      adb("shell", "input", "keyevent", String(key));
      await sleep(settle);

      const name = KEY_NAMES[key] ?? String(key);
      const file = join(
        outDir,
        `${String(index).padStart(3, "0")}-${step.screen}-${name}.png`,
      );
      screencap(file);
      console.log(`  ${file}`);
      index += 1;
    }
  }

  if (WANT_MEMINFO) {
    const after = totalPssKb();
    console.log(`meminfo after: ${after} kB PSS`);
    if (before !== null && after !== null) {
      const deltaMb = (after - before) / 1024;
      console.log(`PSS delta: ${deltaMb.toFixed(1)} MB`);
      writeFileSync(
        join(outDir, "meminfo.txt"),
        `before_kb=${before}\nafter_kb=${after}\ndelta_mb=${deltaMb.toFixed(1)}\n`,
      );
    }
  }

  if (WANT_LOGCAT) {
    const errors = adb("logcat", "-d", "*:E");
    writeFileSync(join(outDir, "logcat-errors.txt"), errors);
    const reactErrors = errors
      .split("\n")
      .filter((line) => line.includes("ReactNativeJS"));
    console.log(
      reactErrors.length === 0
        ? "logcat: no ReactNativeJS errors"
        : `logcat: ${reactErrors.length} ReactNativeJS error line(s)\n${reactErrors.join("\n")}`,
    );
  }

  console.log(`\n${index} capture(s) in ${outDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
