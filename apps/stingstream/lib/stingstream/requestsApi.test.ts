import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "i18next";
import { SessionExpiredError } from "@/utils/sessionExpiry";
import en from "../../translations/en.json";
import {
  AlreadyHeldError,
  createRequest,
  DEFAULT_REQUEST_FILTERS,
  dedupeSearchResults,
  discoverRequestable,
  fetchCredits,
  fetchRelated,
  fetchRequestsAvailable,
  impliesApproval,
  type LibraryIdentity,
  type MemberRequest,
  providerKey,
  type RequestSearchResult,
  RequestsUnavailableError,
  reasonsFor,
  requestCardId,
  requestHoverGlyph,
  requestTitle,
  sameUser,
  searchAction,
  searchBadgeLabel,
  seasonsLabel,
  selectMine,
  shouldOfferRequest,
  stateLabel,
  stateTone,
  titleKey,
  toCounts,
  toDiscoverPage,
  toNotification,
  toPolicy,
  toRequest,
  toRequestableCard,
  toRequestCard,
  toRequestDetail,
  toSearchResult,
  withoutCurrentTitle,
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
  fulfillingServerName: "loft",
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
    expect(counts.wanted).toBe(0);
  });

  test("a node that says nothing about its mode is treated as automatic", () => {
    // The upgrade case. A node built before manual mode existed has always behaved automatically,
    // and reading silence as manual would take an administrator's approval queue away on upgrade.
    expect(toCounts({}).requestsMode).toBe("automatic");
    expect(toCounts({ RequestsMode: "weird" }).requestsMode).toBe("automatic");
  });

  test("a node with no indexer says so, in either casing", () => {
    expect(toCounts({ RequestsMode: "manual" }).requestsMode).toBe("manual");
    expect(toCounts({ requestsMode: "manual" }).requestsMode).toBe("manual");
    expect(toCounts({ Wanted: 4 }).wanted).toBe(4);
  });

  test("which reasons apply depends on there being episodes to be missing", () => {
    expect(reasonsFor("movie")).toEqual(["better_quality", "bad_copy"]);
    expect(reasonsFor("series")[0]).toBe("missing_episode");
  });

  test("only the states that wait on a person imply an approval", () => {
    // What the manual-mode label hangs off. A wanted request is waiting, but not on a decision:
    // saying "waiting for approval" there names a queue manual mode does not show.
    expect(impliesApproval("pending")).toBe(true);
    expect(impliesApproval("approved")).toBe(true);
    expect(impliesApproval("wanted")).toBe(false);
    expect(impliesApproval("fulfilling")).toBe(false);
    expect(impliesApproval("available")).toBe(false);
    expect(impliesApproval("declined")).toBe(false);
    expect(impliesApproval("failed")).toBe(false);
  });

  test("a reason survives the wire in either casing", () => {
    expect(toRequest({ Reason: "bad_copy" }).reason).toBe("bad_copy");
    expect(toRequest({ reasonNote: "out of sync" }).reasonNote).toBe(
      "out of sync",
    );
    expect(toRequest({}).reason).toBeUndefined();
  });

  test("a search result carries the item to play when one resolved", () => {
    expect(toSearchResult({ LocalItemId: "abc" }).localItemId).toBe("abc");
    // Absent is ordinary: a peer's copy becomes an item here only once materialisation catches up.
    expect(toSearchResult({}).localItemId).toBeUndefined();
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

  test("a search result carries what the filter bar narrows by", () => {
    const r = toSearchResult({
      Kind: "movie",
      Title: "Blade Runner",
      TmdbId: 78,
      ItemKey: "movie:tmdb:78",
      Genres: ["Science Fiction", "Drama"],
      Rating: 8.1,
      Popularity: 41.2,
      Runtime: 117,
    });
    expect(r.genres).toEqual(["Science Fiction", "Drama"]);
    expect(r.rating).toBe(8.1);
    expect(r.popularity).toBe(41.2);
    expect(r.runtime).toBe(117);
  });

  test("a result from a node that sends none of that reads as no genre, not every genre", () => {
    // An empty list is what `applyRequestFilters` needs to see. `undefined` would be a result the
    // genre chip could not decide about, and the tempting decision -- keep it -- is the one that
    // makes a genre filter quietly match a title with no genre at all.
    const bare = toSearchResult({
      Kind: "movie",
      Title: "Old node",
      TmdbId: 1,
    });
    expect(bare.genres).toEqual([]);
    expect(bare.rating).toBeUndefined();
    expect(bare.popularity).toBeUndefined();
    expect(bare.runtime).toBeUndefined();
  });

  test("a page of the catalogue carries its results and its genre options", () => {
    const page = toDiscoverPage({
      Results: [{ Kind: "movie", Title: "Blade Runner", TmdbId: 78 }],
      Page: 1,
      Genres: ["Action", "Drama"],
    });
    expect(page.results.map((r) => r.title)).toEqual(["Blade Runner"]);
    expect(page.genres).toEqual(["Action", "Drama"]);
    expect(page.page).toBe(1);
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

  test("a title the group already holds can still be asked for, with a reason", () => {
    // It used to be disabled, which answered "you already have this" and then refused to let
    // anybody say "yes, and the audio is broken". The pill beside the title still says it is in the
    // library; the button now starts the conversation about why it is being asked for anyway.
    const action = searchAction(
      result({ availableInGroup: true, holders: ["loft"] }),
    );
    expect(action.intent).toBe("duplicate");
    expect(action.disabled).toBe(false);
    expect(action.label).toBe("Request anyway");
  });

  test("a request already in flight is managed rather than made again", () => {
    // Asking twice for the same thing is not a thing to offer; doing something about the request
    // you already have is. The state moved to the pill beside the title and the button became the
    // action -- edit which seasons, or withdraw it.
    for (const state of ["pending", "approved", "fulfilling"] as const) {
      const action = searchAction(result({ requestState: state }));
      expect(action.intent).toBe("manage");
      expect(action.disabled).toBe(false);
    }
  });

  test("a filled request is a duplicate rather than a dead end", () => {
    // Not "manage": there is no request left to change. But the thing being there is exactly when
    // somebody wants a missing episode, a better release, or a replacement for a bad copy.
    const action = searchAction(result({ requestState: "available" }));
    expect(action.intent).toBe("duplicate");
    expect(action.disabled).toBe(false);
  });

  test("a wanted request is the requester's to change, not a duplicate", () => {
    // Nothing is searching for it, so "Already requested" would overstate it and there is no
    // approval to be awaiting. It is still theirs to edit or withdraw.
    const action = searchAction(result({ requestState: "wanted" }));
    expect(action.intent).toBe("manage");
    expect(action.label).toBe("Waiting");
  });

  test("an open request wins over the group already holding the title", () => {
    // Somebody who asked for a missing season should land on their own request, not be sent round
    // the "you already have this" question for a title they know the group has.
    const action = searchAction(
      result({ availableInGroup: true, requestState: "pending" }),
    );
    expect(action.intent).toBe("manage");
  });

  test("a declined or failed request may be asked for again, and says so", () => {
    // The first was refused by a person who may have changed their mind; the second failed for
    // reasons that may have gone away. Neither is a permanent no. The node reopens the row that is
    // already there rather than making a second one, and the label says which press this is.
    for (const state of ["declined", "failed"] as const) {
      const action = searchAction(result({ requestState: state }));
      expect(action.disabled).toBe(false);
      expect(action.intent).toBe("request");
      expect(action.label).toBe("Request again");
    }
  });

  test("an untouched title is offered", () => {
    const action = searchAction(result());
    expect(action.disabled).toBe(false);
    expect(action.intent).toBe("request");
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
    // Kept to "In library" for both. The two-word badge is the longest string that fits the
    // artwork it sits on without overflowing (see the function's own comment), and it is now the
    // only thing said about it: naming which node holds a title told the reader nothing they
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

describe("the same title, answered twice", () => {
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
    // The movie and the series of the same name and year are not the same title.
    expect(titleKey("series", "Alien", 1979)).not.toBe(
      titleKey("movie", "Alien", 1979),
    );
  });

  test("the same title answered twice by two lookups is listed once", () => {
    // A movie and a series lookup are two calls against two providers; the movie comes back keyed on
    // TMDB and the series on TheTVDB, and the shared title and year is what ties them together.
    expect(
      dedupeSearchResults([
        result(),
        result({ itemKey: "movie:tvdb:1", tmdbId: 0, tvdbId: 1 }),
      ]),
    ).toHaveLength(1);
  });

  test("two genuinely different movies are both kept, in the node's order", () => {
    const rows = dedupeSearchResults([
      result(),
      result({
        title: "Aliens",
        year: 1986,
        tmdbId: 679,
        itemKey: "movie:tmdb:679",
      }),
    ]);
    expect(rows.map((r) => r.title)).toEqual(["Alien", "Aliens"]);
  });

  test("a title the group already holds is kept — the row says so, it is not hidden", () => {
    // The interesting answer is usually "somebody already has this", and dropping the row would
    // send the member back to searching for something they can already watch.
    const [only] = dedupeSearchResults([
      result({ availableInGroup: true, holders: ["loft"] }),
    ]);
    expect(only.holders).toEqual(["loft"]);
    expect(searchAction(only).intent).toBe("duplicate");
  });

  test("a request the member has already made shows as requested before the node says so", () => {
    // The node annotates every result from its own store, but that annotation is a round trip
    // behind the mutation; a row still reading "Request" a second after you asked for it reads as
    // a button that did nothing.
    const [only] = dedupeSearchResults([result()], [request()]);
    expect(only.requestState).toBe("pending");
    expect(only.requestId).toBe("r1");
    expect(searchBadgeLabel(only)).toBe("Requested");
    expect(searchAction(only).intent).toBe("manage");
  });

  test("the node's own answer wins over the local list", () => {
    const [only] = dedupeSearchResults(
      [result({ requestState: "failed" })],
      [request({ state: "pending" })],
    );
    expect(only.requestState).toBe("failed");
    // Failed is not a permanent no, so it is offered again.
    expect(searchAction(only).disabled).toBe(false);
  });
});

describe("when Search offers to go and ask", () => {
  const item = (Name: string, Type = "Movie"): LibraryIdentity => ({
    Type,
    Name,
    ProductionYear: 1979,
  });

  test("nothing typed is not a fuzzy match, it is no question yet", () => {
    expect(shouldOfferRequest("", [])).toBe(false);
    expect(shouldOfferRequest("   ", [item("Alien")])).toBe(false);
  });

  test("no matches at all is the clearest case for offering", () => {
    expect(shouldOfferRequest("Dune", [])).toBe(true);
  });

  test("an exact title match is an answer, so nothing is offered", () => {
    expect(shouldOfferRequest("Alien", [item("Alien")])).toBe(false);
  });

  test("case, punctuation and spacing do not make a title a different one", () => {
    expect(shouldOfferRequest("wall-e", [item("WALL·E")])).toBe(false);
    expect(shouldOfferRequest("  THE   THING ", [item("The Thing")])).toBe(
      false,
    );
  });

  test("a near miss is exactly when somebody wants to ask", () => {
    // "Aliens" matched "Alien" — the library answered, but not with what was typed.
    expect(shouldOfferRequest("Aliens", [item("Alien")])).toBe(true);
  });

  test("the year is not part of the comparison", () => {
    // A person types "dune", not "dune (2021)"; requiring the year would offer to request
    // something that is plainly sitting in the results.
    expect(
      shouldOfferRequest("Dune", [
        { Type: "Movie", Name: "Dune", ProductionYear: null },
      ]),
    ).toBe(false);
  });

  test("one exact match among many near ones is still an answer", () => {
    expect(
      shouldOfferRequest("Dune", [
        item("Dune: Part Two"),
        item("Dune", "Series"),
      ]),
    ).toBe(false);
  });
});

const BASE = "https://node.example.com/stingstream/api/v1";

describe("fetchRequestsAvailable", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Answers one status for whatever it is asked, and remembers the URL. */
  const stub = (status: number) => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(typeof url === "string" ? url : url.toString());
      return new Response(status === 503 ? "" : "[]", { status });
    }) as unknown as typeof fetch;
    return calls;
  };

  test("asks the one endpoint that can refuse, with an empty term", async () => {
    const calls = stub(200);
    await fetchRequestsAvailable(BASE);
    // The empty `q` is the whole point: Core returns 503 before it looks at the term, and returns
    // an empty list without touching either manager when it does. A probe that sent a real search
    // term would cost two metadata lookups per visit to the screen.
    expect(calls).toEqual([`${BASE}/requests/search?q=`]);
  });

  test("503 is the node saying neither manager is configured", async () => {
    stub(503);
    expect(await fetchRequestsAvailable(BASE)).toBe(false);
  });

  test("anything else is a working feature, however badly", async () => {
    stub(200);
    expect(await fetchRequestsAvailable(BASE)).toBe(true);
    stub(500);
    // A broken node is not an unconfigured one. Gating the screen on this would replace whatever
    // the sections could say about a real failure with "requests are not set up", which is a lie.
    expect(await fetchRequestsAvailable(BASE)).toBe(true);
  });

  test("a network failure is not an answer", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    // Rejects rather than resolving false, so react-query holds `data` undefined and the screen
    // renders its sections instead of the gate.
    await expect(fetchRequestsAvailable(BASE)).rejects.toThrow("offline");
  });
});

/**
 * The endpoint the original report came in on. `GET /requests/discover` carries only the
 * controller's class-level `[Authorize]` — no elevation policy — so it never required an
 * administrator, and saying so to somebody whose token had been revoked sent them looking for a
 * permissions problem that did not exist.
 */
describe("discoverRequestable and an expired session", () => {
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    if (!i18n.isInitialized) {
      await i18n.init({
        lng: "en",
        fallbackLng: "en",
        resources: { en: { translation: en } },
        interpolation: { escapeValue: false },
      });
    }
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const stub = (status: number) => {
    globalThis.fetch = (async () =>
      new Response("", { status })) as unknown as typeof fetch;
  };

  const state = DEFAULT_REQUEST_FILTERS;

  test("401 no longer blames an administrator account", async () => {
    stub(401);

    const error = await discoverRequestable(BASE, state, 1).catch(
      (e: Error) => e,
    );

    expect(error).toBeInstanceOf(SessionExpiredError);
    expect((error as Error).message).not.toMatch(/administrator/i);
  });

  test("503 is still requests not being set up, ahead of everything else", async () => {
    stub(503);

    await expect(discoverRequestable(BASE, state, 1)).rejects.toBeInstanceOf(
      RequestsUnavailableError,
    );
  });
});

describe("createRequest and a library that already has it", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Answers one status and body for whatever it is asked. */
  const answer = (status: number, body: unknown) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  };

  test("a refusal carrying holders becomes something the screen can act on", async () => {
    // The bug this pins: the refusal used to be read as a generic failure and shown as one. The
    // sheet needs the holders and the item to play, because it is about to ask why somebody wants a
    // title they already have. Dan, seeing the raw failure: *"making a post results in 409"*.
    answer(409, {
      alreadyHeld: true,
      holders: ["ui-loop"],
      playableItemId: "5668552bb932169123ea476a8ed42243",
    });

    const err = await createRequest(BASE, { tmdbId: 10378 }).then(
      () => null,
      (e) => e,
    );

    expect(err).toBeInstanceOf(AlreadyHeldError);
    expect((err as AlreadyHeldError).holders).toEqual(["ui-loop"]);
    expect((err as AlreadyHeldError).playableItemId).toBe(
      "5668552bb932169123ea476a8ed42243",
    );
  });

  test("a 409 of any other shape stays an ordinary failure", async () => {
    // Only the shape we know is turned into a question about holders. Anything else on this route
    // is a real refusal and must not be answered with a reason picker.
    answer(409, { error: "something else entirely" });
    const err = await createRequest(BASE, { tmdbId: 1 }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AlreadyHeldError);
  });

  test("a refusal with no holders still asks the question", async () => {
    // The node resolves a playable item only once materialisation has caught up, and names holders
    // it can see. Neither is required to know the library has the title.
    answer(409, { alreadyHeld: true });
    const err = await createRequest(BASE, { tmdbId: 2 }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(AlreadyHeldError);
    expect((err as AlreadyHeldError).holders).toEqual([]);
    expect((err as AlreadyHeldError).playableItemId).toBeUndefined();
  });
});

describe("a mixed row: which titles play, and which ask", () => {
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

  test("a title this node can open carries the play glyph", () => {
    expect(
      requestHoverGlyph(result({ availableInGroup: true, localItemId: "abc" })),
    ).toBe("play");
  });

  test("a title nobody holds carries the request glyph", () => {
    expect(requestHoverGlyph(result())).toBe("request");
  });

  test("held by the group but not yet materialised here still asks", () => {
    // The one that matters. A peer's copy is held before the federated materialiser has made it an
    // item on this node, and in that window there is nothing here to open. A play disc would be a
    // press that goes nowhere, so the glyph under-promises and the press lands on the sheet, which
    // names the holder and offers Play the moment an id resolves.
    expect(
      requestHoverGlyph(result({ availableInGroup: true, localItemId: null })),
    ).toBe("request");
  });

  test("the card carries the same answer the press will act on", () => {
    const held = result({ availableInGroup: true, localItemId: "abc" });
    expect(toRequestableCard(held).hoverGlyph).toBe("play");
    expect(toRequestableCard(result()).hoverGlyph).toBe("request");
  });

  test("the held card keeps its In library badge", () => {
    // Load-bearing: on a touch screen there is no hover and so no disc at all, and this badge is
    // then the only thing telling the two kinds of card apart.
    const held = result({ availableInGroup: true, localItemId: "abc" });
    expect(toRequestableCard(held).badgeLabel).toBe("In library");
  });

  test("a screen reader hears which cards are not in the library", () => {
    // The disc is pointerEvents: none with no label of its own, so without this a screen reader
    // could not tell a title that plays from one that opens a request.
    expect(toRequestableCard(result(), "not in your library").imageAlt).toBe(
      "Alien (1979), not in your library",
    );
    const held = result({ availableInGroup: true, localItemId: "abc" });
    expect(toRequestableCard(held, "not in your library").imageAlt).toBe(
      "Alien (1979)",
    );
  });

  test("the card id matches what toRequestCard keyed on", () => {
    expect(requestCardId(result())).toBe(toRequestCard(result()).id);
  });

  test("a result with no item key still gets a distinct id", () => {
    expect(requestCardId(result({ itemKey: "" }))).toBe("movie:348");
  });
});

describe("related and credits", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  const answer = (status: number, body: unknown) => {
    globalThis.fetch = (async (input: string | URL) => {
      seen = String(input);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  };
  let seen = "";

  test("both read through the same shaper the search uses", async () => {
    // PascalCase, the way Core actually answers.
    answer(200, [
      {
        Kind: "movie",
        Title: "Aliens",
        Year: 1986,
        TmdbId: 679,
        ItemKey: "movie:tmdb:679",
        AvailableInGroup: true,
        LocalItemId: "abc",
      },
    ]);

    const related = await fetchRelated(BASE, { itemId: "deadbeef" });
    expect(related).toHaveLength(1);
    expect(related[0].title).toBe("Aliens");
    expect(related[0].availableInGroup).toBe(true);
    expect(related[0].localItemId).toBe("abc");
    expect(seen).toContain("/requests/related");
    expect(seen).toContain("itemId=deadbeef");

    const credits = await fetchCredits(BASE, "cafe");
    expect(credits[0].itemKey).toBe("movie:tmdb:679");
    expect(seen).toContain("/requests/credits");
    expect(seen).toContain("personId=cafe");
  });

  test("a node that cannot read the catalogue says so", async () => {
    answer(503, {});
    await expect(fetchRelated(BASE, { itemId: "x" })).rejects.toBeInstanceOf(
      RequestsUnavailableError,
    );
    await expect(fetchCredits(BASE, "x")).rejects.toBeInstanceOf(
      RequestsUnavailableError,
    );
  });

  test("an explicit provider id is sent instead of an item id", async () => {
    answer(200, []);
    await fetchRelated(BASE, { tmdbId: 348, kind: "movie" });
    expect(seen).toContain("tmdbId=348");
    expect(seen).toContain("kind=movie");
    expect(seen).not.toContain("itemId=");
  });
});

describe("withoutCurrentTitle", () => {
  const r = (over: Partial<RequestSearchResult>): RequestSearchResult => ({
    kind: "movie",
    title: "T",
    tmdbId: 1,
    tvdbId: 0,
    itemKey: "movie:tmdb:1",
    availableInGroup: false,
    holders: [],
    ...over,
  });

  test("keeps every title the library does not hold", () => {
    // The regression. A film has no SeriesId and an unheld result has no localItemId, so a bare
    // `!==` compared undefined with undefined, called it a match, and emptied the whole row.
    const results = [r({ title: "A" }), r({ title: "B" })];
    expect(withoutCurrentTitle(results, "abc", undefined)).toHaveLength(2);
  });

  test("drops the title you are standing on", () => {
    const results = [r({ title: "A", localItemId: "abc" }), r({ title: "B" })];
    expect(
      withoutCurrentTitle(results, "abc", undefined).map((x) => x.title),
    ).toEqual(["B"]);
  });

  test("drops the series an episode belongs to", () => {
    const results = [r({ title: "S", localItemId: "ser" }), r({ title: "B" })];
    expect(
      withoutCurrentTitle(results, "ep", "ser").map((x) => x.title),
    ).toEqual(["B"]);
  });

  test("keeps other held titles", () => {
    const results = [r({ title: "A", localItemId: "other" })];
    expect(withoutCurrentTitle(results, "abc", undefined)).toHaveLength(1);
  });
});
