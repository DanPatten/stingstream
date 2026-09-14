import { describe, expect, test } from "bun:test";
import { Autosaver, commitAutosaves, registerAutosaver } from "./autosaver";

/** A clock that only moves when told to. */
function fakeTimers() {
  let queue: { fn: () => void; handle: number }[] = [];
  let next = 0;
  return {
    timers: {
      set: (fn: () => void) => {
        const handle = ++next;
        queue.push({ fn, handle });
        return handle;
      },
      clear: (handle: unknown) => {
        queue = queue.filter((t) => t.handle !== handle);
      },
    },
    pending: () => queue.length,
    fire: () => {
      const due = queue;
      queue = [];
      for (const t of due) t.fn();
    },
  };
}

function setup(save?: (next: { name: string }) => Promise<unknown>) {
  const clock = fakeTimers();
  const sent: { name: string }[] = [];
  const saver = new Autosaver<{ name: string }>(
    save ??
      (async (next) => {
        sent.push(next);
      }),
    () => {},
    1000,
    clock.timers,
  );
  saver.seed({ name: "Home" });
  return { clock, sent, saver };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Autosaver", () => {
  test("typing sends nothing until the field is committed", async () => {
    const { sent, saver } = setup();
    for (const name of ["H", "Ho", "Hom", "Home ", "Home S"]) {
      saver.edit({ name });
    }
    expect(sent).toEqual([]);
    await saver.commit();
    expect(sent).toEqual([{ name: "Home S" }]);
  });

  test("the idle fallback sends once, after the last edit", async () => {
    const { clock, sent, saver } = setup();
    saver.edit({ name: "A" });
    saver.edit({ name: "AB" });
    expect(clock.pending()).toBe(1);
    clock.fire();
    await tick();
    expect(sent).toEqual([{ name: "AB" }]);
  });

  test("a value changed back to what the server has is not sent", async () => {
    const { sent, saver } = setup();
    saver.edit({ name: "Homer" });
    saver.edit({ name: "Home" });
    await saver.commit();
    expect(sent).toEqual([]);
  });

  test("committing twice sends once", async () => {
    const { sent, saver } = setup();
    saver.edit({ name: "Office" });
    await saver.commit();
    saver.edit({ name: "Office" });
    await saver.commit();
    expect(sent).toEqual([{ name: "Office" }]);
  });

  test("a switch is sent at once and cancels the pending timer", async () => {
    const { clock, sent, saver } = setup();
    saver.edit({ name: "Office" });
    saver.edit({ name: "Office 2" }, { now: true });
    expect(clock.pending()).toBe(0);
    await tick();
    expect(sent).toEqual([{ name: "Office 2" }]);
  });

  test("a commit during a save waits and sends only the newest document", async () => {
    const sent: string[] = [];
    let release = () => {};
    const { saver } = setup(async (next) => {
      sent.push(`start ${next.name}`);
      if (next.name === "A") await new Promise<void>((r) => (release = r));
      sent.push(`end ${next.name}`);
    });
    saver.edit({ name: "A" }, { now: true });
    await tick();
    saver.edit({ name: "B" });
    const second = saver.commit();
    saver.edit({ name: "C" });
    await tick();
    expect(sent).toEqual(["start A"]);
    release();
    await second;
    expect(sent).toEqual(["start A", "end A", "start C", "end C"]);
  });

  test("a failed save is retried by committing the same value", async () => {
    let fail = true;
    const sent: string[] = [];
    const { saver } = setup(async (next) => {
      if (fail) throw new Error("offline");
      sent.push(next.name);
    });
    saver.edit({ name: "Office" });
    await saver.commit();
    fail = false;
    saver.edit({ name: "Office" });
    await saver.commit();
    expect(sent).toEqual(["Office"]);
  });

  test("commitAutosaves reaches every registered draft", async () => {
    const a = setup();
    const b = setup();
    const offA = registerAutosaver(a.saver as Autosaver<unknown>);
    const offB = registerAutosaver(b.saver as Autosaver<unknown>);
    a.saver.edit({ name: "A" });
    commitAutosaves();
    await tick();
    expect(a.sent).toEqual([{ name: "A" }]);
    expect(b.sent).toEqual([]);
    offA();
    offB();
  });
});
