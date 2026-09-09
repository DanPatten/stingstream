import { describe, expect, test } from "bun:test";
import { decidePhase, type PhaseInputs } from "./loginPhase";

/** A node marker for a claimed node on a trusted address, which each test varies from. */
const NODE: PhaseInputs["context"] = { setupPending: false, trustedPeer: true };

function decide(overrides: Partial<PhaseInputs> = {}) {
  return decidePhase({
    context: NODE,
    connected: true,
    setup: { known: true, pending: false, trustedPeer: true },
    ...overrides,
  });
}

/**
 * The regression this whole file exists for.
 *
 * Every one of these inputs used to produce the address form, and each of them is a state a cold
 * node passes through on the way up. Enumerated rather than summarised, because "no path leads
 * there" is only true if the paths are named.
 */
describe("a node served the page, so the address form is never the answer", () => {
  const reachedNode: Partial<PhaseInputs>[] = [
    { connected: false, setup: null },
    {
      connected: false,
      setup: { known: false, pending: false, trustedPeer: false },
    },
    {
      connected: false,
      setup: { known: true, pending: false, trustedPeer: true },
    },
    { connected: true, setup: null },
    {
      connected: true,
      setup: { known: false, pending: false, trustedPeer: false },
    },
    {
      context: { setupPending: true, trustedPeer: false },
      connected: false,
      setup: null,
    },
    {
      context: { setupPending: null, trustedPeer: true },
      connected: false,
      setup: null,
    },
  ];

  for (const [index, overrides] of reachedNode.entries()) {
    test(`case ${index + 1} does not reach the address form`, () => {
      expect(decide(overrides).phase).not.toBe("serverForm");
    });
  }
});

describe("a server that has not answered yet", () => {
  test("is starting, not missing", () => {
    expect(decide({ connected: false, setup: null }).phase).toBe("starting");
  });

  test("is still starting once it has said it has an account", () => {
    expect(
      decide({
        connected: false,
        setup: { known: true, pending: false, trustedPeer: true },
      }).phase,
    ).toBe("starting");
  });

  test("becomes the sign-in card the moment it answers", () => {
    expect(decide({ connected: true }).phase).toBe("signIn");
  });
});

describe("who decides whether the node still needs an account", () => {
  test("the node does, whenever it actually answered", () => {
    expect(
      decide({
        context: { setupPending: true, trustedPeer: true },
        setup: { known: true, pending: false, trustedPeer: true },
      }).phase,
    ).toBe("signIn");
  });

  test("its trustedPeer beats the marker's, because it checked the real peer", () => {
    expect(
      decide({
        context: { setupPending: true, trustedPeer: true },
        setup: { known: true, pending: true, trustedPeer: false },
      }).phase,
    ).toBe("setupElsewhere");
  });

  // The bug: a gateway that has not registered its Jellyfin child yet answers 404, which used to
  // read as "setup is done" and sent a fresh node's owner to a sign-in card — or, with nothing
  // connected yet, to the address form.
  test("a 404 does not overrule a marker that says the node is unclaimed", () => {
    expect(
      decide({
        context: { setupPending: true, trustedPeer: true },
        connected: false,
        setup: { known: false, pending: false, trustedPeer: false },
      }),
    ).toEqual({ phase: "welcome", unreachable: false });
  });

  // The case the 404 branch was originally written for, and it still holds: a node old enough to
  // have no setup routes has no `setupPending` in its marker either, so nothing claims it is
  // unclaimed and the sign-in card is right.
  test("a 404 from a node too old to have the routes still means sign in", () => {
    expect(
      decide({
        context: { setupPending: null, trustedPeer: true },
        setup: { known: false, pending: false, trustedPeer: false },
      }).phase,
    ).toBe("signIn");
  });

  test("silence falls back to the marker, and says it was silence", () => {
    expect(
      decide({
        context: { setupPending: true, trustedPeer: true },
        setup: null,
      }),
    ).toEqual({ phase: "welcome", unreachable: true });
  });

  // The welcome page is a step for the person, not a fact about the server, so it is not decided
  // here. If it were, anything that re-decides -- a Retry, a refetch -- would drop somebody back
  // onto a page they had already moved past, mid-typing.
  test("a node that needs an account starts at the welcome, never at the form", () => {
    const decisions = [
      decide({
        context: { setupPending: true, trustedPeer: true },
        setup: { known: true, pending: true, trustedPeer: true },
      }),
      decide({
        context: { setupPending: true, trustedPeer: true },
        setup: null,
      }),
      decide({
        context: { setupPending: true, trustedPeer: true },
        setup: { known: false, pending: false, trustedPeer: false },
      }),
    ];
    expect(decisions.map((d) => d.phase)).toEqual([
      "welcome",
      "welcome",
      "welcome",
    ]);
  });

  test("an untrusted peer is sent to finish setup elsewhere", () => {
    expect(
      decide({
        context: { setupPending: true, trustedPeer: false },
        setup: null,
      }).phase,
    ).toBe("setupElsewhere");
  });
});

describe("nothing served the page", () => {
  test("the address form is the first card", () => {
    expect(decide({ context: null, connected: false, setup: null }).phase).toBe(
      "serverForm",
    );
  });

  // A phone that has already been pointed at a server still starts here; the screen skips past it
  // on its own once a saved server connects.
  test("even when a server is already connected", () => {
    expect(decide({ context: null, connected: true }).phase).toBe("serverForm");
  });
});
