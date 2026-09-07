import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Button } from "@/components/Button";
import { FormError } from "@/components/common/FormError";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { radius, tokens } from "@/constants/theme";

export interface SetupElsewhereProps {
  /**
   * The node's own LAN address(es) (e.g. `["http://192.168.0.16:8790"]`), from the marker's
   * `addresses` array — `NodeContext.addresses`. Empty until WP-GATE ships that field; the copy
   * still reads fine with nothing to list, it just names no address. Never `localhost`: whoever
   * is reading this is not on the node's own machine, so that host means nothing to them
   * (2026-09-07 decision: "localhost only works on the same PC — by IP is better").
   */
  addresses: string[];
  /** Re-query `setup/state`. */
  onRetry: () => void;
  retrying?: boolean;
  /** Set when the last check came back and the node still has no account. */
  message?: string | null;
}

/**
 * What a fresh node shows to a browser that is not loopback and not on the node's own private
 * network — see `NodeContext.trustedPeer`.
 *
 * The account can only be created by a trusted peer (the gateway refuses `setup/admin` from
 * anywhere else, with a 404 rather than a 403 so an outside visitor cannot even learn the route
 * exists). This screen is the honest version of that refusal: not "forbidden", but where to go
 * instead — a device already on the same home network as the node.
 */
export const SetupElsewhere: React.FC<SetupElsewhereProps> = ({
  addresses,
  onRetry,
  retrying = false,
  message,
}) => {
  const { t } = useTranslation();

  return (
    <View testID='setup-elsewhere'>
      <Icon name='devices' size={28} tone='accent' />
      <Text variant='heading' weight='bold' style={{ marginTop: 12 }}>
        {t("setup.elsewhere_title")}
      </Text>
      <Text variant='body' tone='secondary' style={{ marginTop: 8 }}>
        {t(
          addresses.length > 0
            ? "setup.elsewhere_description"
            : "setup.elsewhere_description_no_addresses",
        )}
      </Text>

      {addresses.length > 0 ? (
        <View style={{ marginTop: 20, gap: 8 }}>
          {addresses.map((address) => (
            <View
              key={address}
              style={{
                paddingVertical: 14,
                paddingHorizontal: 16,
                borderRadius: radius.md,
                backgroundColor: tokens.color.bg["2"],
                borderWidth: 1,
                borderColor: tokens.color.border.subtle,
              }}
            >
              {/* Selectable: on a laptop already on the network, copying it is the fastest way
                  there. */}
              <Text variant='body' tone='accent' weight='medium' selectable>
                {address}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

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
