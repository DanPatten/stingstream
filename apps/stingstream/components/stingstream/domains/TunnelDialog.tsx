import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { FormError } from "@/components/common/FormError";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { space } from "@/constants/theme";
import { useSetMeshTunnel } from "@/lib/stingstream/mesh";
import { bareHostname } from "@/utils/mesh/domainsStatus";

/** Where somebody makes the token this needs. The dialog names both scopes it must carry. */
const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";

/**
 * Two fields, and the node does the rest.
 *
 * This is the whole of what used to be four `cloudflared` commands in `docs/SIDEDOOR.md`: the node
 * finds the zone, creates the tunnel, points a proxied CNAME at it, stores the hostname as its own
 * address and keeps the process alive. It answers as soon as the request is recorded rather than
 * holding a request open across Cloudflare's API, so the page moves to "Starting" and polls.
 *
 * **The token is the only awkward part, and it is awkward on purpose.** It grants DNS edit on a
 * real domain, so it is masked here, sent once, used once and never stored — there is no endpoint
 * that reads it back, because there is nothing to read. The honest cost, which the copy states, is
 * that a node restarted before the tunnel exists asks for it again.
 */
export function TunnelDialog({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const start = useSetMeshTunnel();
  const [hostname, setHostname] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    // The token goes when the dialog does, successfully or not. It is single-use by design and
    // this component is the only thing that ever held it.
    setToken("");
    setError(null);
    onClose();
  };

  const submit = async () => {
    setError(null);
    const host = bareHostname(hostname);
    if (!host.includes(".")) {
      setError(t("domains.setup_hostname_invalid"));
      return;
    }
    try {
      await start.mutateAsync({
        kind: "named",
        hostname: host,
        apiToken: token.trim(),
      });
      setHostname("");
      close();
      toast.success(t("domains.tunnel_starting_toast"));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Dialog
      visible={visible}
      onClose={close}
      title={t("domains.setup_action")}
      description={t("domains.setup_dialog_intro")}
      actions={[
        {
          label: t("domains.setup_submit"),
          onPress: submit,
          loading: start.isPending,
          disabled: !hostname.trim() || !token.trim() || start.isPending,
          testID: "domains-setup-submit",
        },
      ]}
    >
      <View style={{ gap: space["4"] }}>
        <Field
          label={t("domains.setup_hostname_label")}
          hint={t("domains.setup_hostname_hint")}
        >
          <Input
            value={hostname}
            onChangeText={setHostname}
            placeholder={t("sharing.own_field_placeholder")}
            autoCapitalize='none'
            autoCorrect={false}
            editable={!start.isPending}
            testID='domains-setup-hostname'
          />
        </Field>

        <Field
          label={t("domains.setup_token_label")}
          hint={t("domains.setup_token_hint")}
        >
          <Input
            value={token}
            onChangeText={setToken}
            // Masked because this gets set up while somebody is sharing a screen, and it grants
            // DNS edit on their zone. Nothing reveals it afterwards: the node keeps it only until
            // the tunnel is created, so there is nothing left to show.
            secureTextEntry
            autoCapitalize='none'
            autoCorrect={false}
            editable={!start.isPending}
            testID='domains-setup-token'
          />
          <Button
            variant='ghost'
            size='sm'
            icon='link'
            onPress={() => Linking.openURL(TOKEN_URL)}
            style={{ alignSelf: "flex-start", marginTop: space["1"] }}
          >
            {t("domains.setup_token_link")}
          </Button>
        </Field>

        <FormError message={error} />
      </View>
    </Dialog>
  );
}

const Field = ({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) => (
  <View style={{ gap: space["1"] }}>
    <Text variant='caption' weight='medium' tone='secondary'>
      {label}
    </Text>
    <Text variant='caption' tone='tertiary' style={{ marginBottom: 4 }}>
      {hint}
    </Text>
    {children}
  </View>
);
