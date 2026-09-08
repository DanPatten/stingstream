import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Linking, Platform, View } from "react-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { Input } from "@/components/common/Input";
import { Pill } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { space } from "@/constants/theme";
import {
  COORDINATOR_GUIDE_URL,
  type CoordinatorCheck,
  checkCoordinator,
  describeCoordinator,
  normalizeCoordinatorUrl,
} from "@/utils/mesh/coordinator";

/**
 * One field: **where people reach you**.
 *
 * What this replaced asked you to pick "Default" or "My own server" from two radio rows, then
 * explained iroh's relays, n0 DNS and the BitTorrent DHT in a paragraph, then offered a third row
 * about hosting your own. Dan's verdict was that the choice was "confusing as fuck", and he was
 * right: it made an implementation detail into a decision, and the labels were not even true —
 * "Default" quietly used StingStream's shared server as a fallback anyway.
 *
 * So there is no choice to make now, only an address to leave alone or change:
 *
 * - **Left as it is** — the shared StingStream server. Friends can join while you are offline.
 * - **Emptied** — peer to peer, nothing of ours involved. Joining needs you online.
 * - **Your own domain** — pointed at your own server. No coordinator at all; people reach you
 *   directly, and that address is what share links are built from.
 *
 * Which of the last two an address is gets **detected**, not asked: a coordinator and a node
 * answer `/healthz` with different fields, so one request tells them apart (`checkCoordinator`).
 * The detail that used to be in the paragraph lives behind "How this works", where somebody
 * curious can find it and nobody else has to read it.
 */

/** Prefilled so the common case is "leave it alone". Empty is a deliberate act, not the default. */
export const DEFAULT_SHARING_ADDRESS =
  "https://stingstream-coordinator-production.up.railway.app";

export type SharingAddressValue = {
  /** Exactly what is in the field, so the parent can round-trip it. */
  input: string;
  /** What the probe made of it; `null` until it has answered. */
  check: CoordinatorCheck;
};

export const emptySharingAddress = (
  input = DEFAULT_SHARING_ADDRESS,
): SharingAddressValue => ({ input, check: { state: "idle" } });

/** Nothing typed at all: peer to peer, and ready to create. */
const isBlank = (value: SharingAddressValue) => value.input.trim().length === 0;

/** The address we ship, untouched. Not a guess a typo could hide in. */
const isUntouchedDefault = (value: SharingAddressValue) =>
  value.input.trim() === DEFAULT_SHARING_ADDRESS;

/**
 * Whether the form can be submitted.
 *
 * Blank is ready, and so is an address that answered as a coordinator or as somebody's own server.
 * The **shipped address is also ready even when the check has not succeeded** — it is ours, not
 * something typed, so there is no typo for the check to catch, and a coordinator that is briefly
 * unreachable (or a browser that discarded the answer for want of a CORS header, which is what
 * every build before the one that added it will do) must not be able to stop somebody creating a
 * group. A wrong address that was typed still blocks, which is the case the check exists for.
 */
export const sharingAddressReady = (value: SharingAddressValue): boolean =>
  isBlank(value) ||
  isUntouchedDefault(value) ||
  value.check.state === "ok" ||
  value.check.state === "own-server";

/**
 * What to send as the group's `coordinator`.
 *
 * A coordinator becomes the group's coordinator. **Their own server does not**: the whole point of
 * pointing at your own domain is that there is no coordinator in the middle, so the group is
 * created peer-to-peer and the address is used for links rather than for rendezvous.
 */
export const sharingAddressCoordinator = (
  value: SharingAddressValue,
): string | null => {
  if (value.check.state === "ok") return value.check.url;
  // The shipped address still counts when the check could not complete — see `sharingAddressReady`.
  // Without this the field would show a coordinator while the group was quietly created with none.
  if (isUntouchedDefault(value) && value.check.state !== "own-server") {
    return DEFAULT_SHARING_ADDRESS;
  }
  return null;
};

/** The address share links should be built from, when there is one. */
export const sharingAddressDirect = (
  value: SharingAddressValue,
): string | null =>
  value.check.state === "own-server" ? value.check.url : null;

/** A hostname is typed a character at a time and each check is a network round trip. */
const CHECK_DELAY_MS = 600;

export function SharingAddress({
  value,
  onChange,
  disabled,
}: {
  value: SharingAddressValue;
  onChange: (next: SharingAddressValue) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [explainerOpen, setExplainerOpen] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const input = value.input;

  useEffect(() => {
    if (!input.trim()) {
      abort.current?.abort();
      onChange({ input, check: { state: "idle" } });
      return;
    }
    onChange({ input, check: { state: "checking" } });
    const controller = new AbortController();
    abort.current?.abort();
    abort.current = controller;
    const timer = setTimeout(async () => {
      const result = await checkCoordinator(input, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      onChange({ input, check: result });
    }, CHECK_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `onChange` is intentionally not a dependency: callers pass an inline closure, and re-running
    // the check on every render of the parent would make the field unusable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);

  const setInput = useCallback(
    (next: string) => onChange({ input: next, check: { state: "checking" } }),
    [onChange],
  );

  return (
    <View>
      <Input
        placeholder={t("sharing.address_placeholder")}
        autoCapitalize='none'
        autoCorrect={false}
        keyboardType={Platform.OS === "web" ? "default" : "url"}
        value={input}
        editable={!disabled}
        onChangeText={setInput}
        testID='sharing-address'
      />
      <View style={{ marginTop: space[2] }}>
        <Status
          check={value.check}
          blank={!input.trim()}
          isDefault={input.trim() === DEFAULT_SHARING_ADDRESS}
        />
      </View>
      <Button
        variant='ghost'
        size='sm'
        onPress={() => setExplainerOpen(true)}
        testID='sharing-address-explainer'
        style={{ alignSelf: "flex-start", marginTop: space[1] }}
      >
        {t("sharing.address_learn_more")}
      </Button>

      <Dialog
        visible={explainerOpen}
        onClose={() => setExplainerOpen(false)}
        title={t("sharing.address_explainer_title")}
      >
        <View style={{ gap: space[3] }}>
          <Explains
            title={t("sharing.address_explainer_shared_title")}
            body={t("sharing.address_explainer_shared_body")}
          />
          <Explains
            title={t("sharing.address_explainer_empty_title")}
            body={t("sharing.address_explainer_empty_body")}
          />
          <Explains
            title={t("sharing.address_explainer_own_title")}
            body={t("sharing.address_explainer_own_body")}
          />
          {/*
            The one thing words cannot cover: the actual steps. Running a shared server of your
            own is a deployment, not a setting, so it belongs in a guide rather than in a modal —
            and a modal that explains a choice without saying where to go next is only half of it.
          */}
          <Button
            variant='secondary'
            size='sm'
            icon='link'
            onPress={() => void Linking.openURL(COORDINATOR_GUIDE_URL)}
            testID='sharing-address-guide'
            style={{ alignSelf: "flex-start" }}
          >
            {t("sharing.address_explainer_guide")}
          </Button>
        </View>
      </Dialog>
    </View>
  );
}

const Explains = ({ title, body }: { title: string; body: string }) => (
  <View style={{ gap: space[1] }}>
    <Text variant='body' weight='semibold'>
      {title}
    </Text>
    <Text variant='caption' tone='secondary'>
      {body}
    </Text>
  </View>
);

/** One line under the field, saying what the address turned out to be. */
function Status({
  check,
  blank,
  isDefault,
}: {
  check: CoordinatorCheck;
  blank: boolean;
  isDefault: boolean;
}) {
  const { t } = useTranslation();

  if (blank) {
    return (
      <Text variant='caption' tone='secondary'>
        {t("sharing.address_blank_hint")}
      </Text>
    );
  }
  switch (check.state) {
    case "checking":
    case "idle":
      return (
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <ActivityIndicator size='small' />
          <Text variant='caption' tone='secondary' style={{ marginLeft: 8 }}>
            {t("sharing.address_checking")}
          </Text>
        </View>
      );
    case "ok":
      return (
        <Pill
          tone='success'
          icon='check'
          label={t("sharing.address_shared_ok", {
            health: describeCoordinator(check.health),
          })}
        />
      );
    case "own-server":
      return (
        <Pill
          tone='success'
          icon='check'
          label={t("sharing.address_own_ok", {
            name: check.name ?? normalizeCoordinatorUrl(check.url) ?? check.url,
          })}
        />
      );
    default:
      // The shipped address failing its check is not the user's mistake and does not stop them:
      // it is a coordinator having a moment, or an older one with no CORS header on /healthz.
      // Saying so in a neutral tone beats a red warning about something they did not do.
      return isDefault ? (
        <Text variant='caption' tone='secondary'>
          {t("sharing.address_default_unverified")}
        </Text>
      ) : (
        <Pill tone='danger' icon='warning' label={check.message} />
      );
  }
}
