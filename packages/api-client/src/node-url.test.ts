import { describe, expect, it } from "bun:test";
import { getNodeBaseUrl, getStingStreamApiBaseUrl } from "./node-url";

describe("getNodeBaseUrl", () => {
  it("strips a trailing /jellyfin segment", () => {
    expect(getNodeBaseUrl("http://192.168.1.5:8790/jellyfin")).toBe(
      "http://192.168.1.5:8790",
    );
  });

  it("strips a trailing slash before the segment check", () => {
    expect(getNodeBaseUrl("http://192.168.1.5:8790/jellyfin/")).toBe(
      "http://192.168.1.5:8790",
    );
  });

  it("is case-insensitive", () => {
    expect(getNodeBaseUrl("http://host:8790/Jellyfin")).toBe(
      "http://host:8790",
    );
  });

  it("leaves a bare Jellyfin URL (no /jellyfin suffix) unchanged", () => {
    expect(getNodeBaseUrl("http://192.168.1.5:8096")).toBe(
      "http://192.168.1.5:8096",
    );
  });

  it("does not strip an unrelated path that merely contains 'jellyfin'", () => {
    expect(getNodeBaseUrl("http://host:8790/myjellyfinserver")).toBe(
      "http://host:8790/myjellyfinserver",
    );
  });
});

describe("getStingStreamApiBaseUrl", () => {
  it("appends the fixed API prefix to the node root", () => {
    expect(getStingStreamApiBaseUrl("http://192.168.1.5:8790/jellyfin")).toBe(
      "http://192.168.1.5:8790/stingstream/api/v1",
    );
  });
});
