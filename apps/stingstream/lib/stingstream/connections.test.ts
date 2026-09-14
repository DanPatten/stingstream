import { describe, expect, test } from "bun:test";
import { buildInviteLink } from "@/utils/mesh/connectionLink";
import { toConnectionInvite } from "./connectionInvite";

describe("toConnectionInvite", () => {
  test("carries the address the server chose for the link", () => {
    const invite = toConnectionInvite({
      code: "C0DE",
      node: "n1",
      server: "dan main",
      address: "https://meals.danha.top",
    });
    expect(invite.address).toBe("https://meals.danha.top");
    expect(
      buildInviteLink(invite.address ?? "http://192.168.0.16:5173", invite),
    ).toStartWith("https://meals.danha.top/link#code=C0DE");
  });

  test("no address, or a blank one, leaves the page to choose", () => {
    expect(toConnectionInvite({ code: "x" }).address).toBeNull();
    expect(toConnectionInvite({ code: "x", address: "  " }).address).toBeNull();
  });
});
