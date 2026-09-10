import { describe, expect, test } from "bun:test";
import type { MediaSourceInfo } from "@jellyfin/sdk/lib/generated-client/models";
import {
  buildSourceChoices,
  fileHashFromETag,
  formatBitrate,
  formatSourceChoice,
  type PlaybackPolicy,
  type SourceChoiceLabels,
} from "./sourceChooser";
import type { ItemSource, ItemSourcesResponse } from "./sources";

// `sourceChooser` is deliberately a pure join over two plain shapes, so this file needs no
// react-native stub and no network: everything below is data in, data out.

const GROUP = "a".repeat(64);
const NODE_A = "1".repeat(64);
const NODE_B = "2".repeat(64);
const NODE_C = "3".repeat(64);

const LABELS: SourceChoiceLabels = {
  direct: "Direct",
  relayed: "Relayed",
  connecting: "Connecting",
  offline: "Offline",
  recommended: "Recommended",
  sameFile: "Same file",
  playing: "Playing",
};

const streamUrl = (node: string) =>
  `https://stingstream.local/stream/${GROUP}/movie%3Atmdb%3A1/${node}`;

/** A `.strm` MediaSource, as this node's federated-library materializer writes one. */
const meshSource = (id: string, node: string): MediaSourceInfo => ({
  Id: id,
  Path: streamUrl(node),
  IsRemote: true,
  Name: "Federated",
});

/** The ordinary local file: a real path, and not remote. */
const localSource = (
  id: string,
  height = 1080,
  bitrate = 8_000_000,
): MediaSourceInfo => ({
  Id: id,
  Path: "E:/Media/Movies/Title (2020)/Title (2020) - 1080p.mkv",
  IsRemote: false,
  Bitrate: bitrate,
  MediaStreams: [{ Type: "Video", Height: height, Width: height * 2 }],
});

const source = (over: Partial<ItemSource> & { node: string }): ItemSource => ({
  nodeName: `Node ${over.node[0]}`,
  group: GROUP,
  online: true,
  score: 0,
  neededBps: 0,
  fits: true,
  measured: true,
  reasons: [],
  streamUrl: streamUrl(over.node),
  isLocal: false,
  mediaSourceId: null,
  ...over,
});

const response = (
  sources: ItemSource[],
  policy: PlaybackPolicy = "speed_first",
): ItemSourcesResponse => ({
  itemKey: "movie:tmdb:1",
  policy,
  heldLocally: false,
  sources,
});

const build = (
  mediaSources: MediaSourceInfo[],
  res: ItemSourcesResponse | null,
  policy: PlaybackPolicy = "speed_first",
  currentMediaSourceId?: string,
) =>
  buildSourceChoices(mediaSources, res, {
    policy,
    currentMediaSourceId,
    localLabel: "This server",
  });

describe("buildSourceChoices — the join", () => {
  test("pairs each .strm pointer with the holder its URL names", () => {
    const choices = build(
      [meshSource("ms-a", NODE_A), meshSource("ms-b", NODE_B)],
      response([
        source({ node: NODE_B, nodeName: "Kitchen", rttMs: 8 }),
        source({ node: NODE_A, nodeName: "Loft", rttMs: 40 }),
      ]),
    );

    expect(choices.map((c) => c.nodeName).sort()).toEqual(["Kitchen", "Loft"]);
    expect(choices.find((c) => c.nodeName === "Kitchen")?.mediaSourceId).toBe(
      "ms-b",
    );
    expect(choices.find((c) => c.nodeName === "Loft")?.rttMs).toBe(40);
  });

  test("matches node ids without regard to case", () => {
    const choices = build(
      [meshSource("ms-a", NODE_A.toUpperCase())],
      response([source({ node: NODE_A, nodeName: "Loft" })]),
    );
    expect(choices).toHaveLength(1);
    expect(choices[0].nodeName).toBe("Loft");
  });

  test("omits a source the group index lists but this node has no MediaSource for", () => {
    // The gap noted in docs/UI-API-GAPS.md: nothing to play means nothing to offer.
    const choices = build(
      [meshSource("ms-a", NODE_A)],
      response([
        source({ node: NODE_A, nodeName: "Loft" }),
        source({ node: NODE_C, nodeName: "Ghost" }),
      ]),
    );
    expect(choices.map((c) => c.nodeName)).toEqual(["Loft"]);
  });

  test("omits a pointer whose holder has left the group index", () => {
    const choices = build(
      [meshSource("ms-a", NODE_A), meshSource("ms-stale", NODE_C)],
      response([source({ node: NODE_A, nodeName: "Loft" })]),
    );
    expect(choices.map((c) => c.mediaSourceId)).toEqual(["ms-a"]);
  });

  test("labels the local file rather than trying to join it", () => {
    const choices = build(
      [localSource("ms-local", 2160), meshSource("ms-a", NODE_A)],
      response([source({ node: NODE_A, nodeName: "Loft" })]),
    );
    const local = choices.find((c) => c.local);
    expect(local?.nodeName).toBe("This server");
    expect(local?.resolution).toBe("2160p");
    expect(local?.online).toBe(true);
    expect(local?.rttMs).toBeNull();
  });

  test("names two local files apart, and leaves a single one as the place", () => {
    // A folder holding a 1080p and a 720p cut is an ordinary library; two rows both reading
    // "This server" would be a coin toss.
    const hd: MediaSourceInfo = {
      ...localSource("ms-1080", 1080, 12_000_000),
      Name: "Title (2020) - 1080p",
    };
    const sd: MediaSourceInfo = {
      ...localSource("ms-720", 720, 4_000_000),
      Name: "Title (2020) - 720p",
    };
    const two = build([hd, sd], null, "quality_first");
    expect(two.map((c) => c.nodeName)).toEqual([
      "This server · Title (2020) - 1080p",
      "This server · Title (2020) - 720p",
    ]);

    const one = build([hd], null);
    expect(one.map((c) => c.nodeName)).toEqual(["This server"]);
  });

  test("ignores a remote MediaSource that is not a mesh pointer", () => {
    const tuner: MediaSourceInfo = {
      Id: "ms-tuner",
      Path: "http://192.168.0.9:5004/auto/v3",
      IsRemote: true,
    };
    expect(build([tuner], response([]))).toEqual([]);
  });

  test("survives a missing sources response with the local copy alone", () => {
    const choices = build([localSource("ms-local")], null);
    expect(choices).toHaveLength(1);
    expect(choices[0].local).toBe(true);
  });
});

describe("buildSourceChoices — ordering", () => {
  const sources = [
    localSource("ms-local", 720, 3_000_000),
    meshSource("ms-a", NODE_A),
    meshSource("ms-b", NODE_B),
  ];
  const res = response([
    source({
      node: NODE_A,
      nodeName: "Loft",
      height: 2160,
      bitrate: 45_000_000,
      rttMs: 90,
      path: "relay",
    }),
    source({
      node: NODE_B,
      nodeName: "Kitchen",
      height: 1080,
      bitrate: 8_000_000,
      rttMs: 12,
      path: "direct",
    }),
  ]);

  test("speed_first puts the local copy first, then the direct hop", () => {
    const choices = build(sources, res, "speed_first");
    expect(choices.map((c) => c.nodeName)).toEqual([
      "This server",
      "Kitchen",
      "Loft",
    ]);
  });

  test("quality_first puts the best encode first, local last", () => {
    const choices = build(sources, res, "quality_first");
    expect(choices.map((c) => c.nodeName)).toEqual([
      "Loft",
      "Kitchen",
      "This server",
    ]);
  });

  test("an unmeasured hop sorts behind every measured one under speed_first", () => {
    const choices = build(
      [meshSource("ms-a", NODE_A), meshSource("ms-b", NODE_B)],
      response([
        source({ node: NODE_A, nodeName: "Unmeasured", path: null }),
        source({
          node: NODE_B,
          nodeName: "Measured",
          rttMs: 200,
          path: "direct",
        }),
      ]),
      "speed_first",
    );
    expect(choices.map((c) => c.nodeName)).toEqual(["Measured", "Unmeasured"]);
  });

  test("offline holders sort last and are disabled under both policies", () => {
    const mediaSources = [
      meshSource("ms-a", NODE_A),
      meshSource("ms-b", NODE_B),
    ];
    const res2 = response([
      source({
        node: NODE_A,
        nodeName: "Dark",
        online: false,
        height: 2160,
        bitrate: 60_000_000,
        rttMs: 1,
      }),
      source({
        node: NODE_B,
        nodeName: "Lit",
        online: true,
        height: 720,
        bitrate: 3_000_000,
        rttMs: 300,
        path: "relay",
      }),
    ]);

    for (const policy of ["speed_first", "quality_first"] as const) {
      const choices = build(mediaSources, res2, policy);
      expect(choices.map((c) => c.nodeName)).toEqual(["Lit", "Dark"]);
      expect(choices.map((c) => c.disabled)).toEqual([false, true]);
    }
  });
});

describe("buildSourceChoices — recommendation", () => {
  test("takes the server's pick when the policies agree", () => {
    // The server ranked Loft first despite the worse round trip; it saw inputs the client never
    // receives, so an agreeing client does not second-guess it.
    const choices = build(
      [meshSource("ms-a", NODE_A), meshSource("ms-b", NODE_B)],
      response(
        [
          source({ node: NODE_A, nodeName: "Loft", rttMs: 90, path: "direct" }),
          source({
            node: NODE_B,
            nodeName: "Kitchen",
            rttMs: 12,
            path: "direct",
          }),
        ],
        "speed_first",
      ),
      "speed_first",
    );
    expect(choices.find((c) => c.recommended)?.nodeName).toBe("Loft");
  });

  test("re-sorts under the client policy when the server used another one", () => {
    const choices = build(
      [meshSource("ms-a", NODE_A), meshSource("ms-b", NODE_B)],
      response(
        [
          source({
            node: NODE_A,
            nodeName: "Loft",
            height: 2160,
            rttMs: 90,
            path: "relay",
          }),
          source({
            node: NODE_B,
            nodeName: "Kitchen",
            height: 1080,
            rttMs: 12,
            path: "direct",
          }),
        ],
        "quality_first",
      ),
      "speed_first",
    );
    expect(choices.find((c) => c.recommended)?.nodeName).toBe("Kitchen");
  });

  test("falls back to the client ordering when the server's pick has no MediaSource", () => {
    const choices = build(
      [localSource("ms-local", 1080), meshSource("ms-a", NODE_A)],
      response(
        [
          // The local node's own index entry: real to the server, unplayable as a pointer.
          source({ node: NODE_C, nodeName: "Here", rttMs: 1 }),
          source({ node: NODE_A, nodeName: "Loft", rttMs: 40 }),
        ],
        "speed_first",
      ),
      "speed_first",
    );
    expect(choices.find((c) => c.recommended)?.nodeName).toBe("This server");
  });

  test("never recommends an offline holder", () => {
    const choices = build(
      [meshSource("ms-a", NODE_A), meshSource("ms-b", NODE_B)],
      response([
        source({ node: NODE_A, nodeName: "Dark", online: false, rttMs: 1 }),
        source({ node: NODE_B, nodeName: "Lit", rttMs: 400, path: "relay" }),
      ]),
    );
    expect(choices.find((c) => c.recommended)?.nodeName).toBe("Lit");
  });

  test("recommends nothing when nothing is playable", () => {
    const choices = build(
      [meshSource("ms-a", NODE_A)],
      response([source({ node: NODE_A, nodeName: "Dark", online: false })]),
    );
    expect(choices.some((c) => c.recommended)).toBe(false);
  });
});

describe("buildSourceChoices — same file", () => {
  test("marks the byte-identical alternatives to what is playing", () => {
    const hash = "b3:deadbeef";
    const choices = build(
      [
        meshSource("ms-a", NODE_A),
        meshSource("ms-b", NODE_B),
        meshSource("ms-c", NODE_C),
      ],
      response([
        source({ node: NODE_A, nodeName: "Loft", fileHash: hash }),
        source({ node: NODE_B, nodeName: "Kitchen", fileHash: hash }),
        source({ node: NODE_C, nodeName: "Shed", fileHash: "b3:other" }),
      ]),
      "speed_first",
      "ms-a",
    );

    expect(choices.find((c) => c.nodeName === "Loft")?.current).toBe(true);
    // The source playing is not "the same file as" itself — that badge is about the alternatives.
    expect(choices.find((c) => c.nodeName === "Loft")?.sameFileAsCurrent).toBe(
      false,
    );
    expect(
      choices.find((c) => c.nodeName === "Kitchen")?.sameFileAsCurrent,
    ).toBe(true);
    expect(choices.find((c) => c.nodeName === "Shed")?.sameFileAsCurrent).toBe(
      false,
    );
  });

  test("pairs the local copy with a remote holder through the ETag", () => {
    // The local file has no entry in the scored list, so its weak ETag is the only hash it has.
    const local: MediaSourceInfo = {
      ...localSource("ms-local"),
      ETag: 'W/"b3-deadbeef"',
    };
    const choices = build(
      [local, meshSource("ms-a", NODE_A)],
      response([
        source({ node: NODE_A, nodeName: "Loft", fileHash: "deadbeef" }),
      ]),
      "speed_first",
      "ms-a",
    );
    expect(
      choices.find((c) => c.mediaSourceId === "ms-local")?.sameFileAsCurrent,
    ).toBe(true);
  });

  test("reads a hash out of every spelling of the ETag", () => {
    expect(fileHashFromETag('W/"b3-deadbeef"')).toBe("deadbeef");
    expect(fileHashFromETag('"b3-deadbeef"')).toBe("deadbeef");
    expect(fileHashFromETag("deadbeef")).toBe("deadbeef");
    expect(fileHashFromETag("")).toBeNull();
    expect(fileHashFromETag(null)).toBeNull();
  });

  test("claims nothing when the holders report no hash", () => {
    const choices = build(
      [meshSource("ms-a", NODE_A), meshSource("ms-b", NODE_B)],
      response([
        source({ node: NODE_A, nodeName: "Loft" }),
        source({ node: NODE_B, nodeName: "Kitchen" }),
      ]),
      "speed_first",
      "ms-a",
    );
    expect(choices.some((c) => c.sameFileAsCurrent)).toBe(false);
  });
});

describe("formatSourceChoice", () => {
  test("reads as resolution, bitrate, latency, route", () => {
    const [choice] = build(
      [meshSource("ms-a", NODE_A)],
      response([
        source({
          node: NODE_A,
          nodeName: "Loft",
          height: 2160,
          bitrate: 45_000_000,
          rttMs: 18,
          path: "direct",
        }),
      ]),
    );
    const formatted = formatSourceChoice(choice, LABELS);
    expect(formatted.title).toBe("Loft");
    expect(formatted.subtitle).toBe("2160p · 45 Mb/s · 18 ms · Direct");
    expect(formatted.badges).toEqual(["Recommended"]);
  });

  test("drops the parts the holder never reported", () => {
    const [choice] = build(
      [meshSource("ms-a", NODE_A)],
      response([source({ node: NODE_A, nodeName: "Loft", path: "relay" })]),
    );
    expect(formatSourceChoice(choice, LABELS).subtitle).toBe("Relayed");
  });

  test("badges an offline holder", () => {
    const [choice] = build(
      [meshSource("ms-a", NODE_A)],
      response([
        source({ node: NODE_A, nodeName: "Dark", online: false, height: 1080 }),
      ]),
    );
    expect(formatSourceChoice(choice, LABELS).badges).toEqual(["Offline"]);
  });

  test("formats a bitrate at the precision it deserves", () => {
    expect(formatBitrate(45_000_000)).toBe("45 Mb/s");
    expect(formatBitrate(4_500_000)).toBe("4.5 Mb/s");
    expect(formatBitrate(800_000)).toBe("800 kb/s");
    expect(formatBitrate(0)).toBeNull();
    expect(formatBitrate(null)).toBeNull();
  });
});

describe("a local file and a peer's copy on one item", () => {
  // Before locally-held titles were materialized these two could not appear together: a title was
  // either on this server or in the group, never both. Every assertion here is about the case that
  // used not to exist.

  test("quality_first lets a peer's 2160p beat the local 1080p", () => {
    const choices = build(
      [localSource("local", 1080), meshSource("ms-a", NODE_A)],
      response(
        [source({ node: NODE_A, nodeName: "Attic", height: 2160, rttMs: 18 })],
        "quality_first",
      ),
      "quality_first",
    );

    expect(choices[0].local).toBe(false);
    expect(choices[0].nodeName).toBe("Attic");
  });

  test("speed_first keeps the local file even against a direct 2160p at 1 ms", () => {
    // Route outranks everything under speed_first, and nothing outranks having no hop at all.
    const choices = build(
      [localSource("local", 720), meshSource("ms-a", NODE_A)],
      response([
        source({
          node: NODE_A,
          nodeName: "Attic",
          height: 2160,
          rttMs: 1,
          path: "direct",
        }),
      ]),
    );

    expect(choices[0].local).toBe(true);
  });

  test("one item, one local row and one row per holder", () => {
    const choices = build(
      [
        localSource("local"),
        meshSource("ms-a", NODE_A),
        meshSource("ms-b", NODE_B),
      ],
      response([
        source({ node: NODE_A, nodeName: "Attic" }),
        source({ node: NODE_B, nodeName: "Loft" }),
      ]),
    );

    expect(choices).toHaveLength(3);
    expect(choices.filter((c) => c.local)).toHaveLength(1);
    expect(choices.filter((c) => c.route === "local")).toHaveLength(1);
  });

  test("the local row can be Recommended when the server picked it", () => {
    // The server names the media source now, so its pick joins exactly. Joining on node id alone
    // could never land on the local row, which carries no node id at all — so before this the copy
    // on your own server could never wear the badge even when it was the server's own answer.
    const choices = build(
      [localSource("local", 2160), meshSource("ms-a", NODE_A)],
      response([
        source({
          node: "local",
          nodeName: "This server",
          isLocal: true,
          mediaSourceId: "local",
          height: 2160,
        }),
        source({ node: NODE_A, nodeName: "Attic", height: 1080 }),
      ]),
    );

    expect(choices.find((c) => c.recommended)?.local).toBe(true);
  });

  test("…and by the isLocal flag alone when the media source id is missing", () => {
    const choices = build(
      [localSource("local", 2160), meshSource("ms-a", NODE_A)],
      response([
        source({
          node: "local",
          nodeName: "This server",
          isLocal: true,
          height: 2160,
        }),
        source({ node: NODE_A, nodeName: "Attic", height: 1080 }),
      ]),
    );

    expect(choices.find((c) => c.recommended)?.local).toBe(true);
  });

  test("a peer's pick still joins by node id when it names no media source", () => {
    const choices = build(
      [localSource("local"), meshSource("ms-a", NODE_A)],
      response(
        [
          source({ node: NODE_A, nodeName: "Attic", height: 2160 }),
          source({ node: "local", nodeName: "This server", isLocal: true }),
        ],
        "quality_first",
      ),
      "quality_first",
    );

    expect(choices.find((c) => c.recommended)?.nodeName).toBe("Attic");
  });

  test("the local copy is marked as the same file when a peer holds identical bytes", () => {
    // The direction that matters for a mid-film failover off a local disk: the app has to know
    // there are identical bytes elsewhere before it can resume by offset rather than restarting.
    const local = { ...localSource("local"), ETag: 'W/"b3-abc123"' };
    const choices = build(
      [local, meshSource("ms-a", NODE_A)],
      response([
        source({ node: NODE_A, nodeName: "Attic", fileHash: "ABC123" }),
      ]),
      "speed_first",
      "local",
    );

    expect(choices.find((c) => c.nodeName === "Attic")?.sameFileAsCurrent).toBe(
      true,
    );
  });
});
