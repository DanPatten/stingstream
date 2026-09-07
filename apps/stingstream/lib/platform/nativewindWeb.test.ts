import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Two wiring facts that, when broken, break silently: every Tailwind class in
// the app stops doing anything in the browser, the bundle still builds, no
// console error is printed, and the only symptom is that screens made of
// classes look unstyled. It cost WP-PLAYER a pass of inline-styling around it.
//
// Neither can be checked by importing the modules — both pull in react-native,
// which `bun:test` cannot load — so they are checked as source text, the way
// `CLAUDE.test.ts` and `assets/bundled-assets.test.ts` check the lists they pin.

const root = join(__dirname, "..", "..");
const entry = readFileSync(join(root, "index.web.ts"), "utf8");
const tailwind = readFileSync(join(root, "tailwind.config.js"), "utf8");

describe("the web entry", () => {
  test("forces NativeWind into native output", () => {
    // Without it the runtime auto-detects `css` output on react-native-web and
    // hands class names to a stylesheet this build never generates.
    expect(entry).toContain("./lib/platform/nativewind-web");
  });

  test("does it before expo-router mounts anything", () => {
    // `prepare()` reads the output flag every time a class is resolved, so
    // anything rendered before the flip resolves to nothing. Compared as
    // import statements, not as text: the file's own comment names both.
    const imports = [...entry.matchAll(/^import\s+"([^"]+)";$/gm)].map(
      (match) => match[1],
    );
    const flip = imports.indexOf("./lib/platform/nativewind-web");
    const router = imports.indexOf("expo-router/entry");
    expect({ flip: flip > -1, router: router > -1 }).toEqual({
      flip: true,
      router: true,
    });
    expect(flip).toBeLessThan(router);
  });
});

describe("tailwind content globs", () => {
  // `nativewind/babel` skips any file that does not match `content`, so this
  // list decides where `className` works at all — it is not just a scan list.
  const listed = [...tailwind.matchAll(/"\.\/([a-z-]+)\/\*\*/g)].map(
    (match) => match[1],
  );

  test("every directory that can hold JSX is listed", () => {
    const missing = [
      "app",
      "components",
      "hooks",
      "lib",
      "modules",
      "providers",
      "utils",
    ].filter((dir) => !listed.includes(dir));
    // A non-empty list here names directories whose `className`s do nothing.
    expect(missing).toEqual([]);
  });
});
