import { requireOptionalNativeModule } from "expo";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { FormError } from "@/components/common/FormError";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { radius, tokens } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useInviteLibraries, useMintInvite } from "@/lib/stingstream/invites";
import {
  INVITE_USERNAME_MAX_LENGTH,
  type MintedInvite,
} from "@/lib/stingstream/invitesApi";
import { LibraryPicker } from "../shared/LibraryPicker";
import { useChosenLibraries } from "../shared/useChosenLibraries";

/**
 * Inviting somebody to watch, from wherever the question was asked.
 *
 * ## Why this is one component and not two screens
 *
 * Dan: *"Invitation is a bit clunky, I click invite -> Someone to watch -> and then have to click
 * invite again which is done."*
 *
 * He was right, and the reason is worth writing down: the Sharing screen's chooser was a **router**
 * dressed as a decision. Answering "someone to watch" navigated to a different screen whose primary
 * button asked the same thing again. Two presses, two screens, one intent.
 *
 * So the flow lives here rather than inside `InvitesScreen`, and both screens mount it. Answering
 * the chooser opens the form; creating the invite replaces the form with the link. One act.
 *
 * The mint → minted hand-off is internal for the same reason: a caller that had to hold both
 * dialogs' state would be a caller that could get the transition wrong, and there are two of them.
 */
export const InvitePerson: React.FC<{
  visible: boolean;
  onClose: () => void;
  /**
   * Take the user to this server's address setting.
   *
   * Optional, and it exists because the right answer differs by host. `SharingScreen` **is** the
   * screen holding that field, so it unfolds its own Advanced section in place rather than pushing
   * a second copy of itself; anywhere else navigates there. Defaulting to the navigation means a
   * future third caller gets something that works.
   */
  onSetUpAddress?: () => void;
}> = ({ visible, onClose, onSetUpAddress }) => {
  const router = useRouter();
  const [minted, setMinted] = useState<MintedInvite | null>(null);

  const setUpAddress = useCallback(() => {
    setMinted(null);
    onClose();
    if (onSetUpAddress) {
      onSetUpAddress();
      return;
    }
    router.push({
      pathname: "/settings/groups",
      params: { advanced: "1" },
    });
  }, [onClose, onSetUpAddress, router]);

  return (
    <>
      <MintInviteDialog
        visible={visible && !minted}
        onClose={onClose}
        onMinted={setMinted}
      />
      <MintedInviteDialog
        minted={minted}
        onClose={() => {
          setMinted(null);
          onClose();
        }}
        onSetUpAddress={setUpAddress}
      />
    </>
  );
};

/**
 * A name and the libraries. That is the whole invite.
 *
 * **The name is theirs, not a note to yourself.** It was labelled *"Who is this for?"* with the
 * hint *"A note to yourself. Only you see it."* — Dan: *"change Who is this for to just 'Username'
 * no sub text."* It is now the account name the invited person arrives with, pre-filled on the
 * landing page and still theirs to change, which is the shape Dan chose: *"owner sets username -
 * can be changed when accepting the invite."* Leaving it blank means they pick their own.
 *
 * **There is no expiry.** *"Remove how long the link works, these all work indefinetly until
 * revoked - no short term links."* The picker, its four choices and the whole notion of an invite
 * running out on its own are gone; deleting one is what ends it.
 */
const MintInviteDialog: React.FC<{
  visible: boolean;
  onClose: () => void;
  onMinted: (result: MintedInvite) => void;
}> = ({ visible, onClose, onMinted }) => {
  const { t } = useTranslation();
  const libraries = useInviteLibraries();
  const mint = useMintInvite();

  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);

  const available = useMemo(() => libraries.data ?? [], [libraries.data]);
  // Everything ticked to begin with; unticking is the edit. See the hook for why that is a UI
  // default and not a server one.
  const { chosen, toggle, reset: resetChosen } = useChosenLibraries(available);

  const reset = useCallback(() => {
    setUsername("");
    resetChosen();
    setError(null);
  }, [resetChosen]);

  const submit = useCallback(() => {
    setError(null);
    mint.mutate(
      { label: username.trim(), libraries: chosen },
      {
        onSuccess: (result) => {
          reset();
          onMinted(result);
        },
        onError: (e) => setError(e.message),
      },
    );
  }, [chosen, username, mint, onMinted, reset]);

  return (
    <Dialog
      visible={visible}
      onClose={() => {
        reset();
        onClose();
      }}
      title={t("invites.new")}
      description={t("invites.new_description")}
    >
      <View style={{ gap: 16 }}>
        <View>
          <Text
            variant='caption'
            tone='secondary'
            weight='medium'
            style={{ marginBottom: 6 }}
          >
            {t("invites.username")}
          </Text>
          <Input
            testID='invite-label'
            placeholder={t("invites.username_placeholder")}
            value={username}
            onChangeText={setUsername}
            maxLength={INVITE_USERNAME_MAX_LENGTH}
            autoCapitalize='none'
            autoCorrect={false}
            editable={!mint.isPending}
          />
        </View>

        <View>
          <Text variant='caption' tone='secondary' weight='medium'>
            {t("invites.libraries")}
          </Text>
          <Text variant='caption' tone='tertiary' style={{ marginBottom: 6 }}>
            {t("invites.libraries_hint")}
          </Text>
          <LibraryPicker
            available={available}
            selected={chosen}
            onToggle={toggle}
            loading={libraries.isPending}
            disabled={mint.isPending}
          />
        </View>

        <FormError message={error} />

        <Button
          testID='invite-mint'
          variant='primary'
          size='lg'
          onPress={submit}
          loading={mint.isPending}
          // Disabled rather than allowed-and-refused: the server says the same thing, but a
          // button that cannot work should look like it.
          disabled={mint.isPending || chosen.length === 0}
        >
          {t("invites.mint")}
        </Button>
      </View>
    </Dialog>
  );
};

/**
 * The link, once and only once.
 *
 * The server stores a hash of the token, so this dialog is holding the only copy that will ever
 * exist — which is why it says so, and why closing it is a deliberate act rather than a tap
 * outside. Losing it costs one more mint, which is the right trade against a credential that can
 * be re-read from a screen somebody walked away from.
 *
 * **There is nearly always a link now.** It used to be a bare token whenever the server had no
 * domain, with a sentence suggesting one be added and no way to do it. Dan: *"if no domain is setup
 * use the host's ip address for LAN and if there is a domain setup then use that instead. Show a
 * box if there is no domain setup that it wont work externally until setup with a nice setup now
 * link."* So a LAN link is offered with the one thing that is actually true about it said out loud
 * — it works in this house — and the way to fix that is one press away.
 */
const MintedInviteDialog: React.FC<{
  minted: MintedInvite | null;
  onClose: () => void;
  onSetUpAddress: () => void;
}> = ({ minted, onClose, onSetUpAddress }) => {
  const { t } = useTranslation();
  const value = minted?.url ?? minted?.token ?? null;

  const copy = useCallback(async () => {
    if (!value) return;
    if (Platform.OS === "web") {
      try {
        await navigator.clipboard.writeText(value);
        toast.success(t("invites.copied"));
      } catch {
        toast.error(t("invites.copy_failed"));
      }
      return;
    }
    if (!requireOptionalNativeModule("ExpoClipboard")) {
      toast.error(t("sharing.invite_clipboard_unavailable"));
      return;
    }
    const Clipboard = await import("expo-clipboard");
    await Clipboard.setStringAsync(value);
    toast.success(t("invites.copied"));
  }, [t, value]);

  return (
    <Dialog
      visible={!!minted}
      onClose={onClose}
      title={t("invites.minted_title")}
      description={
        minted?.url ? t("invites.minted_link") : t("invites.minted_no_link")
      }
    >
      {value ? (
        <View>
          {minted?.url ? (
            <View style={{ alignItems: "center", marginBottom: 16 }}>
              <View
                style={{
                  padding: 12,
                  borderRadius: radius.md,
                  backgroundColor: "#FFFFFF",
                }}
              >
                <QRCode
                  value={minted.url}
                  size={180}
                  color='#000000'
                  backgroundColor='#FFFFFF'
                />
              </View>
            </View>
          ) : null}

          <View
            style={{
              borderRadius: radius.sm,
              backgroundColor: tokens.color.bg["2"],
              padding: 12,
            }}
          >
            {/* Shown whole. An ellipsis in the middle of a credential is the one place somebody
                cannot tell styling from content. */}
            <Text variant='caption' selectable testID='invite-value'>
              {value}
            </Text>
          </View>

          {minted?.urlIsLan ? (
            <LanOnlyNotice onSetUpAddress={onSetUpAddress} />
          ) : null}

          <Text
            variant='caption'
            style={{ marginTop: 10, color: tokens.color.state.warning }}
          >
            {t("invites.minted_only_copy")}
          </Text>

          <Button
            variant='secondary'
            icon='link'
            onPress={copy}
            style={{ marginTop: 12 }}
          >
            {t("invites.copy")}
          </Button>
        </View>
      ) : null}
    </Dialog>
  );
};

/**
 * "This works at home. Here is how to make it work anywhere."
 *
 * Drawn only when the link came from the LAN candidate, so a server with a domain never sees it.
 * The button is the point — the sentence it replaces ended *"Add a domain under Sharing to get a
 * link instead"* and left somebody to go and find that themselves.
 */
const LanOnlyNotice: React.FC<{ onSetUpAddress: () => void }> = ({
  onSetUpAddress,
}) => {
  const { t } = useTranslation();
  return (
    <View
      testID='invite-lan-only'
      style={{
        marginTop: 12,
        padding: 12,
        borderRadius: radius.sm,
        borderWidth: 1,
        borderColor: tokens.color.border.subtle,
        backgroundColor: tokens.color.bg["2"],
        gap: 6,
      }}
    >
      <Text variant='caption' weight='semibold'>
        {t("invites.lan_only_title")}
      </Text>
      <Text variant='caption' tone='secondary'>
        {t("invites.lan_only_body")}
      </Text>
      <Button
        testID='invite-set-up-address'
        variant='ghost'
        size='sm'
        icon='link'
        onPress={onSetUpAddress}
        style={{ alignSelf: "flex-start" }}
      >
        {t("invites.lan_only_action")}
      </Button>
    </View>
  );
};
