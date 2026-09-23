import { describe, expect, test } from "bun:test";
import { type IndexerHealth, indexerProblem } from "./indexerProblem";

const health = (over: Partial<IndexerHealth>): IndexerHealth => ({
  configured: 1,
  enabled: 1,
  downloadClients: 1,
  answered: true,
  failing: [],
  ...over,
});

describe("indexerProblem", () => {
  test("unknown is not a problem yet", () => {
    expect(indexerProblem(undefined)).toBeNull();
  });

  test("a working node has none", () => {
    expect(indexerProblem(health({}))).toBeNull();
  });

  test("no indexer is its own case", () => {
    expect(indexerProblem(health({ enabled: 0, downloadClients: 0 }))).toBe(
      "none-configured",
    );
  });

  test("indexers with nowhere to send a result are flagged", () => {
    // StingStream runs no download client of its own, so this is a node that finds releases and
    // drops them.
    expect(indexerProblem(health({ downloadClients: 0 }))).toBe(
      "no-download-client",
    );
  });

  test("failing indexers only count when a manager answered", () => {
    expect(indexerProblem(health({ failing: ["down"] }))).toBe("all-failing");
    expect(
      indexerProblem(health({ failing: ["down"], answered: false })),
    ).toBeNull();
  });
});
