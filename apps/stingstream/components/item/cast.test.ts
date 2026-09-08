import { describe, expect, test } from "bun:test";
import type { BaseItemPerson } from "@jellyfin/sdk/lib/generated-client/models";
import { dedupePeople, initialsOf, roleCaption } from "./cast";

const person = (fields: Partial<BaseItemPerson>): BaseItemPerson =>
  fields as BaseItemPerson;

describe("roleCaption", () => {
  test("keeps an ordinary role as it is", () => {
    expect(roleCaption("Dr. Emmett Brown")).toBe("Dr. Emmett Brown");
  });

  test("drops the credit note, which is not the part", () => {
    expect(roleCaption("Marion Crane (uncredited)")).toBe("Marion Crane");
    expect(roleCaption("Bartender (Uncredited)")).toBe("Bartender");
  });

  test("clears the comma dedupePeople left behind", () => {
    // Two credits joined, then the second one turns out to be only a note.
    expect(roleCaption("Narrator, (uncredited)")).toBe("Narrator");
    expect(roleCaption("(uncredited), Villager")).toBe("Villager");
  });

  test("a role that was nothing but the note is no caption at all", () => {
    expect(roleCaption("(uncredited)")).toBeNull();
    expect(roleCaption("   ")).toBeNull();
    expect(roleCaption(null)).toBeNull();
    expect(roleCaption(undefined)).toBeNull();
  });

  test("collapses the whitespace a removal opens up", () => {
    expect(roleCaption("Self  (uncredited)  ")).toBe("Self");
  });
});

describe("initialsOf", () => {
  test("first and last, for a tile with no photo", () => {
    expect(initialsOf("Michael J. Fox")).toBe("MF");
    expect(initialsOf("Cher")).toBe("CH");
    expect(initialsOf("")).toBe("?");
  });
});

describe("dedupePeople", () => {
  test("one tile, both roles, when the server credits a name twice", () => {
    const merged = dedupePeople([
      person({ Id: "1", Name: "Jordan Peele", Role: "Director" }),
      person({ Id: "1", Name: "Jordan Peele", Role: "Writer" }),
      person({ Id: "2", Name: "Daniel Kaluuya", Role: "Chris" }),
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[0].Role).toBe("Director, Writer");
  });

  test("drops people the server gave no id", () => {
    expect(dedupePeople([person({ Name: "Nobody" })])).toHaveLength(0);
    expect(dedupePeople(null)).toHaveLength(0);
  });
});
