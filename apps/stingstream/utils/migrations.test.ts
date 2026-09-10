import { beforeEach, describe, expect, mock, test } from "bun:test";
import { stubMmkv } from "@/test-utils/mmkv";

// Only so importing the module (which pulls in @/utils/mmkv) doesn't reach for
// the native store — the tests below drive an injected store, not this one.
// The shared double rather than a local stub: whichever spec's stub wins backs
// the whole run, and a store that drops writes breaks the specs that persist.
stubMmkv();
// Bun's mock.module retroactively re-links every module already importing the
// specifier, so a log mock must cover the module's full function surface —
// a missing name breaks OTHER test files' modules that import it.
const errors: string[] = [];
mock.module("@/utils/log", () => ({
  writeToLog: () => undefined,
  writeInfoLog: () => undefined,
  writeErrorLog: (message: string) => void errors.push(message),
  writeDebugLog: () => undefined,
  readFromLog: () => [],
  logAndCaptureError: () => undefined,
}));

const { LATEST_SCHEMA_VERSION, runStorageMigrations } = await import(
  "./migrations"
);

const data = new Map<string, boolean | number | string>();
const store = {
  getNumber: (key: string) => data.get(key) as number | undefined,
  getString: (key: string) => data.get(key) as string | undefined,
  getAllKeys: () => [...data.keys()],
  set: (key: string, value: boolean | number | string) =>
    void data.set(key, value),
  remove: (key: string) => void data.delete(key),
};

const version = () => data.get("storageSchemaVersion");

beforeEach(() => {
  data.clear();
  errors.length = 0;
});

describe("runStorageMigrations", () => {
  test("stamps a fresh install without running migrations", () => {
    runStorageMigrations(store);

    expect(version()).toBe(LATEST_SCHEMA_VERSION);
    expect([...data.keys()]).toEqual(["storageSchemaVersion"]);
  });

  test("clears hasShownIntro for an existing install", () => {
    data.set("token", "abc");
    data.set("hasShownIntro", true);

    runStorageMigrations(store);

    expect(data.has("hasShownIntro")).toBe(false);
    expect(data.get("token")).toBe("abc");
    expect(version()).toBe(LATEST_SCHEMA_VERSION);
  });

  test("logs a migration that throws and leaves it pending", () => {
    data.set("token", "abc");
    const failing = {
      ...store,
      remove: () => {
        throw new Error("remove failed");
      },
    };

    runStorageMigrations(failing);

    expect(errors[0]).toBe("Storage migration 1 failed");
    expect(version()).toBeUndefined();

    // It retries on the next launch, against a store that works again.
    runStorageMigrations(store);

    expect(version()).toBe(LATEST_SCHEMA_VERSION);
  });

  test("does not re-run once the store is up to date", () => {
    data.set("storageSchemaVersion", LATEST_SCHEMA_VERSION);
    data.set("hasShownIntro", true);

    runStorageMigrations(store);

    // The intro was dismissed after migrating, so it must stay dismissed.
    expect(data.get("hasShownIntro")).toBe(true);
  });

  describe("accent -> theme", () => {
    const settingsBlob = (value: Record<string, unknown>) =>
      void data.set("settings", JSON.stringify(value));
    const storedSettings = () =>
      JSON.parse(String(data.get("settings"))) as Record<string, unknown>;

    test("violet lands on the theme that kept violet", () => {
      // Violet was the one accent that was a deliberate departure from the
      // brand, so it maps to `sting` rather than to the default.
      settingsBlob({ accent: "violet", subtitleSize: 20 });

      runStorageMigrations(store);

      expect(storedSettings()).toEqual({ theme: "sting", subtitleSize: 20 });
    });

    test("the other accents land on the default theme", () => {
      for (const accent of ["teal", "amber"]) {
        data.clear();
        settingsBlob({ accent });

        runStorageMigrations(store);

        expect(storedSettings()).toEqual({ theme: "dark" });
      }
    });

    test("someone who already picked a theme is left alone", () => {
      settingsBlob({ theme: "light", accent: "violet" });

      runStorageMigrations(store);

      expect(storedSettings().theme).toBe("light");
    });

    test("a store with no settings blob is not a failure", () => {
      data.set("token", "abc");

      runStorageMigrations(store);

      expect(errors).toEqual([]);
      expect(version()).toBe(LATEST_SCHEMA_VERSION);
    });
  });
});
