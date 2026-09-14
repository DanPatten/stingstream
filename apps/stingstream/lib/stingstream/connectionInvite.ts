import { both, field } from "./meshApi";

/**
 * What an invite link is built from, as Core's `ConnectionInvite` answers it.
 *
 * Its own module, free of React, so a plain `bun test` can read one without loading the providers
 * `connections.ts` needs for its hooks.
 */
export interface ConnectionInvite {
  code: string;
  node: string;
  server: string;
  /** Where the link should point: the domain when one is set, else the LAN address. */
  address: string | null;
}

export const toConnectionInvite = (raw: unknown): ConnectionInvite => ({
  code: field<string>(raw, ...both("code")) ?? "",
  node: field<string>(raw, ...both("node")) ?? "",
  server: field<string>(raw, ...both("server")) ?? "",
  address: field<string>(raw, ...both("address"))?.trim() || null,
});
