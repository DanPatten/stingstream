import { describe, expect, test } from "bun:test";
import { handleEscapeKey, pushEscape } from "./escapeStack";

describe("escapeStack", () => {
  test("Escape closes only the modal opened last", () => {
    const closed: string[] = [];
    const popDialog = pushEscape(() => closed.push("dialog"));
    const popSheet = pushEscape(() => closed.push("sheet"));

    expect(handleEscapeKey("Escape")).toBe(true);
    expect(closed).toEqual(["sheet"]);

    popSheet();
    handleEscapeKey("Escape");
    expect(closed).toEqual(["sheet", "dialog"]);

    popDialog();
    expect(handleEscapeKey("Escape")).toBe(false);
  });

  test("other keys do nothing", () => {
    const closed: string[] = [];
    const pop = pushEscape(() => closed.push("x"));
    expect(handleEscapeKey("Enter")).toBe(false);
    expect(closed).toEqual([]);
    pop();
  });
});
