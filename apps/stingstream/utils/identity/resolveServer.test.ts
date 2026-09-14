import { describe, expect, test } from "bun:test";
import { isHomeNetworkHost, serverOriginFromInput } from "./resolveServer";

describe("serverOriginFromInput", () => {
  test("a typed scheme is kept, and only the origin survives", () => {
    expect(serverOriginFromInput("http://127.0.0.1:8802")).toBe(
      "http://127.0.0.1:8802",
    );
    expect(
      serverOriginFromInput(" https://media.example.com/settings/servers "),
    ).toBe("https://media.example.com");
  });

  test("a home network address with no scheme is plain HTTP", () => {
    expect(serverOriginFromInput("192.168.0.16:5173")).toBe(
      "http://192.168.0.16:5173",
    );
    expect(serverOriginFromInput("localhost:8802")).toBe(
      "http://localhost:8802",
    );
    expect(serverOriginFromInput("nas.local:8790")).toBe(
      "http://nas.local:8790",
    );
    expect(serverOriginFromInput("mediabox")).toBe("http://mediabox");
  });

  test("a domain with no scheme is HTTPS", () => {
    expect(serverOriginFromInput("meals.danha.top")).toBe(
      "https://meals.danha.top",
    );
    expect(serverOriginFromInput("media.example.com:8443/")).toBe(
      "https://media.example.com:8443",
    );
  });

  test("nothing usable is null", () => {
    expect(serverOriginFromInput("")).toBeNull();
    expect(serverOriginFromInput("   ")).toBeNull();
    expect(serverOriginFromInput("not an address")).toBeNull();
    expect(serverOriginFromInput("javascript:alert(1)")).toBeNull();
    expect(serverOriginFromInput("ftp://media.example.com")).toBeNull();
  });
});

describe("isHomeNetworkHost", () => {
  test("tells a home network name from a domain", () => {
    expect(isHomeNetworkHost("10.0.0.5")).toBe(true);
    expect(isHomeNetworkHost("[::1]")).toBe(true);
    expect(isHomeNetworkHost("router.home.arpa")).toBe(true);
    expect(isHomeNetworkHost("media.example.com")).toBe(false);
  });
});
