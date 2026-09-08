import { requireOptionalNativeModule } from "expo";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { FormError } from "@/components/common/FormError";
import { Icon } from "@/components/common/Icon";
import { Input } from "@/components/common/Input";
import { PageContainer } from "@/components/common/PageContainer";
import { Pill } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { radius, tokens } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import {
  useInviteLibraries,
  useInvites,
  useMintInvite,
  useRevokeInvite,
} from "@/lib/stingstream/invites";
import {
  INVITE_DEFAULT_EXPIRY_DAYS,
  INVITE_LABEL_MAX_LENGTH,
  type InviteLibrary,
  type InviteSummary,
  type MintedInvite,
} from "@/lib/stingstream/invitesApi";
import { EmptyState, ErrorState, LoadingState } from "../shared/ScreenState";

/** How long an invite can be given, offered as the few answers people actually want. */
const EXPIRY_CHOICES = [1, 7, 30, 90] as const;

/**
 * The chosen periods, named rather than counted.
 *
 * A `{{count}} days` string produces "1 days" for the first choice, and pluralisation rules to
 * avoid that are a lot of machinery for four fixed values that people would say out loud as
 * "a week" and "a month" anyway.
 */
const expiryLabel = (days: number, t: (key: string) => string): string => {
  if (days === 1) return t("invites.expiry_choice_day");
  if (days === 7) return t("invites.expiry_choice_week");
  if (days === 30) return t("invites.expiry_choice_month");
  return t("invites.expiry_choice_quarter");
};

/**
 * Inviting a person to this server.
 *
 * The feature Part 5 is built around: somebody with no account anywhere opens a link, creates an
 * account **here**, and sees the libraries chosen for them. Nothing central is involved — no
 * directory, no usernames anywhere but this server, nothing to register with.
 *
 * Two decisions Dan made are visible on this screen and worth stating, because both could be read
 * as omissions:
 *
 * - **The inviter picks the libraries, per invite.** Not a role, not a default, not "everything I
 *   have". So the picker is part of minting rather than something to configure afterwards, and it
 *   refuses to mint with nothing chosen — a working link to an account that can see nothing looks
 *   like a bug on the other end and reads as a snub.
 * - **Only an administrator invites.** Holding an account on somebody's server does not let you
 *   hand out accounts on it. The route enforces it; the screen is behind `RequiresAdmin`.
 */
export function InvitesScreen() {
  const { t } = useTranslation();
  const invites = useInvites();
  const revoke = useRevokeInvite();

  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState<MintedInvite | null>(null);

  if (invites.isPending) return <LoadingState />;
  if (invites.error) {
    return (
      <ErrorState
        message={
          invites.error instanceof Error
            ? invites.error.message
            : t("invites.list_failed_title")
        }
        onRetry={() => invites.refetch()}
      />
    );
  }

  const rows = invites.data ?? [];

  return (
    <PageContainer width='settings'>
      <Text variant='caption' tone='secondary' style={{ marginBottom: 12 }}>
        {t("invites.screen_description")}
      </Text>

      <Button
        variant='primary'
        icon='invite'
        onPress={() => setMinting(true)}
        testID='invites-new'
      >
        {t("invites.new")}
      </Button>

      <View style={{ height: 20 }} />

      {rows.length === 0 ? (
        <EmptyState
          icon='invite'
          title={t("invites.empty_title")}
          detail={t("invites.empty_detail")}
        />
      ) : (
        <ListGroup title={t("invites.list_title")}>
          {rows.map((invite) => (
            <InviteRow
              key={invite.id}
              invite={invite}
              busy={revoke.isPending}
              onRevoke={() => {
                revoke.mutate(invite.id, {
                  onSuccess: () => toast.success(t("invites.revoked")),
                  onError: (e) => toast.error(e.message),
                });
              }}
            />
          ))}
        </ListGroup>
      )}

      <MintInviteDialog
        visible={minting}
        onClose={() => setMinting(false)}
        onMinted={(result) => {
          setMinting(false);
          setMinted(result);
        }}
      />

      <MintedInviteDialog minted={minted} onClose={() => setMinted(null)} />
    </PageContainer>
  );
}

/**
 * One invite in the list.
 *
 * A spent invite stays here rather than disappearing, and shows the account it created: an
 * administrator looking at a name they do not recognise in Users should be able to find out where
 * it came from, and this is the only record of that.
 */
const InviteRow: React.FC<{
  invite: InviteSummary;
  busy: boolean;
  onRevoke: () => void;
}> = ({ invite, busy, onRevoke }) => {
  const { t } = useTranslation();

  const tone =
    invite.status === "valid"
      ? "success"
      : invite.status === "used"
        ? "neutral"
        : "warning";

  const subtitle =
    invite.status === "used"
      ? t("invites.row_used", {
          name: invite.redeemedUserName ?? "",
          libraries: invite.libraries.map((l) => l.name).join(", "),
        })
      : t("invites.row_libraries", {
          libraries: invite.libraries.map((l) => l.name).join(", "),
        });

  return (
    <ListItem
      title={invite.label || t("invites.row_untitled")}
      subtitle={subtitle}
      iconAfter={
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Pill label={t(`invites.status_${invite.status}`)} tone={tone} />
          {/* Withdrawing is only meaningful while an invite could still be used. A spent or
              expired one is already refused, and a button that does nothing is worse than none. */}
          {invite.status === "valid" ? (
            <Button
              variant='ghost'
              size='sm'
              icon='delete'
              disabled={busy}
              onPress={onRevoke}
              accessibilityLabel={t("invites.revoke")}
            >
              {""}
            </Button>
          ) : null}
        </View>
      }
    />
  );
};

/** Label, libraries, expiry — the three things an invite is. */
const MintInviteDialog: React.FC<{
  visible: boolean;
  onClose: () => void;
  onMinted: (result: MintedInvite) => void;
}> = ({ visible, onClose, onMinted }) => {
  const { t } = useTranslation();
  const libraries = useInviteLibraries();
  const mint = useMintInvite();

  const [label, setLabel] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [days, setDays] = useState<number>(INVITE_DEFAULT_EXPIRY_DAYS);
  const [error, setError] = useState<string | null>(null);

  const available = useMemo(() => libraries.data ?? [], [libraries.data]);

  const toggle = useCallback((id: string) => {
    setChosen((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
  }, []);

  const reset = useCallback(() => {
    setLabel("");
    setChosen([]);
    setDays(INVITE_DEFAULT_EXPIRY_DAYS);
    setError(null);
  }, []);

  const submit = useCallback(() => {
    setError(null);
    mint.mutate(
      { label: label.trim(), libraries: chosen, expiresInDays: days },
      {
        onSuccess: (result) => {
          reset();
          onMinted(result);
        },
        onError: (e) => setError(e.message),
      },
    );
  }, [chosen, days, label, mint, onMinted, reset]);

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
          <Text variant='caption' tone='secondary' weight='medium'>
            {t("invites.label")}
          </Text>
          <Text variant='caption' tone='tertiary' style={{ marginBottom: 6 }}>
            {t("invites.label_hint")}
          </Text>
          <Input
            testID='invite-label'
            placeholder={t("invites.label_placeholder")}
            value={label}
            onChangeText={setLabel}
            maxLength={INVITE_LABEL_MAX_LENGTH}
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
          {libraries.isPending ? (
            <LoadingState />
          ) : available.length === 0 ? (
            <Text variant='caption' tone='tertiary'>
              {t("invites.libraries_none")}
            </Text>
          ) : (
            <View style={{ gap: 4 }}>
              {available.map((library) => (
                <LibraryChoice
                  key={library.id}
                  library={library}
                  selected={chosen.includes(library.id)}
                  disabled={mint.isPending}
                  onToggle={() => toggle(library.id)}
                />
              ))}
            </View>
          )}
        </View>

        <View>
          <Text variant='caption' tone='secondary' weight='medium'>
            {t("invites.expiry")}
          </Text>
          <Text variant='caption' tone='tertiary' style={{ marginBottom: 6 }}>
            {t("invites.expiry_hint")}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {EXPIRY_CHOICES.map((choice) => (
              <Pill
                key={choice}
                label={expiryLabel(choice, t)}
                tone={days === choice ? "accent" : "neutral"}
                emphasis={days === choice ? "solid" : "soft"}
                onPress={() => setDays(choice)}
                disabled={mint.isPending}
              />
            ))}
          </View>
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

const LibraryChoice: React.FC<{
  library: InviteLibrary;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
}> = ({ library, selected, disabled, onToggle }) => {
  // The accent is a user setting, so it is read rather than named -- a hard-coded teal is wrong
  // for anybody who picked violet or amber in Appearance.
  const { accent } = useTheme();
  return (
    <ListItem
      title={library.name}
      disabled={disabled}
      onPress={onToggle}
      iconAfter={
        <Icon
          name={selected ? "radioOn" : "radioOff"}
          size={20}
          color={selected ? accent[500] : tokens.color.text.tertiary}
        />
      }
    />
  );
};

/**
 * The link, once and only once.
 *
 * The server stores a hash of the token, so this dialog is holding the only copy that will ever
 * exist — which is why it says so, and why closing it is a deliberate act rather than a tap
 * outside. Losing it costs one more mint, which is the right trade against a credential that can
 * be re-read from a screen somebody walked away from.
 */
const MintedInviteDialog: React.FC<{
  minted: MintedInvite | null;
  onClose: () => void;
}> = ({ minted, onClose }) => {
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
