import { describe, expect, test } from "bun:test";
import { nodeCandidates } from "./nodeCandidates";

describe("nodeCandidates", () => {
  test("puts the node's gateway port first, then the address discovery actually reported", () => {
    expect(nodeCandidates("http://192.168.1.42:8096")).toEqual([
      "http://192.168.1.42:8790",
      "http://192.168.1.42:8096",
    ]);
  });

  test("does not duplicate when the discovered address is already the gateway", () => {
    expect(nodeCandidates("http://192.168.1.42:8790")).toEqual([
      "http://192.168.1.42:8790",
    ]);
  });

  test("strips a discovered https scheme for the gateway candidate, which is always http", () => {
    expect(nodeCandidates("https://media.local")).toEqual([
      "http://media.local:8790",
      "https://media.local",
    ]);
  });

  test("handles a discovered address with no port", () => {
    expect(nodeCandidates("http://10.0.2.2")).toEqual([
      "http://10.0.2.2:8790",
      "http://10.0.2.2",
    ]);
  });

  test("falls back to the raw input when no host can be parsed", () => {
    expect(nodeCandidates("not a url")).toEqual(["not a url"]);
  });
});
