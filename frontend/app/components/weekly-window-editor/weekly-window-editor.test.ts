import { describe, expect, it } from "vitest";
import {
  isWeeklyWindowScheduleJsonValid,
  parseWeeklyWindowSchedule,
  serializeWeeklyWindowSchedule,
} from "./weekly-window-editor";

describe("weekly window schedule JSON", () => {
  it("treats empty values as unrestricted", () => {
    expect(isWeeklyWindowScheduleJsonValid("")).toBe(true);
    expect(isWeeklyWindowScheduleJsonValid(undefined)).toBe(true);
  });

  it("accepts overnight weekday windows", () => {
    const json = JSON.stringify({
      Enabled: true,
      Windows: [{ Days: [5], StartMinute: 1320, EndMinute: 360 }],
    });
    expect(isWeeklyWindowScheduleJsonValid(json)).toBe(true);
  });

  it("rejects enabled schedules without windows", () => {
    expect(isWeeklyWindowScheduleJsonValid(JSON.stringify({ Enabled: true, Windows: [] }))).toBe(
      false,
    );
  });

  it("rejects non-boolean Enabled values", () => {
    expect(
      isWeeklyWindowScheduleJsonValid(
        JSON.stringify({
          Enabled: "false",
          Windows: [{ Days: [1], StartMinute: 0, EndMinute: 60 }],
        }),
      ),
    ).toBe(false);
  });

  it("round-trips enabled schedules and serializes disabled to empty", () => {
    const parsed = parseWeeklyWindowSchedule(
      JSON.stringify({
        Enabled: true,
        Windows: [{ Days: [1, 2], StartMinute: 0, EndMinute: 60 }],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serializeWeeklyWindowSchedule(parsed.schedule)).toContain('"Enabled":true');
    expect(serializeWeeklyWindowSchedule({ Enabled: false, Windows: [] })).toBe("");
  });
});
