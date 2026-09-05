import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, TextInput, View } from "react-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
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
 * The default is genuinely nothing hosted anywhere: iroh's public relays, n0 DNS and the mainline
 * DHT, plus StingStream's shared coordinator appended to the relay map as a last resort. That is
 * enough for a group to work, so the picker's job is to make the *choice* legible rather than to
 * push anyone towards running a server.
 *
 * The check is what makes "My own server" safe to offer. A typo in a hostname does not fail
 * loudly — it fails as joins that quietly fall back weeks later — so the field asks the candidate
 * what it is, and refuses to accept a host that answers but is not a coordinator.
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
      // Only a coordinator that answered gets stored on the group; anything else leaves the
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
        title='Coordinator'
        description={
          <Text className='text-[#9899A1] text-xs'>
            A coordinator is optional. Without one a group uses public
            infrastructure — iroh's relays, n0 DNS and the BitTorrent DHT — plus
            StingStream's shared fallback. A coordinator adds rendezvous (so
            joining works when the inviter is offline), a relay on TCP 443 and
            the HTTPS side door. It is a property of the group: it travels in
            every invite code, and changing it later reaches every member.
          </Text>
        }
      >
        <ListItem
          title='Default'
          subtitle='Public infrastructure + StingStream fallback'
          onPress={disabled ? undefined : () => onChange({ kind: "default" })}
          iconAfter={<Selected on={!custom} />}
        />
        <ListItem
          title='My own server'
          subtitle='A coordinator you or a friend hosts'
          onPress={
            disabled ? undefined : () => onChange({ kind: "custom", url: "" })
          }
          iconAfter={<Selected on={custom} />}
        />
      </ListGroup>

      {custom && (
        <View className='mt-3'>
          <TextInput
            className='p-4 rounded-xl bg-neutral-900'
            style={{ color: "white" }}
            placeholder='coordinator.example.org'
            placeholderTextColor='#9CA3AF'
            autoCapitalize='none'
            autoCorrect={false}
            keyboardType={Platform.OS === "web" ? "default" : "url"}
            value={host}
            editable={!disabled}
            onChangeText={setHost}
          />
          <View className='mt-2 px-1'>
            <CheckLine check={check} host={host} />
          </View>
        </View>
      )}

      <ListItem
        className='mt-3 rounded-xl overflow-hidden'
        title='Host your own'
        subtitle='One-click Railway template, or a VPS compose file'
        textColor='blue'
        showArrow
        onPress={openGuide}
      />
    </View>
  );
}

function Selected({ on }: { on: boolean }) {
  return (
    <Text className={on ? "text-purple-400" : "text-neutral-700"}>
      {on ? "●" : "○"}
    </Text>
  );
}

function CheckLine({ check, host }: { check: CoordinatorCheck; host: string }) {
  if (!host.trim()) {
    return (
      <Text className='text-[#9899A1] text-xs'>
        Enter the hostname of a running coordinator. It is checked against its
        own /healthz before it can be stored on the group.
      </Text>
    );
  }
  switch (check.state) {
    case "checking":
      return (
        <View className='flex flex-row items-center'>
          <ActivityIndicator size='small' color='#9899A1' />
          <Text className='text-[#9899A1] text-xs ml-2'>
            Checking {normalizeCoordinatorUrl(host) ?? host}…
          </Text>
        </View>
      );
    case "ok":
      return (
        <Text className='text-green-500 text-xs'>
          {check.url} — {describeCoordinator(check.health)}
        </Text>
      );
    case "invalid":
    case "unreachable":
    case "not-a-coordinator":
      return <Text className='text-red-500 text-xs'>{check.message}</Text>;
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
