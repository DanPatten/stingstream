import { describe, expect, test } from "bun:test";
import {
  type MemberRequest,
  type RequestSearchResult,
  requestTitle,
  sameUser,
  searchAction,
  seasonsLabel,
  selectMine,
  stateLabel,
  stateTone,
  toCounts,
  toNotification,
  toPolicy,
  toRequest,
  toRequestDetail,
  toSearchResult,
} from "./requestsApi";

/**
 * The shaping and presentation half of the Requests screens.
 *
 * Everything asserted here is a pure function over what the node sent, which is the only part of
 * this feature a test process can reach: `bun:test` cannot load `providers/JellyfinProvider`'s
 * import graph (a native `codegenNativeComponent` a few layers down), so the hooks in
 * `requests.ts` are deliberately thin wrappers and all of the logic lives on this side.
 */

const camel = {
  id: "abc",
  group: "g1",
  kind: "series",
  itemKey: "episode:tvdb:73739:",
  provider: "tvdb",
  providerId: 73739,
  title: "Lost",
  year: 2004,
  seasons: [1, 2],
  state: "fulfilling",
  requestedBy: "aaaabbbbccccddddeeeeffff00001111",
  requestedByName: "dan",
  requestedAt: "2026-09-05T10:00:00Z",
  fulfillingNodeName: "loft",
  note: "loft is grabbing it.",
  mine: true,
  updatedAt: "2026-09-05T10:00:10Z",
};

/** The same body as Core actually sends it: Jellyfin's serializer is PascalCase. */
const pascal = Object.fromEntries(
  Object.entries(camel).map(([k, v]) => [
    k.charAt(0).toUpperCase() + k.slice(1),
    v,
  ]),
);

describe("reading what the node sent", () => {
  test("a request reads the same either way round", () => {
    // Core answers PascalCase (docs/APP-MESH.md §6) despite the controller base's comment saying
    // camelCase. Reading both is what stops a future serializer change silently emptying every
    // screen, which is how the same surprise was found in M3c.
    const fromCamel = toRequest(camel);
    const fromPascal = toRequest(pascal);
    expect(fromPascal).toEqual(fromCamel);
    expect(fromPascal.title).toBe("Lost");
    expect(fromPascal.seasons).toEqual([1, 2]);
  });

  test("a request from a peer node is not mistaken for the user's own", () => {
    // `mine` defaults to true when absent -- a request made here. An adopted one carries an
    // explicit false, and defaulting the other way would put every member's requests on everybody's
    // My requests screen.
    expect(toRequest({ Mine: false }).mine).toBe(false);
    expect(toRequest({}).mine).toBe(true);
  });

  test("missing optional fields come back absent rather than as the string null", () => {
    const bare = toRequest({ Id: "x", State: "pending" });
    expect(bare.year).toBeUndefined();
    expect(bare.fulfillingNode).toBeUndefined();
    expect(bare.posterUrl).toBeUndefined();
    expect(bare.seasons).toEqual([]);
    expect(bare.note).toBe("");
  });

  test("a detail body carries the trail in order", () => {
    const detail = toRequestDetail({
      Request: pascal,
      Events: [
        { Id: 1, State: "pending", Actor: "dan", Note: "asked", At: "t1" },
        { Id: 2, State: "approved", Actor: "sam", Note: "ok", At: "t2" },
      ],
    });
    expect(detail.request.id).toBe("abc");
    expect(detail.events.map((e) => e.state)).toEqual(["pending", "approved"]);
  });

  test("a policy defaults to the cautious mode when the node sent none", () => {
    // Never `everyone`. A missing field must not be read as "anybody may spend the group's
    // bandwidth"; the node's own default is `trusted` and this agrees with it.
    expect(toPolicy({}).autoApprove).toBe("trusted");
    expect(toPolicy({ AutoApprove: "everyone" }).autoApprove).toBe("everyone");
  });

  test("counts default to zero and to not being able to approve", () => {
    const counts = toCounts({});
    expect(counts.pendingApproval).toBe(0);
    expect(counts.canApprove).toBe(false);
  });

  test("a notification reads its request id so the app can link to it", () => {
    const n = toNotification({
      Id: 7,
      UserId: "u",
      Kind: "request_available",
      Title: "Ready to watch",
      Body: "Lost (2004) is in your library.",
      RequestId: "abc",
      Read: false,
      CreatedAt: "t",
    });
    expect(n.requestId).toBe("abc");
    expect(n.read).toBe(false);
  });

  test("a search result carries what the group already holds", () => {
    const r = toSearchResult({
      Kind: "movie",
      Title: "Big Buck Bunny",
      TmdbId: 10378,
      ItemKey: "movie:tmdb:10378",
      AvailableInGroup: true,
      Holders: ["loft"],
    });
    expect(r.availableInGroup).toBe(true);
    expect(r.holders).toEqual(["loft"]);
  });
});

describe("what a state means to the person who asked", () => {
  test("states read as what is happening, not as what the system calls it", () => {
    expect(stateLabel("fulfilling")).toBe("Downloading");
    expect(stateLabel("available")).toBe("Ready to watch");
    expect(stateLabel("pending")).toBe("Waiting for approval");
  });

  test("waiting and approved share one tone", () => {
    // Both are "in hand, nothing for you to do". Six colours for six states would make a list of
    // twenty requests look like a paint chart.
    expect(stateTone("pending")).toBe("waiting");
    expect(stateTone("approved")).toBe("waiting");
    expect(stateTone("fulfilling")).toBe("working");
    expect(stateTone("available")).toBe("done");
    expect(stateTone("declined")).toBe("stopped");
    expect(stateTone("failed")).toBe("stopped");
  });

  test("seasons read the way a person would write them", () => {
    expect(seasonsLabel([])).toBe("All seasons");
    expect(seasonsLabel(undefined)).toBe("All seasons");
    expect(seasonsLabel([2])).toBe("Season 2");
    expect(seasonsLabel([3, 1, 2])).toBe("Seasons 1, 2, 3");
  });

  test("a title without a year does not grow empty brackets", () => {
    expect(requestTitle({ title: "Lost", year: 2004 })).toBe("Lost (2004)");
    expect(requestTitle({ title: "Lost" })).toBe("Lost");
    expect(requestTitle({ title: "Lost", year: null })).toBe("Lost");
  });
});

describe("what the request button offers", () => {
  const result = (
    over: Partial<RequestSearchResult> = {},
  ): RequestSearchResult => ({
    kind: "movie",
    title: "Big Buck Bunny",
    tmdbId: 10378,
    tvdbId: 0,
    itemKey: "movie:tmdb:10378",
    availableInGroup: false,
    holders: [],
    ...over,
  });

  test("a title the group already holds is not offered again", () => {
    // The whole point of annotating search results: finding out after pressing Request that no
    // download was going to happen is too late to be useful.
    const action = searchAction(
      result({ availableInGroup: true, holders: ["loft"] }),
    );
    expect(action.disabled).toBe(true);
    expect(action.label).toBe("In your library");
  });

  test("a request already in flight is not offered again", () => {
    for (const state of [
      "pending",
      "approved",
      "fulfilling",
      "available",
    ] as const) {
      expect(searchAction(result({ requestState: state })).disabled).toBe(true);
    }
  });

  test("a declined or failed request may be asked for again", () => {
    // The first was refused by a person who may have changed their mind; the second failed for
    // reasons that may have gone away. Neither is a permanent no.
    expect(searchAction(result({ requestState: "declined" })).disabled).toBe(
      false,
    );
    expect(searchAction(result({ requestState: "failed" })).disabled).toBe(
      false,
    );
  });

  test("an untouched title is offered", () => {
    const action = searchAction(result());
    expect(action.disabled).toBe(false);
    expect(action.label).toBe("Request");
  });
});

describe("telling a member's own requests from everybody else's", () => {
  const rows: MemberRequest[] = [
    toRequest({
      ...camel,
      id: "a",
      requestedBy: "aaaabbbbccccddddeeeeffff00001111",
    }),
    toRequest({
      ...camel,
      id: "b",
      requestedBy: "99998888777766665555444433332222",
    }),
  ];

  test("the dashed and dashless spellings of one guid are the same person", () => {
    // Jellyfin issues the auth claim in `N` format and some DTOs in `D`. Comparing them as plain
    // strings gives a member an empty My requests screen with no error anywhere.
    expect(
      sameUser(
        "aaaabbbbccccddddeeeeffff00001111",
        "aaaabbbb-cccc-dddd-eeee-ffff00001111",
      ),
    ).toBe(true);
    expect(
      sameUser(
        "AAAABBBBCCCCDDDDEEEEFFFF00001111",
        "aaaabbbbccccddddeeeeffff00001111",
      ),
    ).toBe(true);
    expect(sameUser("aaaa", "bbbb")).toBe(false);
    expect(sameUser(undefined, "aaaa")).toBe(false);
  });

  test("only the caller's own rows survive the filter", () => {
    const mine = selectMine(rows, "aaaabbbb-cccc-dddd-eeee-ffff00001111");
    expect(mine.map((r) => r.id)).toEqual(["a"]);
  });

  test("no signed-in id keeps what the node sent rather than blanking the screen", () => {
    // The node has already filtered to the caller's own for a non-administrator, so its answer is
    // the safe fallback.
    expect(selectMine(rows, undefined)).toHaveLength(2);
    expect(selectMine(undefined, "x")).toEqual([]);
  });
});
