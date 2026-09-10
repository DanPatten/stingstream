import { Ionicons } from "@expo/vector-icons";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, View } from "react-native";
import { Button } from "@/components/Button";
import { FormError } from "@/components/common/FormError";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { FocusPressable } from "@/components/login/FocusPressable";
import { tokens } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useTheme } from "@/hooks/useTheme";
import type { InviteDescription } from "@/lib/stingstream/invitesApi";
import {
  isSetupFormValid,
  PASSWORD_MIN_LENGTH,
  type SetupFormErrors,
  validateSetupForm,
} from "@/lib/stingstream/setup";

export interface InviteAccountFormProps {
  /** What the link is for: whose server, who sent it, and what it opens. */
  invite: InviteDescription;
  /** Creates the account and signs in. Throws with a ready-to-show sentence when it cannot. */
  onSubmit: (username: string, password: string) => Promise<void>;
}

/**
 * The screen somebody sees when they open an invite link, having never used StingStream.
 *
 * This is the whole of "you get invited to a server and you create an account if you never logged
 * in". There is no separate sign-up, no email, no address to type and nothing central to register
 * with — the link *is* the introduction, and the account it makes lives on the server that sent it.
 *
 * The rules are the first-run screen's, reused deliberately (`validateSetupForm`): a name and a
 * password chosen here have to satisfy exactly what a name and a password chosen there do, and two
 * copies of that logic is how they end up disagreeing.
 *
 * **What is above the form matters as much as the form.** Somebody opening this has been sent a
 * link by a person, and the question in their head is "whose is this and what am I agreeing to".
 * So the server's name, who invited them and the list of libraries are stated before they are
 * asked for anything — and the library list is the honest version of what they are getting, not a
 * vague "access to a library".
 *
 * **The username may arrive pre-filled**, from whatever whoever invited them typed. Dan: *"owner
 * sets username - can be changed when accepting the invite."* Pre-filled and editable, not fixed:
 * a name somebody else chose is a suggestion, and the person it belongs to is the one who will be
 * signing in with it. An invite that named nobody simply opens with an empty field, as it always
 * did.
 */
export const InviteAccountForm: React.FC<InviteAccountFormProps> = ({
  invite,
  onSubmit,
}) => {
  const { color } = useTheme();
  const { t } = useTranslation();
  const { isCompact } = useBreakpoint();

  const [username, setUsername] = useState(invite.username ?? "");
  const [password, setPassword] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const errors: SetupFormErrors = validateSetupForm({ username, password });
  const showing = (field: keyof SetupFormErrors): string | null =>
    touched[field] ? (errors[field] ?? null) : null;

  const submit = useCallback(async () => {
    if (busy) return;
    Keyboard.dismiss();
    setTouched({ username: true, password: true });
    setFormError(null);
    if (!isSetupFormValid(validateSetupForm({ username, password }))) {
      return;
    }

    setBusy(true);
    try {
      await onSubmit(username.trim(), password);
    } catch (e) {
      setFormError(
        e instanceof Error && e.message
          ? e.message
          : t("invites.error_unexpected"),
      );
    } finally {
      setBusy(false);
    }
  }, [busy, username, password, onSubmit, t]);

  const revealToggle = (
    <FocusPressable
      onPress={() => setRevealed((v) => !v)}
      accessibilityRole='button'
      accessibilityLabel={
        revealed ? t("login.hide_password") : t("login.show_password")
      }
      hitSlop={8}
      style={{
        position: "absolute",
        right: 10,
        top: 0,
        height: tokens.control.minTouchTarget,
        width: 32,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Ionicons
        name={revealed ? "eye-off-outline" : "eye-outline"}
        size={18}
        color={color.text.tertiary}
      />
    </FocusPressable>
  );

  return (
    <View testID='invite-create-account'>
      <Text variant={isCompact ? "display" : "title"} weight='bold'>
        {t("invites.landing_title", { server: invite.serverName })}
      </Text>
      <Text variant='body' tone='secondary' style={{ marginTop: 8 }}>
        {invite.invitedBy
          ? t("invites.landing_invited_by", { name: invite.invitedBy })
          : t("invites.landing_invited")}
      </Text>

      <InviteLibraryList
        libraries={invite.libraries}
        isAdministrator={invite.isAdministrator}
      />

      <View style={{ marginTop: 20, gap: 12 }}>
        <Input
          testID='invite-username'
          aria-label={t("setup.username")}
          placeholder={t("setup.username")}
          value={username}
          onChangeText={setUsername}
          onBlur={() => setTouched((s) => ({ ...s, username: true }))}
          error={showing("username")}
          autoCapitalize='none'
          autoCorrect={false}
          autoComplete='username-new'
          textContentType='username'
          returnKeyType='next'
          maxLength={64}
          editable={!busy}
        />
        <View>
          <Input
            testID='invite-password'
            aria-label={t("setup.password")}
            placeholder={t("setup.password")}
            value={password}
            onChangeText={setPassword}
            onBlur={() => setTouched((s) => ({ ...s, password: true }))}
            error={showing("password")}
            secureTextEntry={!revealed}
            autoCapitalize='none'
            autoComplete='new-password'
            textContentType='newPassword'
            returnKeyType='go'
            maxLength={500}
            editable={!busy}
            onSubmitEditing={submit}
            style={{ paddingRight: 44 }}
          />
          {revealToggle}
        </View>
        {showing("password") ? null : (
          <Text variant='caption' tone='tertiary' style={{ marginTop: -6 }}>
            {t("setup.password_hint", { min: PASSWORD_MIN_LENGTH })}
          </Text>
        )}
      </View>

      <FormError message={formError} style={{ marginTop: 12 }} />

      <Button
        testID='invite-submit'
        variant='primary'
        size='lg'
        onPress={submit}
        loading={busy}
        disabled={busy}
        style={{ marginTop: 20 }}
      >
        {t("invites.create_account")}
      </Button>
    </View>
  );
};

/**
 * What the invite actually opens.
 *
 * Named libraries rather than a count, because "2 libraries" tells somebody nothing and the whole
 * question they have is what they are being given access to. A viewer invite always names at least
 * one — the server refuses to mint one that names none — so there is no empty case to draw for it.
 *
 * **An administrator invite names none, and that is the one empty case there is.** It is not drawn
 * as an empty list: an administrator sees every library, including ones added later, and saying so
 * is both shorter and truer than listing today's. Somebody should know they are accepting the run
 * of the server while they can still decline it.
 */
export const InviteLibraryList: React.FC<{
  libraries: { id: string; name: string }[];
  isAdministrator?: boolean;
}> = ({ libraries, isAdministrator }) => {
  const { color } = useTheme();
  const { t } = useTranslation();
  if (!isAdministrator && libraries.length === 0) return null;

  if (isAdministrator) {
    return (
      <View
        testID='invite-landing-administrator'
        style={{
          marginTop: 16,
          padding: 12,
          borderRadius: 12,
          backgroundColor: color.bg["2"],
          gap: 6,
        }}
      >
        <Text variant='caption' tone='tertiary' weight='medium'>
          {t("invites.landing_administrator_title")}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Ionicons
            name='checkmark-circle'
            size={16}
            color={color.state.success}
          />
          <Text variant='body'>{t("invites.landing_administrator_body")}</Text>
        </View>
      </View>
    );
  }

  return (
    <View
      style={{
        marginTop: 16,
        padding: 12,
        borderRadius: 12,
        backgroundColor: color.bg["2"],
        gap: 6,
      }}
    >
      <Text variant='caption' tone='tertiary' weight='medium'>
        {t("invites.landing_libraries")}
      </Text>
      {libraries.map((library) => (
        <View
          key={library.id}
          style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
        >
          <Ionicons
            name='checkmark-circle'
            size={16}
            color={color.state.success}
          />
          <Text variant='body'>{library.name}</Text>
        </View>
      ))}
    </View>
  );
};
