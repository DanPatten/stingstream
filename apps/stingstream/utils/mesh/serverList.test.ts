import { describe, expect, test } from "bun:test";
import type { ConnectionRequestSummary } from "@/lib/stingstream/connections";
import type { MeshNodeGroup, MeshNodePeer } from "@/lib/stingstream/meshApi";
import {
  buildServerList,
  peerAddress,
  pendingInvitations,
} from "./serverList";

// Which servers the page lists, in what order, and which one is this one. Pinned here for the
// reason `buildUserRows` is: they are rules, and they should not need a mesh to check.

const peer = (over: Partial<MeshNodePeer> = {}): MeshNodePeer => ({
  group: "g1",
  node: "peer-node",
  serverName: "Sams Server",
  online: true,
  firstSeen: "2026-01-01T00:00:00Z",
  ...over,
});

const group = (over: Partial<MeshNodeGroup> = {}): MeshNodeGroup => ({
  group: "g1",
  name: "Loft",
  createdAt: "2026-09-01T00:00:00Z",
  ...over,
});

const request = (
  over: Partial<ConnectionRequestSummary> = {},
): ConnectionRequestSummary => ({
  id: "r1",
  node: "asking-node",
  serverName: "Nans Box",
  requestedByName: "nan",
  createdAt: "2026-09-12T00:00:00Z",
  mine: false,
  ...over,
});

const here = {
  node: "this-node",
  name: "Loft",
  address: "http://127.0.0.1:8801",
};

describe("buildServerList", () => {
  test("this server is first, and marked", () => {
    const rows = buildServerList(here, [peer()]);
    expect(rows.map((r) => [r.name, r.isThisServer])).toEqual([
      ["Loft", true],
      ["Sams Server", false],
    ]);
  });

  test("its address is on the row, not somewhere you have to open", () => {
    const rows = buildServerList(here, [
      peer({
        sideDoor: {
          node: "peer-node",
          candidates: [
            {
              kind: "own",
              host: "sam.example",
              port: 443,
              url: "https://sam.example",
            },
          ],
        },
      }),
    ]);
    expect(rows[0].address).toBe("http://127.0.0.1:8801");
    expect(rows[1].address).toBe("https://sam.example");
  });

  test("a peer in two groups appears once", () => {
    const rows = buildServerList(here, [
      peer({ group: "g1" }),
      peer({ group: "g2" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1].group).toBe("g1");
  });

  test("this server is never listed twice, however the mesh spells its id", () => {
    const rows = buildServerList(here, [peer({ node: "THIS-NODE" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].isThisServer).toBe(true);
  });

  test("nor before this node knows its own id", () => {
    // `/mesh/peers` lists this node among the peers, and the id it is recognised by arrives from a
    // different query. Dan: *"why do I see servers listed twice like that"*.
    const rows = buildServerList({ ...here, node: null }, [
      peer({ node: "this-node", serverName: "Loft" }),
    ]);
    expect(rows).toHaveLength(1);
  });

  test("and the name is only a fallback, never an override", () => {
    const rows = buildServerList(here, [
      peer({ node: "someone-else", serverName: "Loft" }),
    ]);
    expect(rows).toHaveLength(2);
  });

  test("peers are ordered by name so the list does not shuffle as they come and go", () => {
    const rows = buildServerList(here, [
      peer({ node: "c", serverName: "Zed" }),
      peer({ node: "a", serverName: "Attic" }),
      peer({ node: "b", serverName: "Mill" }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Loft", "Attic", "Mill", "Zed"]);
  });

  test("a nameless peer falls back to a readable stub of its id", () => {
    const rows = buildServerList(here, [
      peer({ node: "abcdef0123456789", serverName: "" }),
    ]);
    expect(rows[1].name).toBe("abcdef01");
  });

  test("no peers at all is just this server", () => {
    expect(buildServerList(here, null)).toHaveLength(1);
  });
});

describe("buildServerList, connections still being made", () => {
  test("requests come after connected servers, and invitations last", () => {
    const rows = buildServerList(
      here,
      [peer()],
      [group({ group: "g9" })],
      [request()],
    );
    expect(rows.map((r) => [r.name, r.pending])).toEqual([
      ["Loft", null],
      ["Sams Server", null],
      ["Nans Box", "request"],
      ["", "invitation"],
    ]);
    expect(rows[2].request?.id).toBe("r1");
    expect(rows[3].group).toBe("g9");
  });

  test("a request from a server already connected is not listed", () => {
    const rows = buildServerList(
      here,
      [peer({ node: "ASKING-NODE" })],
      [],
      [request()],
    );
    expect(rows.filter((r) => r.pending === "request")).toHaveLength(0);
  });

  test("invitations are oldest first", () => {
    const rows = buildServerList(here, [], [
      group({ group: "new", createdAt: "2026-09-10T00:00:00Z" }),
      group({ group: "old", createdAt: "2026-09-01T00:00:00Z" }),
    ]);
    expect(rows.slice(1).map((r) => r.group)).toEqual(["old", "new"]);
  });
});

describe("pendingInvitations", () => {
  test("a group only this server is in is an invitation nobody opened", () => {
    const groups = [group({ group: "open" }), group({ group: "joined" })];
    const peers = [
      peer({ group: "open", node: "this-node" }),
      peer({ group: "joined", node: "this-node" }),
      peer({ group: "joined", node: "other" }),
    ];
    expect(
      pendingInvitations(groups, peers, "THIS-NODE").map((g) => g.group),
    ).toEqual(["open"]);
  });

  test("a member that has been away is still a member", () => {
    const peers = [peer({ group: "g1", node: "other", online: false })];
    expect(pendingInvitations([group()], peers, "this-node")).toEqual([]);
  });

  test("without this node's id there is no answer yet", () => {
    expect(pendingInvitations([group()], [], null)).toEqual([]);
  });
});

describe("peerAddress", () => {
  test("prefers the peer's own name over a plain-HTTP LAN address", () => {
    const address = peerAddress(
      peer({
        sideDoor: {
          node: "peer-node",
          candidates: [
            {
              kind: "own",
              host: "sam.example",
              port: 443,
              url: "https://sam.example",
            },
          ],
          lan_ips: ["192.168.1.5"],
          http_port: 8790,
        },
      }),
    );
    expect(address).toBe("https://sam.example");
  });

  test("falls back to the LAN address when there is no name", () => {
    const address = peerAddress(
      peer({
        sideDoor: {
          node: "peer-node",
          candidates: [],
          lan_ips: ["192.168.1.5"],
          http_port: 8790,
        },
      }),
    );
    expect(address).toBe("http://192.168.1.5:8790");
  });

  test("no side door is no address", () => {
    expect(peerAddress(peer())).toBe(null);
  });
});
