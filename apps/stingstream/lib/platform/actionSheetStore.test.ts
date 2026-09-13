import { describe, expect, test } from "bun:test";
import { createActionSheetStore, toDialogItems } from "./actionSheetStore";

describe("toDialogItems", () => {
  test("stacks every option but the cancel one, which becomes the dialog's button", () => {
    const { choices, cancel } = toDialogItems({
      options: ["Chromecast", "Device", "Cancel"],
      cancelButtonIndex: 2,
    });
    expect(choices.map((c) => [c.index, c.label])).toEqual([
      [0, "Chromecast"],
      [1, "Device"],
    ]);
    expect(cancel).toEqual({ index: 2, label: "Cancel" });
  });

  test("marks destructive and disabled options, as a number or a list", () => {
    const single = toDialogItems({
      options: ["Delete", "Cancel"],
      destructiveButtonIndex: 0,
      cancelButtonIndex: 1,
    });
    expect(single.choices[0]).toMatchObject({ destructive: true });

    const many = toDialogItems({
      options: ["A", "B", "C"],
      destructiveButtonIndex: [1, 2],
      disabledButtonIndices: [0],
    });
    expect(many.choices.map((c) => [c.destructive, c.disabled])).toEqual([
      [false, true],
      [true, false],
      [true, false],
    ]);
    expect(many.cancel).toBeNull();
  });
});

describe("actionSheetStore", () => {
  test("reports the chosen index and closes", () => {
    const store = createActionSheetStore();
    const picked: (number | undefined)[] = [];
    store.show({ options: ["A", "B", "Cancel"], cancelButtonIndex: 2 }, (i) => {
      picked.push(i);
    });
    expect(store.getSnapshot()).not.toBeNull();
    store.select(1);
    expect(picked).toEqual([1]);
    expect(store.getSnapshot()).toBeNull();
  });

  test("dismissing answers with the cancel index, like the native sheet", () => {
    const store = createActionSheetStore();
    const picked: (number | undefined)[] = [];
    store.show({ options: ["Delete", "Cancel"], cancelButtonIndex: 1 }, (i) => {
      picked.push(i);
    });
    store.dismiss();
    expect(picked).toEqual([1]);
  });

  test("a second sheet cancels the first, so its caller is not left waiting", () => {
    const store = createActionSheetStore();
    const first: (number | undefined)[] = [];
    const second: (number | undefined)[] = [];
    store.show({ options: ["A", "Cancel"], cancelButtonIndex: 1 }, (i) => {
      first.push(i);
    });
    store.show({ options: ["B", "Cancel"], cancelButtonIndex: 1 }, (i) => {
      second.push(i);
    });
    expect(first).toEqual([1]);
    expect(store.getSnapshot()?.options.options[0]).toBe("B");
    store.select(0);
    expect(second).toEqual([0]);
  });

  test("selecting with nothing open does nothing", () => {
    const store = createActionSheetStore();
    let notified = 0;
    store.subscribe(() => notified++);
    store.select(0);
    expect(notified).toBe(0);
  });
});
