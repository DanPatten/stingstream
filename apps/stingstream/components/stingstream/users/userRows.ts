import type { UserDto } from "@jellyfin/sdk/lib/generated-client/models";
import type { InviteSummary } from "@/lib/stingstream/invitesApi";
import { sameUserId } from "@/lib/stingstream/serverOwner";

/**
 * One line of the Users screen: an account on this server, or an invitation
 * nobody has opened yet.
 *
 * Two lists shown as one, which is what somebody asking "who can get in here"
 * means. It was the Sharing screen's People list before Users absorbed it; the
 * merge is lifted out of the component so `userRows.test.ts` can pin the rules
 * without a server, a router or the Jellyfin SDK.
 */
export type UserRow =
  | {
      kind: "account";
      key: string;
      user: UserDto;
      isSelf: boolean;
      /**
       * The account that claimed this server at first run.
       *
       * Dan: *"cannot be changed and is the first admin setup, no transfer support and they are
       * always an admin"*. At most one row carries it, and on a server whose owner is unknown —
       * an older node, a failed lookup — none does.
       */
      isOwner: boolean;
    }
  | { kind: "invite"; key: string; invite: InviteSummary };

export function buildUserRows(
  users: UserDto[] | null | undefined,
  invites: InviteSummary[] | null | undefined,
  meId: string | null | undefined,
  ownerId?: string | null,
): UserRow[] {
  const accounts = (users ?? [])
    .filter((user) => Boolean(user.Id))
    .map<UserRow>((user) => ({
      kind: "account",
      key: `user:${user.Id}`,
      user,
      // Sharing filtered the owner out, because it was answering "who can see my
      // things" and you are not one of them. This screen answers "what accounts
      // exist", and the owner is one — with its destructive actions off, since
      // the server refuses them anyway.
      isSelf: Boolean(meId) && user.Id === meId,
      isOwner: sameUserId(ownerId, user.Id),
    }));

  // Only invitations nobody has opened. A spent one describes an account that is
  // already above it, and both would count the same person twice.
  const pending = (invites ?? [])
    .filter((invite) => invite.status === "valid")
    .map<UserRow>((invite) => ({
      kind: "invite",
      key: `invite:${invite.id}`,
      invite,
    }));

  return [...accounts, ...pending];
}
