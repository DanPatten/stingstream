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
  useServerOwner,
  useServerUsers,
  useSetUserDisabled,
  useSetUserPassword,
  useSetUserPolicy,
} from "@/lib/stingstream/serverUsers";
import { userAtom } from "@/providers/JellyfinProvider";
import { LibraryPicker } from "../shared/LibraryPicker";
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

  // Read back out of the list rather than held as a snapshot: every action in here invalidates it,
  // and a dialog showing the state from before its own last press is the bug this avoids.
  const user = useMemo(
    () => users.data?.find((candidate) => candidate.Id === userId) ?? null,
    [users.data, userId],
  );

  const available = useMemo(() => libraries.data ?? [], [libraries.data]);
  const [selected, setSelected] = useState<string[]>([]);
  const [password, setPasswordValue] = useState("");
  /** Whether the password field is showing. Closed until somebody asks for it. */
  const [resetting, setResetting] = useState(false);

  // Seeded from the truth, and re-seeded when the account or the library list changes.
  // `useChosenLibraries` ticks everything, which is right for a new invite and a lie here.
  useEffect(() => {
    setSelected(user ? selectionForPolicy(user.Policy, available) : []);
  }, [user, available]);

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
   * stays, greyed, with the reason under it, because a control that vanishes reads as a fault.
   */
  const cannotDisable = isSelf || isAdmin;

  /** `null` when the switch is usable; otherwise which of the three rules is holding it. */
  const adminBlock = adminChangeBlocked(user, me, users.data, owner.data);

  const toggleLibrary = (id: string) => {
    if (!user?.Id || !user.Policy) return;
    const next = selected.includes(id)
      ? selected.filter((existing) => existing !== id)
      : [...selected, id];
    setSelected(next);
    savePolicy.mutate(
      {
        userId: user.Id,
        policy: policyForSelection(user.Policy, next, available),
      },
      {
        onError: (e) => {
          // Put the tick back: the server is the truth, and a picker that keeps a change it failed
          // to make is worse than one that flickers.
          setSelected(selectionForPolicy(user.Policy, available));
          toast.error(e.message);
        },
      },
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
      description={t("users.dialog_description")}
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
          disabled: cannotDisable || setDisabled.isPending,
          loading: setDisabled.isPending,
          testID: "user-toggle-disabled",
        },
        { label: t("common.done"), onPress: onClose },
      ]}
    >
      <View style={{ gap: 20 }}>
        <Section title={t("users.libraries_title")}>
          {isAdmin ? (
            // Jellyfin checks `IsAdministrator` before it checks folders, so a picker here would be
            // a set of boxes that change nothing.
            <Text variant='caption' tone='secondary'>
              {t("users.libraries_administrator")}
            </Text>
          ) : (
            <View testID='user-libraries'>
              <Text
                variant='caption'
                tone='tertiary'
                style={{ marginBottom: 6 }}
              >
                {t("users.libraries_hint")}
              </Text>
              <LibraryPicker
                available={available}
                selected={selected}
                onToggle={toggleLibrary}
                loading={libraries.isPending}
                disabled={savePolicy.isPending}
              />
            </View>
          )}
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
          <View
            testID='user-toggle-administrator'
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text variant='body'>{t("users.administrator")}</Text>
              <Text variant='caption' tone='tertiary' style={{ marginTop: 2 }}>
                {adminBlock === "owner"
                  ? t("users.administrator_locked_owner")
                  : adminBlock === "self"
                    ? t("users.administrator_locked_self")
                    : adminBlock === "last-administrator"
                      ? t("users.administrator_locked_last")
                      : isAdmin
                        ? t("users.administrator_on_hint")
                        : t("users.administrator_off_hint")}
              </Text>
            </View>
            <SettingSwitch
              value={isAdmin}
              disabled={!!adminBlock || savePolicy.isPending}
              onValueChange={toggleAdministrator}
            />
          </View>

          {/* Only when the button in the action row cannot be used. A greyed button with no
              reason reads as a fault; a working one says what it does on its face. */}
          {cannotDisable ? (
            <Text variant='caption' tone='tertiary' style={{ marginTop: 12 }}>
              {t("users.disable_locked")}
            </Text>
          ) : null}
        </Section>
      </View>
    </Dialog>
  );
};

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
