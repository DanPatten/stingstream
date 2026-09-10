import type { UserDto } from "@jellyfin/sdk/lib/generated-client/models";
import { Image } from "expo-image";
import { useFocusEffect } from "expo-router";
import { useAtomValue } from "jotai";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Icon } from "@/components/common/Icon";
import { ListGroup } from "@/components/list/ListGroup";
import { rgba, tokens } from "@/constants/theme";
import { usePressableStates } from "@/hooks/usePressableStates";
import {
  useDeleteInvite,
  useInviteLibraries,
  useInviteLink,
  useInvites,
} from "@/lib/stingstream/invites";
import type { MintedInvite } from "@/lib/stingstream/invitesApi";
import {
  useDeleteUser,
  useServerOwner,
  useServerUsers,
} from "@/lib/stingstream/serverUsers";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import { getUserImageUrl } from "@/utils/jellyfin/image/getUserImageUrl";
import { LinkedIdentities } from "../identity/LinkedIdentities";
import { InvitePerson, MintedInviteDialog } from "../invites/InvitePerson";
import { ActionRow } from "../shared/ActionRow";
import { confirmDestructive } from "../shared/confirm";
import { ScreenHeaderRow } from "../shared/ScreenHeaderRow";
import { EmptyState, QueryState } from "../shared/ScreenState";
import { UserDialog } from "./UserDialog";
import { describeAccess } from "./userAccess";
import { buildUserRows } from "./userRows";

/**
 * Who can get into this server.
 *
 * ## Why this is a screen of its own
 *
 * Dan: *"Lets remove the Sharing screen and replace the side bar with 'Users' instead - make it
 * first class and not sharing a tab with libraries/transcoding/etc."*
 *
 * People used to be split three ways and none of them was the obvious one: a Users tab behind a
 * segmented control about transcode throttling, a People half of the Sharing screen, and an
 * invite-link list beside both. The two ways to give somebody access disagreed — *Add user* was a
 * username and a password box that made an account able to see every library, while *Invite* asked
 * which libraries and handed back a link with a QR code. The good flow was the one nobody landed
 * on, so it is now the only one: **there is no "add user", there is an invitation.**
 *
 * Pending invitations sit in the same list as accounts, tagged, because "somebody I invited who has
 * not turned up yet" is a person as far as anybody reading this screen is concerned.
 *
 * ## One icon on a row, not three
 *
 * Dan: *"these icons are not intuative for users and have no hover state, delete is good, other 2
 * are not."* A key and a prohibition sign are not words. Pressing a row opens `UserDialog`, which
 * is where resetting a password and locking somebody out now live, with labels on them. The bin
 * stays because it is the one icon everybody reads and the one action worth having without opening
 * anything first.
 */
export function UsersScreen() {
  const { t } = useTranslation();
  const api = useAtomValue(apiAtom);
  const me = useAtomValue(userAtom);

  const users = useServerUsers();
  const invites = useInvites();
  const libraries = useInviteLibraries();

  const link = useInviteLink();
  const removeInvite = useDeleteInvite();
  const removeUser = useDeleteUser();
  const owner = useServerOwner();

  const [inviting, setInviting] = useState(false);
  const [showing, setShowing] = useState<MintedInvite | null>(null);
  // The id rather than the account: `UserDialog` reads the row back out of the list, so it keeps
  // showing the truth after its own edits invalidate it.
  const [editingId, setEditingId] = useState<string | null>(null);

  const rows = useMemo(
    () => buildUserRows(users.data, invites.data, me?.Id, owner.data),
    [users.data, invites.data, me?.Id, owner.data],
  );

  /**
   * Refetch whenever this screen comes back into view.
   *
   * Dan: *"i invited a user, left and went back to users page and didnt see him until full
   * refresh."* Two app-wide settings meet here and leave a gap between them. A pushed screen stays
   * **mounted** in the stack, so coming back to it is not a mount and `refetchOnMount` never
   * fires; and `refetchOnWindowFocus` is off for the whole app (`app/_layout.tsx`, "not needed for
   * mobile" — which this is not, in a browser). So the list a person returned to was whatever it
   * held when they left it, until the 60-second `refetchInterval` came round or they reloaded the
   * page.
   *
   * Screen focus is the event that actually means "somebody is looking at this again", and it is
   * the one React Navigation gives us. Both queries, because an account and an invitation are two
   * halves of one list.
   */
  useFocusEffect(
    useCallback(() => {
      void users.refetch();
      void invites.refetch();
    }, [users.refetch, invites.refetch]),
  );

  const busy = removeInvite.isPending || link.isPending || removeUser.isPending;

  /**
   * Re-open an invitation's link.
   *
   * Fetched on the press rather than held in the list: it is a credential, and a query cache is
   * read back by anything that asks for the key.
   */
  const openLink = (id: string) =>
    link.mutate(id, {
      onSuccess: (result) => {
        if (result) setShowing(result);
        else toast.error(t("invites.link_gone"));
      },
      onError: (e) => toast.error(e.message),
    });

  const deleteUser = async (user: UserDto) => {
    const ok = await confirmDestructive(
      t("users.delete_confirm_title", { name: user.Name ?? "" }),
      t("users.delete_confirm_detail"),
      t("common.delete"),
    );
    if (!ok || !user.Id) return;
    removeUser.mutate(user.Id, {
      onSuccess: () =>
        toast.success(t("users.deleted", { name: user.Name ?? "" })),
      onError: (e) => toast.error(e.message),
    });
  };

  return (
    <View testID='users-screen'>
      <ScreenHeaderRow
        title={t("users.title")}
        accessory={
          <Button
            testID='users-invite'
            variant='primary'
            size='sm'
            icon='invite'
            onPress={() => setInviting(true)}
          >
            {t("users.invite_action")}
          </Button>
        }
      />

      <QueryState
        isLoading={users.isLoading}
        error={users.error}
        onRetry={users.refetch}
      >
        {rows.length === 0 ? (
          <EmptyState
            icon='users'
            title={t("users.empty_title")}
            detail={t("users.empty_detail")}
          />
        ) : (
          <ListGroup>
            {rows.map((row) =>
              row.kind === "account" ? (
                <AccountRow
                  key={row.key}
                  user={row.user}
                  isSelf={row.isSelf}
                  isOwner={row.isOwner}
                  serverAddress={api?.basePath}
                  libraries={libraries.data}
                  busy={busy}
                  onPress={() => setEditingId(row.user.Id ?? null)}
                  onDelete={() => deleteUser(row.user)}
                />
              ) : (
                <PendingRow
                  key={row.key}
                  name={row.invite.label || t("invites.row_untitled")}
                  libraries={row.invite.libraries.map((l) => l.name)}
                  isAdministrator={row.invite.isAdministrator}
                  busy={busy}
                  onPress={() => openLink(row.invite.id)}
                  onDelete={() =>
                    removeInvite.mutate(row.invite.id, {
                      onError: (e) => toast.error(e.message),
                    })
                  }
                />
              ),
            )}
          </ListGroup>
        )}
      </QueryState>

      {/* Below the accounts, not merged into them: these *are* accounts in the list above, and the
          half that is not visible there is which server vouches for them. */}
      <LinkedIdentities />

      <InvitePerson visible={inviting} onClose={() => setInviting(false)} />
      <MintedInviteDialog minted={showing} onClose={() => setShowing(null)} />
      <UserDialog userId={editingId} onClose={() => setEditingId(null)} />
    </View>
  );
}

/** One account. Press it to manage it; the bin is the only thing the row does itself. */
const AccountRow: React.FC<{
  user: UserDto;
  isSelf: boolean;
  isOwner: boolean;
  serverAddress?: string;
  libraries: { id: string; name: string }[] | undefined;
  busy: boolean;
  onPress: () => void;
  onDelete: () => void;
}> = ({
  user,
  isSelf,
  isOwner,
  serverAddress,
  libraries,
  busy,
  onPress,
  onDelete,
}) => {
  const { t } = useTranslation();
  const disabled = Boolean(user.Policy?.IsDisabled);
  const isAdmin = Boolean(user.Policy?.IsAdministrator);
  const access = describeAccess(user.Policy, libraries);

  const accessLabel =
    access.kind === "all"
      ? t("users.all_libraries")
      : access.kind === "none"
        ? t("users.no_libraries")
        : access.kind === "named"
          ? access.names.join(", ")
          : t("users.library_count", { count: access.count });

  const subtitle = [
    // "Owner" instead of "Administrator", not as well as: an owner is always an administrator, so
    // the pair would say one thing twice and bury the half that is not obvious.
    isOwner ? t("users.owner") : isAdmin ? t("users.administrator") : null,
    disabled ? t("users.disabled") : null,
    user.HasPassword ? null : t("users.no_password"),
    accessLabel,
  ]
    .filter(Boolean)
    .join(" • ");

  return (
    <ActionRow
      testID='users-account'
      title={user.Name ?? t("users.unnamed")}
      subtitle={subtitle}
      onPress={onPress}
      leading={<Avatar serverAddress={serverAddress} user={user} />}
      actions={
        <DeleteAction
          label={t("users.delete")}
          // You cannot delete yourself; the server refuses and the app should not offer it. Nor
          // the owner: ownership does not transfer, so deleting that account would be the one way
          // to change who this server belongs to.
          disabled={busy || isSelf || isOwner}
          onPress={onDelete}
        />
      }
    />
  );
};

/** An invitation nobody has opened yet. Pressing it shows the same link again. */
const PendingRow: React.FC<{
  name: string;
  libraries: string[];
  isAdministrator: boolean;
  busy: boolean;
  onPress: () => void;
  onDelete: () => void;
}> = ({ name, libraries, isAdministrator, busy, onPress, onDelete }) => {
  const { t } = useTranslation();

  return (
    <ActionRow
      testID='users-pending'
      title={name}
      // An administrator invite names no libraries, so without saying so the row would read
      // "Invited" and nothing else — the one row in this list where what is missing is the
      // important part.
      subtitle={[
        t("users.pending"),
        isAdministrator ? t("users.administrator") : libraries.join(", "),
      ]
        .filter(Boolean)
        .join(" • ")}
      onPress={onPress}
      leading={
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: tokens.color.bg["3"],
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name='invite' size={18} tone='tertiary' />
        </View>
      }
      actions={
        <DeleteAction
          label={t("users.delete_invite")}
          disabled={busy}
          onPress={onDelete}
        />
      }
    />
  );
};

/**
 * The bin.
 *
 * Its own control rather than `Button variant='ghost'`, because ghost's hover is a 6% white wash
 * and this sits **inside a row that already tints on hover** — Dan: *"have no hover state"*, and he
 * was looking at a real one that the row underneath had swallowed. This one fills a circle and
 * turns red, so hovering it says both "this is a button" and "this one is destructive" before it is
 * pressed.
 */
const DeleteAction: React.FC<{
  label: string;
  disabled: boolean;
  onPress: () => void;
}> = ({ label, disabled, onPress }) => {
  const states = usePressableStates({ disabled });

  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      {...states.handlers}
      style={[
        {
          width: tokens.control.minTouchTarget,
          height: tokens.control.minTouchTarget,
          borderRadius: tokens.control.minTouchTarget / 2,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: states.pressed
            ? rgba(tokens.color.state.danger, 0.24)
            : states.hovered
              ? rgba(tokens.color.state.danger, 0.14)
              : "transparent",
          opacity: disabled ? tokens.control.disabledOpacity : 1,
        },
        states.webStyle,
      ]}
    >
      <Icon
        name='delete'
        size={18}
        color={
          states.hovered || states.pressed
            ? tokens.color.state.danger
            : tokens.color.text.tertiary
        }
      />
    </Pressable>
  );
};

/** The user's own photo, or a fallback tile, so a row with no photo still reads as a person. */
function Avatar({
  serverAddress,
  user,
  size = 36,
}: {
  serverAddress?: string;
  user: UserDto;
  size?: number;
}) {
  const url =
    serverAddress && user.Id
      ? getUserImageUrl({
          serverAddress,
          userId: user.Id,
          primaryImageTag: user.PrimaryImageTag,
          width: size * 2,
        })
      : null;

  if (!url) {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: tokens.color.bg["3"],
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name='user' size={size * 0.6} tone='tertiary' />
      </View>
    );
  }
  return (
    <Image
      source={{ uri: url }}
      contentFit='cover'
      transition={120}
      style={{ width: size, height: size, borderRadius: size / 2 }}
    />
  );
}
