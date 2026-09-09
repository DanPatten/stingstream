import type { UserDto } from "@jellyfin/sdk/lib/generated-client/models";
import { Image } from "expo-image";
import { useAtomValue } from "jotai";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Platform,
  Pressable,
  type StyleProp,
  View,
  type ViewStyle,
} from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { Icon, type IconName } from "@/components/common/Icon";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { radius, tokens } from "@/constants/theme";
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
  useServerUsers,
  useSetUserDisabled,
  useSetUserPassword,
} from "@/lib/stingstream/serverUsers";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import { getUserImageUrl } from "@/utils/jellyfin/image/getUserImageUrl";
import { InvitePerson, MintedInviteDialog } from "../invites/InvitePerson";
import { confirmDestructive } from "../shared/confirm";
import { ScreenHeaderRow } from "../shared/ScreenHeaderRow";
import { EmptyState, QueryState } from "../shared/ScreenState";
import { UserLibrariesDialog } from "./UserLibrariesDialog";
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
  const setDisabled = useSetUserDisabled();
  const removeUser = useDeleteUser();

  const [inviting, setInviting] = useState(false);
  const [showing, setShowing] = useState<MintedInvite | null>(null);
  const [resetTarget, setResetTarget] = useState<UserDto | null>(null);
  const [editing, setEditing] = useState<UserDto | null>(null);

  const rows = useMemo(
    () => buildUserRows(users.data, invites.data, me?.Id),
    [users.data, invites.data, me?.Id],
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
                  serverAddress={api?.basePath}
                  libraries={libraries.data}
                  busy={busy || setDisabled.isPending}
                  onPress={() => setEditing(row.user)}
                  onResetPassword={() => setResetTarget(row.user)}
                  onToggleDisabled={() =>
                    setDisabled.mutate(
                      {
                        user: row.user,
                        disabled: !row.user.Policy?.IsDisabled,
                      },
                      { onError: (e) => toast.error(e.message) },
                    )
                  }
                  onDelete={() => deleteUser(row.user)}
                />
              ) : (
                <PendingRow
                  key={row.key}
                  name={row.invite.label || t("invites.row_untitled")}
                  libraries={row.invite.libraries.map((l) => l.name)}
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

      <InvitePerson visible={inviting} onClose={() => setInviting(false)} />
      <MintedInviteDialog minted={showing} onClose={() => setShowing(null)} />
      <UserLibrariesDialog user={editing} onClose={() => setEditing(null)} />
      <ResetPasswordDialog
        user={resetTarget}
        onClose={() => setResetTarget(null)}
      />
    </View>
  );
}

/**
 * One account.
 *
 * Its actions are icons rather than the words they used to be. The old row put "Reset password" and
 * "Disable" in the list as bare `<Text onPress>` — no button role, no touch target, no
 * confirmation — so they read as prose and behaved as controls.
 */
const AccountRow: React.FC<{
  user: UserDto;
  isSelf: boolean;
  serverAddress?: string;
  libraries: { id: string; name: string }[] | undefined;
  busy: boolean;
  onPress: () => void;
  onResetPassword: () => void;
  onToggleDisabled: () => void;
  onDelete: () => void;
}> = ({
  user,
  isSelf,
  serverAddress,
  libraries,
  busy,
  onPress,
  onResetPassword,
  onToggleDisabled,
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
    isAdmin ? t("users.administrator") : null,
    disabled ? t("users.disabled") : null,
    user.HasPassword ? null : t("users.no_password"),
    accessLabel,
  ]
    .filter(Boolean)
    .join(" • ");

  /**
   * An administrator cannot be disabled and you cannot delete yourself: the server answers 403 to
   * both, along with the last-administrator and last-enabled-user guards beside them. Greyed rather
   * than dropped, so every row keeps the same three controls in the same places.
   */
  const cannotDisable = isSelf || isAdmin;

  return (
    <RowShell
      testID='users-account'
      title={user.Name ?? t("users.unnamed")}
      subtitle={subtitle}
      onPress={onPress}
      leading={<Avatar serverAddress={serverAddress} user={user} />}
      actions={
        <>
          <RowAction
            icon='key'
            label={t("users.reset_password")}
            disabled={busy}
            onPress={onResetPassword}
          />
          <RowAction
            icon={disabled ? "unblock" : "block"}
            label={disabled ? t("users.enable") : t("users.disable")}
            disabled={busy || cannotDisable}
            onPress={onToggleDisabled}
          />
          <RowAction
            icon='delete'
            label={t("users.delete")}
            disabled={busy || isSelf}
            onPress={onDelete}
          />
        </>
      }
    />
  );
};

/** An invitation nobody has opened yet. Pressing it shows the same link again. */
const PendingRow: React.FC<{
  name: string;
  libraries: string[];
  busy: boolean;
  onPress: () => void;
  onDelete: () => void;
}> = ({ name, libraries, busy, onPress, onDelete }) => {
  const { t } = useTranslation();

  return (
    <RowShell
      testID='users-pending'
      title={name}
      subtitle={[t("users.pending"), libraries.join(", ")]
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
        <>
          <RowAction
            icon='link'
            label={t("users.show_link")}
            disabled={busy}
            onPress={onPress}
          />
          <RowAction
            icon='delete'
            label={t("users.delete_invite")}
            disabled={busy}
            onPress={onDelete}
          />
        </>
      }
    />
  );
};

/**
 * A row whose label opens one thing and whose icons do others.
 *
 * **Not `ListItem`.** A pressable `ListItem` renders a real `<button>` on the web, and the row
 * actions are buttons too — nesting them is invalid HTML, which React says out loud (*"<button>
 * cannot contain a nested <button>"*, seen live on this screen at 1440) and which flattens the
 * whole row into one control for a screen reader. So the label and the icons are **siblings**: one
 * `Pressable` holding the avatar and the text, the buttons beside it.
 *
 * The metrics are `ListItem`'s, deliberately — the 44 px floor, the 16 px gutter, the same hover
 * and pressed tints — because this sits in a `ListGroup` next to rows that are `ListItem`s and a
 * row that is nearly the same is worse than one that is either identical or clearly different.
 * `style` is accepted and applied because `ListGroup` clones the hairline separator onto it.
 */
const RowShell: React.FC<{
  testID: string;
  title: string;
  subtitle: string;
  leading: ReactNode;
  actions: ReactNode;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}> = ({ testID, title, subtitle, leading, actions, onPress, style }) => {
  const states = usePressableStates();

  return (
    <View
      testID={testID}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          minHeight: 44,
          paddingVertical: Platform.OS === "android" ? 6 : 8,
          paddingHorizontal: 16,
          backgroundColor: states.pressed
            ? tokens.color.bg["3"]
            : states.hovered
              ? tokens.color.bg["2"]
              : tokens.color.bg["1"],
        },
        style,
      ]}
    >
      <Pressable
        accessibilityRole='button'
        onPress={onPress}
        {...states.handlers}
        style={[
          {
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            minHeight: tokens.control.minTouchTarget,
            borderRadius: radius.sm,
          },
          states.webStyle,
        ]}
      >
        {leading}
        <View style={{ flexShrink: 1, marginLeft: 12 }}>
          <Text numberOfLines={1}>{title}</Text>
          <Text
            variant='caption'
            tone='secondary'
            numberOfLines={2}
            style={{ marginTop: 2 }}
          >
            {subtitle}
          </Text>
        </View>
      </Pressable>
      <View
        style={{ flexDirection: "row", alignItems: "center", flexShrink: 0 }}
      >
        {actions}
      </View>
    </View>
  );
};

/** The icon-only ghost button this codebase already spells exactly one way. */
const RowAction: React.FC<{
  icon: IconName;
  label: string;
  disabled: boolean;
  onPress: () => void;
}> = ({ icon, label, disabled, onPress }) => (
  <Button
    variant='ghost'
    size='sm'
    icon={icon}
    disabled={disabled}
    onPress={onPress}
    accessibilityLabel={label}
  >
    {""}
  </Button>
);

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

/**
 * Setting somebody else's password.
 *
 * It was a panel that unfolded above the list, which meant a control belonging to one row appeared
 * nowhere near it and pushed every other row down. A row action gets a dialog.
 */
const ResetPasswordDialog: React.FC<{
  user: UserDto | null;
  onClose: () => void;
}> = ({ user, onClose }) => {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const reset = useSetUserPassword();

  const close = () => {
    setPassword("");
    onClose();
  };

  const submit = () => {
    if (!user?.Id) return;
    reset.mutate(
      { userId: user.Id, password },
      {
        onSuccess: () => {
          toast.success(t("users.reset_success"));
          close();
        },
        onError: (e) => toast.error(e.message),
      },
    );
  };

  return (
    <Dialog
      visible={!!user}
      onClose={close}
      title={t("users.reset_title")}
      description={t("users.reset_description", { name: user?.Name ?? "" })}
      actions={[
        { label: t("common.cancel"), onPress: close },
        {
          label: t("users.reset_action"),
          testID: "user-reset-submit",
          onPress: submit,
          loading: reset.isPending,
          disabled: reset.isPending || password.length === 0,
        },
      ]}
    >
      <Input
        testID='user-reset-password'
        placeholder={t("users.reset_placeholder")}
        secureTextEntry
        autoCapitalize='none'
        value={password}
        onChangeText={setPassword}
        editable={!reset.isPending}
      />
      <Text variant='caption' tone='tertiary' style={{ marginTop: 8 }}>
        {t("users.reset_hint")}
      </Text>
    </Dialog>
  );
};
