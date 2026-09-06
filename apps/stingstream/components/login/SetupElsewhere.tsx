import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Button } from "@/components/Button";
import { FormError } from "@/components/common/FormError";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { radius, tokens } from "@/constants/theme";

/** Where a node's gateway listens unless somebody moved it. */
const DEFAULT_GATEWAY_PORT = "8790";

/**
 * The address to open on the node's own machine, derived from the one this page came from.
 *
 * The port matters and the host does not: whoever is reading this is on a different computer, so
 * `localhost` is the only host that means anything to them, while a node on a non-default port
 * would otherwise be sent to an address that answers nothing.
 */
export function setupAddressFor(origin: string | null | undefined): string {
  const port = (() => {
    if (!origin) return DEFAULT_GATEWAY_PORT;
    // `URL` is available on every platform this ships to (Hermes and every browser), but a
    // malformed origin must not take the screen down with it.
    try {
      return new URL(origin).port || DEFAULT_GATEWAY_PORT;
    } catch {
      return DEFAULT_GATEWAY_PORT;
    }
  })();
  return `http://localhost:${port}`;
}

export interface SetupElsewhereProps {
  /** The origin this page was served from; only its port is used. */
  origin: string | null;
  /** Re-query `setup/state`. */
  onRetry: () => void;
  retrying?: boolean;
  /** Set when the last check came back and the node still has no account. */
  message?: string | null;
}

/**
 * What a fresh node shows to a browser that is *not* on the node's own machine.
 *
 * The account can only be created over loopback (the gateway refuses `setup/admin` from anywhere
 * else, with a 404 rather than a 403 so a remote visitor cannot even learn the route exists). This
 * screen is the honest version of that refusal: not "forbidden", but where to go instead.
 */
export const SetupElsewhere: React.FC<SetupElsewhereProps> = ({
  origin,
  onRetry,
  retrying = false,
  message,
}) => {
  const { t } = useTranslation();
  const address = setupAddressFor(origin);

  return (
    <View testID='setup-elsewhere'>
      <Icon name='devices' size={28} tone='accent' />
      <Text variant='heading' weight='bold' style={{ marginTop: 12 }}>
        {t("setup.elsewhere_title")}
      </Text>
      <Text variant='body' tone='secondary' style={{ marginTop: 8 }}>
        {t("setup.elsewhere_description")}
      </Text>

      <View
        style={{
          marginTop: 20,
          paddingVertical: 14,
          paddingHorizontal: 16,
          borderRadius: radius.md,
          backgroundColor: tokens.color.bg["2"],
          borderWidth: 1,
          borderColor: tokens.color.border.subtle,
        }}
      >
        {/* Selectable: on a laptop next to the machine, copying it is the fastest way there. */}
        <Text variant='body' tone='accent' weight='medium' selectable>
          {address}
        </Text>
      </View>

      <FormError message={message} style={{ marginTop: 12 }} />

      <Button
        variant='secondary'
        size='lg'
        icon='refresh'
        onPress={onRetry}
        loading={retrying}
        disabled={retrying}
        style={{ marginTop: 20 }}
      >
        {t("setup.elsewhere_retry")}
      </Button>
    </View>
  );
};
