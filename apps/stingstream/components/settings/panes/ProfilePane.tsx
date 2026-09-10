import { getNodeBaseUrl } from "@stingstream/api-client";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { space } from "@/constants/theme";
import { IDENTITY_KDF_ITERATIONS } from "@/constants/Values";
import { useMySignInMethod } from "@/lib/stingstream/identity";
import {
  type SignInMethod,
  setLinkedPassword,
} from "@/lib/stingstream/identityApi";
import { useChangeMyPassword } from "@/lib/stingstream/serverUsers";
import { apiAtom, useJellyfin, userAtom } from "@/providers/JellyfinProvider";
import { deriveVerifier, newSalt } from "@/utils/identity/verifier";
import { FocusTarget } from "../FocusTarget";
import { LinkDevice } from "../LinkDevice";
import { PasskeysSection } from "../PasskeysSection";
import { ProfileHeader } from "../ProfileHeader";
import { SettingsPane } from "./SettingsPane";

/** Jellyfin's own floor. Anything shorter is refused by the server, not by us. */
const MIN_PASSWORD_LENGTH = 4;

/**
 * Who you are on this server: your name, your picture, your password, and the
 * devices that are signed in as you.
 *
 * All of it is account-scoped and follows you to any browser, which is why it
 * is one page rather than rows scattered through a "General" list beside this
 * device's theme.
 */
export const ProfilePane: React.FC = () => {
  const { t } = useTranslation();

  return (
    <SettingsPane title={t("home.settings.nav.profile")}>
      <FocusTarget id={["display-name", "avatar"]}>
        <ProfileHeader />
      </FocusTarget>

      <View style={{ marginTop: space["4"] }}>
        <FocusTarget id='password'>
          <PasswordSection />
        </FocusTarget>
      </View>

      {/* Draws nothing unless this browser and this server can both do a
          passkey, so a phone and a server without a domain never see a section
          they cannot use. */}
      <FocusTarget id='passkeys'>
        <PasskeysSection className='mt-4' />
      </FocusTarget>
      <FocusTarget id='link-device'>
        <LinkDevice className='mt-4' />
      </FocusTarget>

      <View style={{ marginTop: space["4"] }}>
        <FocusTarget id='sign-out'>
          <SignOut />
        </FocusTarget>
      </View>
    </SettingsPane>
  );
};

/**
 * Changing your own password, in whichever of the two ways this account has one.
 *
 * An account that came from another server signs in with `PBKDF2(password)`
 * against a salt this server holds, so Jellyfin's own change-password would set
 * a value the sign-in path never consults. It gets `LinkedPasswordSection`
 * instead, which derives the same way a sign-in does and posts the result to
 * `/identity/password`. See `useMySignInMethod` and `docs/INVITES.md` §11c.
 *
 * That branch used to be a row pointing at Settings → Servers, where "the
 * server I run" carried the field. Dan had that block removed as confusing, and
 * a password is a thing about *you* rather than about a machine — so it lives
 * here, next to the other one, and there is nowhere left to be sent.
 */
const PasswordSection: React.FC = () => {
  const { t } = useTranslation();
  const user = useAtomValue(userAtom);
  const method = useMySignInMethod();
  const change = useChangeMyPassword();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (method.data?.derived) {
    return <LinkedPasswordSection salt={method.data} />;
  }

  const submit = async () => {
    setError(null);
    if (next.length < MIN_PASSWORD_LENGTH) {
      setError(t("home.settings.profile.password_too_short"));
      return;
    }
    if (next !== confirm) {
      setError(t("home.settings.profile.password_mismatch"));
      return;
    }
    if (!user?.Id) return;

    try {
      await change.mutateAsync({
        userId: user.Id,
        currentPassword: current,
        password: next,
      });
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.success(t("home.settings.profile.password_changed"));
    } catch {
      // Inline, not a toast and never `Alert.alert`: the browser drops the
      // latter entirely, and "the old password was wrong" belongs beside the
      // field that holds it.
      setError(t("home.settings.profile.password_refused"));
    }
  };

  const filled = current.length > 0 && next.length > 0 && confirm.length > 0;

  return (
    <View>
      <Text
        variant='micro'
        weight='semibold'
        tone='tertiary'
        style={{
          marginLeft: 16,
          marginBottom: 6,
          textTransform: "uppercase",
          letterSpacing: 0.6,
        }}
      >
        {t("home.settings.profile.password_title")}
      </Text>

      <View style={{ gap: space["2"] }}>
        <Input
          testID='profile-password-current'
          secureTextEntry
          autoComplete='current-password'
          textContentType='password'
          value={current}
          onChangeText={setCurrent}
          placeholder={t("home.settings.profile.password_current")}
          accessibilityLabel={t("home.settings.profile.password_current")}
        />
        <Input
          testID='profile-password-new'
          secureTextEntry
          autoComplete='new-password'
          textContentType='newPassword'
          value={next}
          onChangeText={setNext}
          placeholder={t("home.settings.profile.password_new")}
          accessibilityLabel={t("home.settings.profile.password_new")}
        />
        <Input
          testID='profile-password-confirm'
          secureTextEntry
          autoComplete='new-password'
          textContentType='newPassword'
          value={confirm}
          onChangeText={setConfirm}
          onSubmitEditing={submit}
          placeholder={t("home.settings.profile.password_confirm")}
          accessibilityLabel={t("home.settings.profile.password_confirm")}
          error={error}
        />
        <Button
          testID='profile-password-save'
          variant='primary'
          disabled={!filled}
          loading={change.isPending}
          onPress={submit}
        >
          {t("home.settings.profile.password_save")}
        </Button>
      </View>
    </View>
  );
};

/**
 * The password for an account that arrived from another server.
 *
 * One field, not three. There is no current password to confirm — this server has never held one
 * and cannot check it — and no confirmation field, because what is typed is checked against the
 * server the account came from every time it is used there: get it wrong here and the sign-in
 * simply fails, which is the same outcome a mismatched confirmation would produce with more
 * typing.
 *
 * What leaves the device is `PBKDF2(password)` and never the password, derived exactly as a
 * sign-in derives it. `docs/INVITES.md` §11c.
 */
const LinkedPasswordSection: React.FC<{ salt: SignInMethod }> = () => {
  const { t } = useTranslation();
  const api = useAtomValue(apiAtom);
  const nodeOrigin = api?.basePath ? getNodeBaseUrl(api.basePath) : null;

  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!nodeOrigin || password.length < MIN_PASSWORD_LENGTH) {
      setError(t("home.settings.profile.password_too_short"));
      return;
    }
    setSaving(true);
    try {
      // A fresh salt every time, so a stolen old verifier is worth nothing after a change.
      const salt = await newSalt();
      const verifier = await deriveVerifier(
        password,
        salt,
        IDENTITY_KDF_ITERATIONS,
      );
      await setLinkedPassword(
        nodeOrigin,
        { salt, verifier, iterations: IDENTITY_KDF_ITERATIONS },
        api?.accessToken,
      );
      setPassword("");
      toast.success(t("home.settings.profile.password_changed"));
    } catch (e) {
      setError(
        e instanceof Error && e.message
          ? e.message
          : t("home.settings.profile.password_refused"),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <View>
      <Text
        variant='micro'
        weight='semibold'
        tone='tertiary'
        style={{
          marginLeft: 16,
          marginBottom: 6,
          textTransform: "uppercase",
          letterSpacing: 0.6,
        }}
      >
        {t("home.settings.profile.password_title")}
      </Text>
      <Text
        variant='caption'
        tone='secondary'
        style={{ marginLeft: 16, marginBottom: 8 }}
      >
        {t("home.settings.profile.password_linked_detail")}
      </Text>

      <View style={{ gap: space["2"] }}>
        <Input
          testID='profile-linked-password'
          secureTextEntry
          autoComplete='new-password'
          textContentType='newPassword'
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={submit}
          placeholder={t("home.settings.profile.password_new")}
          accessibilityLabel={t("home.settings.profile.password_new")}
          error={error}
        />
        <Button
          testID='profile-linked-password-save'
          variant='primary'
          disabled={password.length === 0}
          loading={saving}
          onPress={submit}
        >
          {t("home.settings.profile.password_save")}
        </Button>
      </View>
    </View>
  );
};

const SignOut: React.FC = () => {
  const { t } = useTranslation();
  const { logout } = useJellyfin();

  return (
    <ListGroup title={t("home.settings.sections.account")}>
      <ListItem
        testID='settings-sign-out'
        textColor='red'
        onPress={() => logout()}
        title={t("home.settings.sections.sign_out")}
      />
    </ListGroup>
  );
};
