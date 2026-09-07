import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Platform, View } from "react-native";
import { Input } from "@/components/common/Input";
import { Pill } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { tokens } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import {
  COORDINATOR_GUIDE_URL,
  type CoordinatorCheck,
  checkCoordinator,
  describeCoordinator,
  normalizeCoordinatorUrl,
} from "@/utils/mesh/coordinator";

/**
 * "Default" or "My own server", with the hostname checked live.
 *
 * User-facing text calls this a **rendezvous server** (the wording decision for v0.2.0's rebrand:
 * "Coordinator" only ever meant something to someone who already knew the mesh's internals). The
 * field, the API and every internal identifier still say `coordinator` — this component's own name
 * included — since that is the wire format every node on every version understands; only the label
 * a person reads changed.
 *
 * The default is genuinely nothing hosted anywhere: iroh's public relays, n0 DNS and the mainline
 * DHT, plus StingStream's shared fallback appended to the relay map as a last resort. That is
 * enough for a group to work, so the picker's job is to make the *choice* legible rather than to
 * push anyone towards running a server.
 *
 * The check is what makes "My own server" safe to offer. A typo in a hostname does not fail
 * loudly — it fails as joins that quietly fall back weeks later — so the field asks the candidate
 * what it is, and refuses to accept a host that answers but is not a rendezvous server.
 */

export type CoordinatorChoice =
  | { kind: "default" }
  | { kind: "custom"; url: string };

interface Props {
  value: CoordinatorChoice;
  onChange: (choice: CoordinatorChoice) => void;
  /** Set while the group is being created, to stop the fields moving underneath the user. */
  disabled?: boolean;
}

/** Debounce: a hostname is typed a character at a time and each check is a network round trip. */
const CHECK_DELAY_MS = 600;

export function CoordinatorPicker({ value, onChange, disabled }: Props) {
  const { t } = useTranslation();
  const [host, setHost] = useState(value.kind === "custom" ? value.url : "");
  const [check, setCheck] = useState<CoordinatorCheck>({ state: "idle" });
  const abort = useRef<AbortController | null>(null);

  const custom = value.kind === "custom";

  useEffect(() => {
    if (!custom || !host.trim()) {
      setCheck({ state: "idle" });
      return;
    }
    setCheck({ state: "checking" });
    const controller = new AbortController();
    abort.current?.abort();
    abort.current = controller;
    const timer = setTimeout(async () => {
      const result = await checkCoordinator(host, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setCheck(result);
      // Only a rendezvous server that answered gets stored on the group; anything else leaves the
      // choice incomplete, and the Create button stays disabled.
      onChange(
        result.state === "ok"
          ? { kind: "custom", url: result.url }
          : { kind: "custom", url: "" },
      );
    }, CHECK_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `onChange` is intentionally not a dependency: callers pass an inline closure and re-running
    // the check on every render of the parent would make the field unusable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [custom, host]);

  const openGuide = useCallback(() => {
    void WebBrowser.openBrowserAsync(COORDINATOR_GUIDE_URL);
  }, []);

  return (
    <View>
      <ListGroup
        title={t("sharing.rendezvous_title")}
        description={
          <Text variant='caption' tone='secondary'>
            {t("sharing.rendezvous_description")}
          </Text>
        }
      >
        <ListItem
          title={t("sharing.rendezvous_default_title")}
          subtitle={t("sharing.rendezvous_default_subtitle")}
          onPress={disabled ? undefined : () => onChange({ kind: "default" })}
          iconAfter={<Selected on={!custom} />}
        />
        <ListItem
          title={t("sharing.rendezvous_custom_title")}
          subtitle={t("sharing.rendezvous_custom_subtitle")}
          onPress={
            disabled ? undefined : () => onChange({ kind: "custom", url: "" })
          }
          iconAfter={<Selected on={custom} />}
        />
      </ListGroup>

      {custom && (
        <View style={{ marginTop: 12 }}>
          <Input
            placeholder={t("sharing.rendezvous_placeholder")}
            autoCapitalize='none'
            autoCorrect={false}
            keyboardType={Platform.OS === "web" ? "default" : "url"}
            value={host}
            editable={!disabled}
            onChangeText={setHost}
          />
          <View style={{ marginTop: 8, paddingHorizontal: 2 }}>
            <CheckLine check={check} host={host} />
          </View>
        </View>
      )}

      <ListItem
        style={{ marginTop: 12, borderRadius: 12, overflow: "hidden" }}
        title={t("sharing.rendezvous_host_your_own_title")}
        subtitle={t("sharing.rendezvous_host_your_own_subtitle")}
        textColor='blue'
        showArrow
        onPress={openGuide}
      />
    </View>
  );
}

function Selected({ on }: { on: boolean }) {
  const { accent } = useTheme();
  return (
    <Text style={{ color: on ? accent[400] : tokens.color.text.tertiary }}>
      {on ? "●" : "○"}
    </Text>
  );
}

function CheckLine({ check, host }: { check: CoordinatorCheck; host: string }) {
  const { t } = useTranslation();

  if (!host.trim()) {
    return (
      <Text variant='caption' tone='secondary'>
        {t("sharing.rendezvous_check_hint")}
      </Text>
    );
  }
  switch (check.state) {
    case "checking":
      return (
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <ActivityIndicator size='small' color={tokens.color.text.secondary} />
          <Text variant='caption' tone='secondary' style={{ marginLeft: 8 }}>
            {t("sharing.rendezvous_checking", {
              host: normalizeCoordinatorUrl(host) ?? host,
            })}
          </Text>
        </View>
      );
    case "ok":
      return (
        <Pill
          tone='success'
          icon='check'
          label={t("sharing.rendezvous_ok", {
            url: check.url,
            health: describeCoordinator(check.health),
          })}
        />
      );
    case "invalid":
    case "unreachable":
    case "not-a-coordinator":
      return <Pill tone='danger' icon='warning' label={check.message} />;
    default:
      return null;
  }
}

/** Whether the picker's current value is complete enough to create a group with. */
export const coordinatorChoiceReady = (choice: CoordinatorChoice): boolean =>
  choice.kind === "default" || choice.url.length > 0;

/** What to send as the `coordinator` field. */
export const coordinatorChoiceValue = (
  choice: CoordinatorChoice,
): string | null => (choice.kind === "custom" ? choice.url : null);
