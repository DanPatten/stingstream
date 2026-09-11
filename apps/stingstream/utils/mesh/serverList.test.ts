import { describe, expect, test } from "bun:test";
import type { MeshNodePeer } from "@/lib/stingstream/meshApi";
import { buildServerList, peerAddress, type WaitingServer } from "./serverList";

// Which servers the page lists, in what order, and which one is this one. Pinned here for the
// reason `buildUserRows` is: they are rules, and they should not need a mesh to check.

const peer = (over: Partial<MeshNodePeer> = {}): MeshNodePeer => ({
  group: "g1",
  node: "peer-node",
  nodeName: "Sams Server",
  online: true,
  firstSeen: "2026-01-01T00:00:00Z",
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

  test("a peer in two links appears once", () => {
    // The row is about the machine, not the membership.
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
    // *different* query. Until that landed there was no id to compare against, and the page drew
    // this server twice — once labelled and once as a stranger with the same name. Dan: *"why do I
    // see servers listed twice like that"*.
    const rows = buildServerList({ ...here, node: null }, [
      peer({ node: "this-node", nodeName: "Loft" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].isThisServer).toBe(true);
  });

  test("and the name is only a fallback, never an override", () => {
    // Two servers really can share a name. Once the id is known it decides, and a peer that merely
    // shares this one's name keeps its row.
    const rows = buildServerList(here, [
      peer({ node: "someone-else", nodeName: "Loft" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1].isThisServer).toBe(false);
  });

  test("peers are ordered by name so the list does not shuffle as they come and go", () => {
    const rows = buildServerList(here, [
      peer({ node: "c", nodeName: "Zed" }),
      peer({ node: "a", nodeName: "Attic" }),
      peer({ node: "b", nodeName: "Mill" }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Loft", "Attic", "Mill", "Zed"]);
  });

  test("a peer that has published nowhere still gets a row", () => {
    // No address is a fact about that server, not a reason to leave it off a list of servers.
    const rows = buildServerList(here, [peer()]);
    expect(rows[1].address).toBe(null);
  });

  test("a nameless peer falls back to a readable stub of its id", () => {
    const rows = buildServerList(here, [
      peer({ node: "abcdef0123456789", nodeName: "" }),
    ]);
    expect(rows[1].name).toBe("abcdef01");
  });

  test("no peers at all is just this server", () => {
    expect(buildServerList(here, null)).toHaveLength(1);
    expect(buildServerList(here, [])).toHaveLength(1);
  });
});

describe("buildServerList, servers still being added", () => {
  const waiting = (over: Partial<WaitingServer> = {}): WaitingServer => ({
    node: "waiting-node",
    name: "Nans Box",
    address: "https://nan.example",
    status: "approved",
    group: "g9",
    ...over,
  });

  test("a server that has been offered is listed, after the ones that joined", () => {
    // A link takes two administrators to make, so there is a real interval when a server has been
    // offered and is not a peer. A page that showed nothing in it would be a page lying about its
    // own state.
    const rows = buildServerList(here, [peer()], [waiting()]);
    expect(rows.map((r) => [r.name, r.waiting])).toEqual([
      ["Loft", null],
      ["Sams Server", null],
      ["Nans Box", "them"],
    ]);
  });

  test("what it is waiting for is which of the two answers is missing", () => {
    const rows = buildServerList(here, [], [waiting({ status: "pending" })]);
    expect(rows[1].waiting).toBe("approval");
    expect(rows[1].online).toBe(false);
  });

  test("a server that has since joined is drawn once, as the peer", () => {
    // The peer row is the truer one: it has a live address, a group and an online state, none of
    // which a request row knows. Drawing both would be the same machine twice.
    const rows = buildServerList(
      here,
      [peer({ node: "waiting-node", nodeName: "Nans Box" })],
      [waiting()],
    );
    expect(rows).toHaveLength(2);
    expect(rows[1].waiting).toBe(null);
    expect(rows[1].online).toBe(true);
  });

  test("node ids are matched however they are spelled", () => {
    const rows = buildServerList(
      here,
      [peer({ node: "WAITING-NODE" })],
      [waiting({ node: "waiting-node" })],
    );
    expect(rows).toHaveLength(2);
  });

  test("this server can never be one of them", () => {
    const rows = buildServerList(here, [], [waiting({ node: "this-node" })]);
    expect(rows).toHaveLength(1);
  });

  test("a nameless one falls back to a readable stub of its id", () => {
    const rows = buildServerList(
      here,
      [],
      [waiting({ node: "abcdef0123456789", name: "" })],
    );
    expect(rows[1].name).toBe("abcdef01");
  });

  test("none of them is the ordinary case, and costs nothing", () => {
    expect(buildServerList(here, [peer()])).toHaveLength(2);
    expect(buildServerList(here, [peer()], null)).toHaveLength(2);
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
    // A real answer, and only when nothing better exists: it works on one network and says so by
    // being plain HTTP.
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
