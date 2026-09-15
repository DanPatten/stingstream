import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { Input } from "@/components/common/Input";
import { SettingSwitch } from "@/components/common/SettingSwitch";
import { Text } from "@/components/common/Text";
import { useInviteLibraries } from "@/lib/stingstream/invites";
import {
  sameUser,
  useRequestUsers,
  useSaveRequestUser,
} from "@/lib/stingstream/requests";
import {
  useServerOwner,
  useServerUsers,
  useSetUserDisabled,
  useSetUserPassword,
  useSetUserPolicy,
} from "@/lib/stingstream/serverUsers";
import { userAtom } from "@/providers/JellyfinProvider";
import { LibraryPicker } from "../shared/LibraryPicker";
import { Notice } from "../shared/Notice";
import {
  adminChangeBlocked,
  policyForAdminChange,
  policyForSelection,
  selectionForPolicy,
} from "./userAccess";

/**
 * Everything you can do to one account, in one place.
 *
 * ## Why the row actions moved in here
 *
 * Dan: *"these icons are not intuative for users and have no hover state, delete is good, other 2
 * are not, lets put both into the dialog instead."*
 *
 * He is right on both counts, and they are the same fault. A key and a prohibition sign are not
 * words: "reset this person's password" and "lock this person out" are consequential, rarely used
 * and easy to confuse, and a glyph with no label is a guess. Delete survives on the row because a
 * bin is the one icon everybody already reads, and because deleting is the one thing you might want
 * without opening anything first.
 *
 * ## Everything here takes effect when you press it
 *
 * One rule, not two. `SharedLibrariesSection` already works this way for the libraries a server
 * shares, and a dialog where the picker needs a Save but the buttons do not is a dialog where
 * somebody closes it and loses half of what they did. So there is no Save: ticking a library saves
 * it, and the two buttons say what they do.
 */
export const UserDialog: React.FC<{
  userId: string | null;
  onClose: () => void;
}> = ({ userId, onClose }) => {
  const { t } = useTranslation();
  const me = useAtomValue(userAtom);
  const users = useServerUsers();
  const owner = useServerOwner();
  const libraries = useInviteLibraries();

  const savePolicy = useSetUserPolicy();
  const setPassword = useSetUserPassword();
  const setDisabled = useSetUserDisabled();

  // Trust is a *requests* property, kept on the node's request policy rather than on the Jellyfin
  // account, so it comes from its own list. Same switch as the one on Request policy, on purpose:
  // whoever is looking at an account here should not have to go and find the other screen.
  const requestUsers = useRequestUsers();
  const saveRequestUser = useSaveRequestUser();

  // Read back out of the list rather than held as a snapshot: every action in here invalidates it,
  // and a dialog showing the state from before its own last press is the bug this avoids.
  const user = useMemo(
    () => users.data?.find((candidate) => candidate.Id === userId) ?? null,
    [users.data, userId],
  );

  const available = useMemo(() => libraries.data ?? [], [libraries.data]);
  const [password, setPasswordValue] = useState("");
  /** Whether the password field is showing. Closed until somebody asks for it. */
  const [resetting, setResetting] = useState(false);

  // Closing, or switching to a different account, puts the password field away again — reopening
  // on somebody else with a half-typed password for the last one is the bug this avoids.
  useEffect(() => {
    setPasswordValue("");
    setResetting(false);
  }, [userId]);

  const isSelf = Boolean(me?.Id) && user?.Id === me?.Id;
  const isAdmin = Boolean(user?.Policy?.IsAdministrator);
  const disabled = Boolean(user?.Policy?.IsDisabled);

  /**
   * An administrator cannot be disabled and you cannot lock yourself out — the server answers 403
   * to both, along with the last-administrator and last-enabled-user guards beside it. The button
   * stays, greyed, with the reason in a banner above, because a control that vanishes reads as a
   * fault.
   */
  const cannotDisable = isSelf || isAdmin;

  /** `null` when the switch is usable; otherwise which of the three rules is holding it. */
  const adminBlock = adminChangeBlocked(user, me, users.data, owner.data);
  const isOwner = adminBlock === "owner";

  // One line, at the top, for whichever rule is holding something. The owner and self cases
  // explain both locked controls at once; an ordinary administrator only has the Disable button.
  const lockedKey =
    adminBlock === "owner"
      ? "users.locked_owner"
      : adminBlock === "self" || (isSelf && cannotDisable)
        ? "users.locked_self"
        : adminBlock === "last-administrator"
          ? "users.locked_last"
          : isAdmin
            ? "users.locked_admin"
            : null;

  // Read straight off the cached policy, which the mutation patches before the PUT returns, so a
  // tick lands at once and a refusal puts it back without this dialog keeping a copy. An
  // administrator sees every library whatever the list says, so every box is ticked and locked.
  const selected = useMemo(
    () =>
      isAdmin
        ? available.map((library) => library.id)
        : selectionForPolicy(user?.Policy, available),
    [isAdmin, user?.Policy, available],
  );

  // Absent on a server with requests turned off, and absent for an account the request policy has
  // never heard of. Either way there is nothing to toggle, so the row does not appear.
  // `sameUser` rather than `===`: the two lists carry the same GUID in different formats.
  const requestUser = useMemo(
    () =>
      requestUsers.data?.find((candidate) =>
        sameUser(candidate.userId, userId ?? undefined),
      ),
    [requestUsers.data, userId],
  );

  const toggleLibrary = (id: string) => {
    if (!user?.Id || !user.Policy || isAdmin) return;
    const next = selected.includes(id)
      ? selected.filter((existing) => existing !== id)
      : [...selected, id];
    savePolicy.mutate(
      {
        userId: user.Id,
        policy: policyForSelection(user.Policy, next, available),
      },
      { onError: (e) => toast.error(e.message) },
    );
  };

  const toggleTrusted = (trusted: boolean) => {
    if (!requestUser || requestUser.isAdministrator) return;
    saveRequestUser.mutate(
      {
        userId: requestUser.userId,
        trusted,
        // Their own quota is edited on Request policy. Sending it back unchanged keeps this
        // switch from quietly resetting it.
        weeklyQuota: requestUser.weeklyQuota,
      },
      { onError: (e) => toast.error(e.message) },
    );
  };

  const toggleAdministrator = () => {
    if (!user?.Id || !user.Policy || adminBlock) return;
    savePolicy.mutate(
      {
        userId: user.Id,
        policy: policyForAdminChange(user.Policy, !isAdmin),
      },
      { onError: (e) => toast.error(e.message) },
    );
  };

  return (
    <Dialog
      visible={!!userId}
      onClose={onClose}
      title={user?.Name ?? t("users.unnamed")}
      description={
        user
          ? [
              isOwner
                ? t("users.owner")
                : isAdmin
                  ? t("users.administrator")
                  : t("users.member"),
              isSelf ? t("users.you") : null,
            ]
              .filter(Boolean)
              .join(" • ")
          : undefined
      }
      /*
       * Dan: *"move disable as a button next to done. account role/password reset is too many
       * forms going on, make reset password another button."*
       *
       * So the body is what this account *is* — its libraries and whether it administers — and the
       * things you *do* to it live in one row at the bottom. Resetting a password is the only one
       * that needs a field, and it is revealed on demand rather than sitting open: the dialog now
       * opens with no text input in it at all, which is what "too many forms" was about.
       */
      actions={[
        {
          label: resetting ? t("common.cancel") : t("users.reset_open"),
          onPress: () => {
            setResetting((open) => !open);
            setPasswordValue("");
          },
          variant: "ghost",
          testID: "user-reset-toggle",
        },
        {
          label: disabled
            ? t("users.enable_account")
            : t("users.disable_account"),
          onPress: () => {
            if (!user) return;
            setDisabled.mutate(
              { user, disabled: !disabled },
              { onError: (e) => toast.error(e.message) },
            );
          },
          variant: disabled ? "secondary" : "danger",
          disabled: cannotDisable,
          testID: "user-toggle-disabled",
        },
        { label: t("common.done"), onPress: onClose },
      ]}
    >
      <View style={{ gap: 20 }}>
        {lockedKey ? (
          <Notice testID='user-locked-notice' text={t(lockedKey)} />
        ) : null}

        <Section title={t("users.libraries_title")}>
          <View testID='user-libraries'>
            {/* An administrator gets the same boxes, all ticked and locked: Jellyfin checks
                `IsAdministrator` before it checks folders, and a sentence saying so was harder to
                read than the picker itself. */}
            {isAdmin ? null : (
              <Text
                variant='caption'
                tone='tertiary'
                style={{ marginBottom: 6 }}
              >
                {t("users.libraries_hint")}
              </Text>
            )}
            <LibraryPicker
              available={available}
              selected={selected}
              onToggle={toggleLibrary}
              loading={libraries.isPending}
              disabled={isAdmin}
            />
          </View>
        </Section>

        {/* Only once somebody has asked for it, from the button in the action row. */}
        {resetting ? (
          <Section title={t("users.password_title")}>
            <Text variant='caption' tone='tertiary' style={{ marginBottom: 8 }}>
              {t("users.reset_hint")}
            </Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Input
                testID='user-reset-password'
                placeholder={t("users.reset_placeholder")}
                secureTextEntry
                autoCapitalize='none'
                value={password}
                onChangeText={setPasswordValue}
                editable={!setPassword.isPending}
                style={{ flex: 1 }}
              />
              <Button
                testID='user-reset-submit'
                variant='secondary'
                loading={setPassword.isPending}
                disabled={setPassword.isPending || password.length === 0}
                onPress={() => {
                  if (!user?.Id) return;
                  setPassword.mutate(
                    { userId: user.Id, password },
                    {
                      onSuccess: () => {
                        setPasswordValue("");
                        // Closes itself: the field has done its job, and leaving it open invites
                        // somebody to wonder whether the first press took.
                        setResetting(false);
                        toast.success(t("users.reset_success"));
                      },
                      onError: (e) => toast.error(e.message),
                    },
                  );
                }}
              >
                {t("users.reset_action")}
              </Button>
            </View>
          </Section>
        ) : null}

        <Section title={t("users.account_title")}>
          {/* All that is left in here: what this account *is*. Resetting a password and locking
              somebody out are things you *do*, and they are in the action row now. */}
          <ToggleRow
            testID='user-toggle-administrator'
            label={t("users.administrator")}
            hint={
              isAdmin
                ? t("users.administrator_on_hint")
                : t("users.administrator_off_hint")
            }
            value={isAdmin}
            disabled={!!adminBlock}
            onValueChange={toggleAdministrator}
          />

          {/* The same switch as the one on Request policy, so an account can be trusted from
              either place. Missing entirely on a server with requests turned off. An
              administrator is auto-approved under every policy, so theirs is on and fixed. */}
          {requestUser ? (
            <View style={{ marginTop: 16 }}>
              <ToggleRow
                testID='user-toggle-trusted'
                label={t("users.trusted")}
                hint={
                  isAdmin
                    ? t("users.trusted_administrator")
                    : requestUser.trusted
                      ? t("users.trusted_on_hint")
                      : t("users.trusted_off_hint")
                }
                value={isAdmin || requestUser.trusted}
                disabled={isAdmin}
                onValueChange={toggleTrusted}
              />
            </View>
          ) : null}
        </Section>
      </View>
    </Dialog>
  );
};

/** A labelled switch with the reason for its state under it. */
const ToggleRow: React.FC<{
  testID: string;
  label: string;
  hint: string;
  value: boolean;
  disabled: boolean;
  onValueChange: (value: boolean) => void;
}> = ({ testID, label, hint, value, disabled, onValueChange }) => (
  <View
    testID={testID}
    style={{
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    }}
  >
    <View style={{ flex: 1 }}>
      <Text variant='body'>{label}</Text>
      <Text variant='caption' tone='tertiary' style={{ marginTop: 2 }}>
        {hint}
      </Text>
    </View>
    <SettingSwitch
      value={value}
      disabled={disabled}
      onValueChange={onValueChange}
    />
  </View>
);

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children,
}) => (
  <View>
    <Text
      variant='micro'
      weight='semibold'
      tone='tertiary'
      style={{
        marginBottom: 8,
        textTransform: "uppercase",
        letterSpacing: 0.6,
      }}
    >
      {title}
    </Text>
    {children}
  </View>
);
