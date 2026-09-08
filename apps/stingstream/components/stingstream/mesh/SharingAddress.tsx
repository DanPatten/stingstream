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

/** What a field will take. */
export type SharingAddressAccept = "coordinator" | "own-server";

/** Prefilled into the sharing-server field, so the common case is "leave it alone". */
export const DEFAULT_SHARING_SERVER =
  "https://stingstream-coordinator-production.up.railway.app";

export type SharingAddressValue = {
  /** Exactly what is in the field, so the parent can round-trip it. */
  input: string;
  /** What the probe made of it; idle until it has answered. */
  check: CoordinatorCheck;
};

export const sharingAddress = (input = ""): SharingAddressValue => ({
  input,
  check: { state: "idle" },
});

const isBlank = (value: SharingAddressValue) => value.input.trim().length === 0;

/** The address we ship, untouched. Not a guess a typo could be hiding in. */
const isShippedDefault = (value: SharingAddressValue) =>
  value.input.trim() === DEFAULT_SHARING_SERVER;

/**
 * Whether this field's value can be saved.
 *
 * Blank is always fine — clearing an address is an ordinary thing to do, and for the sharing server
 * it is how somebody says they want no server at all.
 *
 * The **shipped address counts as ready even when its check has not succeeded.** It is ours rather
 * than something typed, so there is no typo for the check to catch, and a coordinator having a
 * moment — or a browser that discarded the answer for want of a CORS header, which every
 * coordinator built before this session's fix does — must not be able to stop somebody saving a
 * setting. An address that was *typed* and answered wrong still blocks, which is the case the check
 * exists for.
 */
export const sharingAddressReady = (
  value: SharingAddressValue,
  accept: SharingAddressAccept,
): boolean => {
  if (isBlank(value)) return true;
  if (accept === "coordinator") {
    return value.check.state === "ok" || isShippedDefault(value);
  }
  return value.check.state === "own-server";
};

/** The URL to store, or `null` when there is nothing usable in the field. */
export const sharingAddressUrl = (
  value: SharingAddressValue,
  accept: SharingAddressAccept,
): string | null => {
  if (isBlank(value)) return null;
  if (accept === "coordinator") {
    if (value.check.state === "ok") return value.check.url;
    // The shipped address still counts when the check could not complete — see above. Without
    // this the field would show an address while the setting was quietly saved empty.
    if (isShippedDefault(value) && value.check.state !== "own-server") {
      return DEFAULT_SHARING_SERVER;
    }
    return null;
  }
  return value.check.state === "own-server" ? value.check.url : null;
};

/** A hostname is typed a character at a time and each check is a network round trip. */
const CHECK_DELAY_MS = 600;

export function SharingAddress({
  value,
  onChange,
  accept,
  disabled,
  placeholder,
  blankHint,
  testID,
}: {
  value: SharingAddressValue;
  onChange: (next: SharingAddressValue) => void;
  accept: SharingAddressAccept;
  disabled?: boolean;
  placeholder: string;
  /** What an empty field means here — different for each of the two. */
  blankHint: string;
  testID?: string;
}) {
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
        {isBlank(value) ? (
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
        <Pill
          tone='success'
          icon='check'
          label={t("sharing.address_shared_ok", {
            health: describeCoordinator(check.health),
          })}
        />
      ) : (
        <Pill
          tone='warning'
          icon='warning'
          label={t("sharing.address_is_a_sharing_server")}
        />
      );

    case "own-server":
      return accept === "own-server" ? (
        <Pill
          tone='success'
          icon='check'
          label={t("sharing.address_own_ok", {
            name: check.name ?? normalizeCoordinatorUrl(check.url) ?? check.url,
          })}
        />
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
