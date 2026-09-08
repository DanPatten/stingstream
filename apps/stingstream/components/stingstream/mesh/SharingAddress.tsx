import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Platform, View } from "react-native";
import { Input } from "@/components/common/Input";
import { Pill } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { space } from "@/constants/theme";
import {
  type CoordinatorCheck,
  checkCoordinator,
  describeCoordinator,
  normalizeCoordinatorUrl,
} from "@/utils/mesh/coordinator";
import {
  isBlank,
  isShippedDefault,
  type SharingAddressAccept,
  type SharingAddressValue,
} from "@/utils/mesh/sharingAddress";

/**
 * One address field, checked live against whatever answers at it.
 *
 * Used twice on the Sharing server settings page, for the two addresses that page holds — and the
 * two are genuinely different things, which is why this takes an `accept`. A **sharing server** is
 * a coordinator: it introduces members to each other and passes a connection along when two homes
 * cannot reach each other directly. **Your server's address** is a domain pointed at this machine,
 * and it exists so an invite can be a link instead of a code.
 *
 * Nobody should have to know that difference to fill these in, so neither field asks. A coordinator
 * answers `/healthz` with `mode`; a node answers with `children`; neither field appears on the
 * other. One request therefore says which kind of thing was typed, and a field either takes it or
 * says, in a sentence, that it belongs in the other box.
 *
 * The check is also what makes a free-text address safe to offer at all. A typo in a hostname does
 * not fail loudly — it fails weeks later, as joins that quietly fall back — so the address is asked
 * what it is before anything stores it.
 */

// The rules live in `utils/mesh/sharingAddress.ts`, outside React, where `bun:test` can reach
// them — a field that says one thing while the node stores another is the failure this rework
// exists to remove, and no screenshot catches it. Re-exported so nothing importing this component
// has to know where they moved.
export {
  DEFAULT_SHARING_SERVER,
  type SharingAddressAccept,
  type SharingAddressValue,
  sharingAddress,
  sharingAddressReady,
  sharingAddressUrl,
} from "@/utils/mesh/sharingAddress";

/** A hostname is typed a character at a time and each check is a network round trip. */
const CHECK_DELAY_MS = 600;

export function SharingAddress({
  value,
  onChange,
  accept,
  disabled,
  placeholder,
  blankHint,
  stored,
  testID,
}: {
  value: SharingAddressValue;
  onChange: (next: SharingAddressValue) => void;
  accept: SharingAddressAccept;
  disabled?: boolean;
  placeholder: string;
  /** What an empty field means here — different for each of the two. */
  blankHint: string;
  /**
   * What the node already has. A field still showing it is not checked.
   *
   * The check exists to catch a **typo**, and a value that came back from the node is not something
   * anybody just typed. Probing it on mount bought nothing and cost plenty: a cross-origin request
   * to the sharing server every time the section opened, which fails outright against a coordinator
   * that has not been redeployed with a CORS header — logging a red error on the Sharing screen for
   * a setting that is working perfectly well. Same reasoning as `isUntouched` for saving.
   */
  stored?: string | null;
  testID?: string;
}) {
  const { t } = useTranslation();
  const abort = useRef<AbortController | null>(null);
  const input = value.input;
  const isStored = input.trim() === (stored ?? "").trim();

  useEffect(() => {
    if (isStored) {
      abort.current?.abort();
      onChange({ input, check: { state: "idle" } });
      return;
    }
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
  }, [input, isStored]);

  const setInput = useCallback(
    (next: string) => onChange({ input: next, check: { state: "checking" } }),
    [onChange],
  );

  return (
    <View>
      <Input
        placeholder={placeholder}
        autoCapitalize='none'
        autoCorrect={false}
        keyboardType={Platform.OS === "web" ? "default" : "url"}
        value={input}
        editable={!disabled}
        onChangeText={setInput}
        testID={testID}
      />
      <View style={{ marginTop: space[2] }}>
        {isBlank(value) && isStored ? (
          <Text variant='caption' tone='secondary'>
            {blankHint}
          </Text>
        ) : isStored ? (
          <Text variant='caption' tone='secondary'>
            {t("sharing.address_in_use")}
          </Text>
        ) : isBlank(value) ? (
          <Text variant='caption' tone='secondary'>
            {blankHint}
          </Text>
        ) : (
          <Status
            check={value.check}
            accept={accept}
            shipped={isShippedDefault(value)}
          />
        )}
      </View>
    </View>
  );
}

/** One line under the field, saying what the address turned out to be. */
function Status({
  check,
  accept,
  shipped,
}: {
  check: CoordinatorCheck;
  accept: SharingAddressAccept;
  shipped: boolean;
}) {
  const { t } = useTranslation();

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

    // A coordinator: right for one field, and a specific and fixable mistake in the other. Saying
    // which box it belongs in is worth more than calling it invalid.
    case "ok":
      return accept === "coordinator" ? (
        // The pill says *what it is* and nothing else. What it offers — mode, version, relay,
        // rendezvous — goes underneath as text that wraps: it was inside the pill, and a pill does
        // not wrap, so at 390px the sentence ran straight off the side of the screen.
        <Detail detail={describeCoordinator(check.health)}>
          <Pill
            tone='success'
            icon='check'
            label={t("sharing.address_shared_ok")}
          />
        </Detail>
      ) : (
        <Pill
          tone='warning'
          icon='warning'
          label={t("sharing.address_is_a_sharing_server")}
        />
      );

    case "own-server":
      return accept === "own-server" ? (
        <Detail
          detail={check.name ?? normalizeCoordinatorUrl(check.url) ?? check.url}
        >
          <Pill
            tone='success'
            icon='check'
            label={t("sharing.address_own_ok")}
          />
        </Detail>
      ) : (
        <Pill
          tone='warning'
          icon='warning'
          label={t("sharing.address_is_your_own_server")}
        />
      );

    default:
      // The shipped address failing its check is not the user's mistake and does not stop them: it
      // is a coordinator having a moment, or an older one with no CORS header on /healthz. Saying
      // so plainly beats a red warning about something they did not do.
      return shipped ? (
        <Text variant='caption' tone='secondary'>
          {t("sharing.address_default_unverified")}
        </Text>
      ) : (
        <Pill tone='danger' icon='warning' label={check.message} />
      );
  }
}

/** A short pill, and the long part underneath where it is allowed to wrap. */
const Detail = ({
  detail,
  children,
}: React.PropsWithChildren<{ detail: string }>) => (
  <View style={{ gap: 4, alignItems: "flex-start" }}>
    {children}
    <Text variant='caption' tone='tertiary'>
      {detail}
    </Text>
  </View>
);
