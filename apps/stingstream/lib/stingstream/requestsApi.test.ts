import { describe, expect, test } from "bun:test";
import {
  libraryMatchKeys,
  type MemberRequest,
  providerKey,
  type RequestSearchResult,
  RequestsUnavailableError,
  requestTitle,
  sameUser,
  searchAction,
  searchBadgeLabel,
  seasonsLabel,
  selectMine,
  splitCatalogueResults,
  stateLabel,
  stateTone,
  titleKey,
  toCounts,
  toNotification,
  toPolicy,
  toRequest,
  toRequestCard,
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

describe("the Discover poster's badge", () => {
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

  test("held by the group reads as in the library, named holder or not", () => {
    // Kept to "In library" for both — the two-word badge is the longest string that fits the
    // artwork it sits on without overflowing (see the function's own comment); "Held by ..." is
    // the sheet's job, with room for the full sentence.
    expect(
      searchBadgeLabel(result({ availableInGroup: true, holders: ["loft"] })),
    ).toBe("In library");
    expect(searchBadgeLabel(result({ availableInGroup: true }))).toBe(
      "In library",
    );
  });

  test("an open request badges as requested, not as available", () => {
    for (const state of ["pending", "approved", "fulfilling"] as const) {
      expect(searchBadgeLabel(result({ requestState: state }))).toBe(
        "Requested",
      );
    }
  });

  test("a declined or failed request carries no badge — neither is a permanent no", () => {
    expect(searchBadgeLabel(result({ requestState: "declined" }))).toBeNull();
    expect(searchBadgeLabel(result({ requestState: "failed" }))).toBeNull();
  });

  test("an untouched title carries no badge", () => {
    expect(searchBadgeLabel(result())).toBeNull();
  });
});

describe("toRequestCard", () => {
  test("a search result becomes a card keyed on its item key", () => {
    const card = toRequestCard({
      kind: "series",
      title: "Lost",
      year: 2004,
      posterUrl: "https://image.tmdb.org/lost.jpg",
      tmdbId: 0,
      tvdbId: 73739,
      itemKey: "episode:tvdb:73739:",
      availableInGroup: true,
      holders: ["loft"],
    });
    expect(card.id).toBe("episode:tvdb:73739:");
    expect(card.title).toBe("Lost");
    expect(card.subtitle).toBe("2004");
    expect(card.imageUrl).toBe("https://image.tmdb.org/lost.jpg");
    expect(card.imageAlt).toBe("Lost (2004)");
    expect(card.badgeLabel).toBe("In library");
    expect(card.placeholder).toBe("series");
  });

  test("a search result with no item key falls back to a synthetic one, not an empty id", () => {
    const card = toRequestCard({
      kind: "movie",
      title: "Big Buck Bunny",
      tmdbId: 10378,
      tvdbId: 0,
      itemKey: "",
      availableInGroup: false,
      holders: [],
    });
    expect(card.id).toBe("movie:10378");
  });

  test("a member's own request becomes a card keyed on the request id, badged with its state", () => {
    const card = toRequestCard(
      toRequest({
        Id: "abc",
        Kind: "movie",
        Title: "Sintel",
        State: "fulfilling",
      }),
    );
    expect(card.id).toBe("abc");
    expect(card.badgeLabel).toBe("Downloading");
    expect(card.placeholder).toBe("movie");
  });
});

describe("RequestsUnavailableError", () => {
  test("is an Error, so a query's generic catch still works", () => {
    const error = new RequestsUnavailableError(
      "Requests are not set up on this server.",
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.unavailable).toBe(true);
    expect(error.message).toBe("Requests are not set up on this server.");
  });
});

describe("one search box, two catalogues", () => {
  const result = (
    over: Partial<RequestSearchResult> = {},
  ): RequestSearchResult => ({
    kind: "movie",
    title: "Alien",
    year: 1979,
    tmdbId: 348,
    tvdbId: 0,
    itemKey: "movie:tmdb:348",
    availableInGroup: false,
    holders: [],
    ...over,
  });

  const request = (over: Partial<MemberRequest> = {}): MemberRequest => ({
    id: "r1",
    group: "g1",
    kind: "movie",
    itemKey: "movie:tmdb:348",
    provider: "tmdb",
    providerId: 348,
    title: "Alien",
    year: 1979,
    seasons: [],
    state: "pending",
    requestedBy: "u1",
    requestedByName: "dan",
    requestedAt: "2026-09-07T10:00:00Z",
    note: "",
    mine: true,
    updatedAt: "2026-09-07T10:00:00Z",
    ...over,
  });

  test("an id of zero is not an identity — the arrs send it for 'I do not know'", () => {
    expect(providerKey("tmdb", 0)).toBeNull();
    expect(providerKey("", 348)).toBeNull();
    expect(providerKey("TMDB", 348)).toBe("tmdb:348");
  });

  test("a title key needs a year, and carries the kind with it", () => {
    expect(titleKey("movie", "Alien", null)).toBeNull();
    expect(titleKey("movie", "", 1979)).toBeNull();
    expect(titleKey("movie", "WALL·E", 2008)).toBe("movie:wall e:2008");
    // The film and the series of the same name and year are not the same title.
    expect(titleKey("series", "Alien", 1979)).not.toBe(
      titleKey("movie", "Alien", 1979),
    );
  });

  test("a film the server already holds is not offered as one to ask for", () => {
    const keys = libraryMatchKeys([
      {
        Type: "Movie",
        Name: "Alien",
        ProductionYear: 1979,
        ProviderIds: { Tmdb: "348" },
      },
    ]);
    const { requestable, heldByMember } = splitCatalogueResults(
      [
        result(),
        result({
          title: "Aliens",
          year: 1986,
          tmdbId: 679,
          itemKey: "movie:tmdb:679",
        }),
      ],
      keys,
    );
    expect(heldByMember).toHaveLength(0);
    expect(requestable.map((r) => r.title)).toEqual(["Aliens"]);
  });

  test("a library item with no provider ids still matches on title and year", () => {
    // The normal state of anything added before its metadata was fetched — and the case that
    // would otherwise offer a member a download of a film already on the shelf above.
    const keys = libraryMatchKeys([
      { Type: "Movie", Name: "alien!", ProductionYear: 1979 },
    ]);
    expect(splitCatalogueResults([result()], keys).requestable).toHaveLength(0);
  });

  test("a series in the library does not swallow a film of the same name", () => {
    const keys = libraryMatchKeys([
      { Type: "Series", Name: "Alien", ProductionYear: 1979 },
    ]);
    expect(splitCatalogueResults([result()], keys).requestable).toHaveLength(1);
  });

  test("a title somebody in the group holds belongs with the library, not with the asks", () => {
    const { heldByMember, requestable } = splitCatalogueResults(
      [result({ availableInGroup: true, holders: ["loft"] })],
      new Set(),
    );
    expect(requestable).toHaveLength(0);
    expect(heldByMember).toHaveLength(1);
    // ...and so does one whose own request already landed.
    expect(
      splitCatalogueResults([result({ requestState: "available" })], new Set())
        .heldByMember,
    ).toHaveLength(1);
  });

  test("the same title answered twice by two lookups is listed once", () => {
    const { requestable } = splitCatalogueResults(
      [result(), result({ itemKey: "movie:tvdb:1", tvdbId: 1 })],
      new Set(),
    );
    expect(requestable).toHaveLength(1);
  });

  test("a request the member has already made shows as requested before the node says so", () => {
    // The node annotates every result from its own store, but that annotation is a round trip
    // behind the mutation; a poster still reading "Request" a second after you asked for it
    // reads as a button that did nothing.
    const [only] = splitCatalogueResults([result()], new Set(), [
      request(),
    ]).requestable;
    expect(only.requestState).toBe("pending");
    expect(only.requestId).toBe("r1");
    expect(searchBadgeLabel(only)).toBe("Requested");
    expect(searchAction(only).disabled).toBe(true);
  });

  test("the node's own answer wins over the local list", () => {
    const [only] = splitCatalogueResults(
      [result({ requestState: "failed" })],
      new Set(),
      [request({ state: "pending" })],
    ).requestable;
    expect(only.requestState).toBe("failed");
    // Failed is not a permanent no, so it is offered again.
    expect(searchAction(only).disabled).toBe(false);
  });

  test("an episode's ids are its own, so they never reach the comparison", () => {
    // `libraryMatchKeys` is fed films and series only; this pins what it does with what it is
    // given rather than the caller's choice, which is that an episode row would add its own
    // title and year as if it were a film.
    expect(libraryMatchKeys([])).toEqual(new Set());
    expect(
      libraryMatchKeys([
        { Type: "Movie", Name: "Alien", ProductionYear: null },
      ]),
    ).toEqual(new Set());
  });
});
