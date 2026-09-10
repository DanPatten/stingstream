import { useAtomValue } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { space } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useMySignInMethod } from "@/lib/stingstream/identity";
import { useChangeMyPassword } from "@/lib/stingstream/serverUsers";
import { useJellyfin, userAtom } from "@/providers/JellyfinProvider";
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
    <SettingsPane title={t("home.settings.nav.profile")} scope='account'>
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
 * Changing your own password — or, for an account that came from another
 * server, saying plainly that there is nothing here to change.
 *
 * A linked account signs in with `PBKDF2(password)` against a salt this server
 * holds; the password itself belongs to the server the account came from. A
 * form here would either fail or, worse, set a second password that the sign-in
 * path never consults. See `useMySignInMethod`.
 */
const PasswordSection: React.FC = () => {
  const { t } = useTranslation();
  const router = useRouter();
  const user = useAtomValue(userAtom);
  const method = useMySignInMethod();
  const change = useChangeMyPassword();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (method.data?.derived) {
    return (
      <ListGroup title={t("home.settings.profile.password_title")}>
        <ListItem
          title={t("home.settings.profile.password_elsewhere")}
          subtitle={t("home.settings.profile.password_elsewhere_detail")}
          showArrow
          onPress={() => router.navigate("/settings/servers" as never)}
        />
      </ListGroup>
    );
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
        // Web has no second app to return to, so say where it lands.
        subtitle={
          Platform.OS === "web"
            ? t("home.settings.profile.sign_out_detail")
            : undefined
        }
      />
    </ListGroup>
  );
};
