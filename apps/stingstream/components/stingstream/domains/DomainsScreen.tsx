import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { FocusTarget } from "@/components/settings/FocusTarget";
import { space, tokens } from "@/constants/theme";
import { useDeleteMeshTunnel, useMeshDomains } from "@/lib/stingstream/mesh";
import { hasTunnel } from "@/utils/mesh/domainsStatus";
import { confirmDestructive } from "../shared/confirm";
import { DomainAddress } from "./DomainAddress";
import { DomainsStatus } from "./DomainsStatus";
import { PortForwardHelp } from "./PortForwardHelp";
import { TunnelDialog } from "./TunnelDialog";

/**
 * Where people reach this server — one question, so one card.
 *
 * ## What this looked like first, and why it was wrong
 *
 * Three blocks: a status, then "Your server's address", then "Setting it up". Dan, on sight:
 * *"Its confusing to have your server address + setting it up sections - unify that so its the
 * same thing"*. He was right, and the reason is worth writing down — those two blocks asked the
 * *same* question twice and then disagreed about who answered it. Setting up a tunnel produces an
 * address; the address field above it was the place to type one in; and nothing on screen said
 * whether doing one meant you should also do the other. So there is one card now: what the address
 * is, and the two ways to end up with a working one.
 *
 * The Cloudflare path writes the address itself, on the node, at the moment the tunnel is
 * requested (`post_tunnel`) — which is what makes this genuinely one setting rather than two that
 * have to be kept in step by hand.
 *
 * ## The two ways, and there are only two
 *
 * A third briefly existed: Cloudflare's account-free tunnel, on a `*.trycloudflare.com` name that
 * changes every restart. Dan cut it — *"they either configure a domain manually OR via
 * cloudflare"* — and it is gone from the node too, not merely hidden. An address that cannot be
 * sent to anybody is not an answer to the question this page asks.
 */
export function DomainsScreen() {
  const { t } = useTranslation();
  const domains = useMeshDomains();
  const stop = useDeleteMeshTunnel();
  const [setUpOpen, setSetUpOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);

  const running = hasTunnel(domains.data);
  // Deliberately no check on whether `cloudflared` is installed. It used to hide the setup button
  // and show "cloudflared is not installed on it" instead, which was wrong twice: an installed
  // node has no `third_party/` to look in, so the message pointed at a path that did not exist for
  // the reader most likely to see it -- and the answer to "there is no binary" is to go and get
  // one, which is what `sidedoor::cloudflared::ensure` now does on the first press. Dan: *"I want
  // a one click cloudflare setup"*.

  const disconnect = async () => {
    const confirmed = await confirmDestructive(
      t("domains.tunnel_disconnect_title"),
      t("domains.tunnel_disconnect_message"),
      t("domains.tunnel_disconnect"),
    );
    if (!confirmed) return;
    try {
      await stop.mutateAsync();
      toast.success(t("domains.tunnel_disconnected"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <View style={{ gap: space["6"] }}>
      <FocusTarget
        id={["public-domain", "cloudflare-tunnel", "domains-status"]}
      >
        <ListGroup title={t("domains.status_title")}>
          {/* What is true right now, first: a domain that resolves nowhere and a certificate that
              expired last week both used to look exactly like success from in here. */}
          <DomainsStatus status={domains.data} />

          <Divider />

          {/* The address itself. Kept editable even while a tunnel is running: somebody moving
              from a tunnel to their own reverse proxy edits this, and the tunnel is what they
              disconnect afterwards. */}
          <View style={{ padding: 16 }}>
            <DomainAddress />
          </View>

          <Divider />

          <View style={{ padding: 16, gap: space["3"] }}>
            {running ? (
              <>
                <Text variant='caption' tone='secondary'>
                  {t("domains.tunnel_running")}
                </Text>
                <Button
                  variant='ghost'
                  icon='close'
                  onPress={disconnect}
                  loading={stop.isPending}
                  testID='domains-tunnel-disconnect'
                  style={{ alignSelf: "flex-start" }}
                >
                  {t("domains.tunnel_disconnect")}
                </Button>
              </>
            ) : (
              <>
                <Text variant='caption' tone='tertiary'>
                  {t("domains.setup_detail")}
                </Text>
                <Button
                  icon='domains'
                  onPress={() => setSetUpOpen(true)}
                  testID='domains-tunnel-setup'
                  style={{ alignSelf: "flex-start" }}
                >
                  {t("domains.setup_action")}
                </Button>
              </>
            )}

            {/* Last and quiet: the path for somebody who has already decided. Level with the
                button above it would present two equal choices where one is a press and the other
                is an evening. */}
            <Button
              variant='ghost'
              size='sm'
              icon='info'
              onPress={() => setManualOpen(true)}
              testID='domains-manual-help'
              style={{ alignSelf: "flex-start" }}
            >
              {t("domains.manual_action")}
            </Button>
          </View>
        </ListGroup>
      </FocusTarget>

      <TunnelDialog visible={setUpOpen} onClose={() => setSetUpOpen(false)} />
      <PortForwardHelp
        visible={manualOpen}
        onClose={() => setManualOpen(false)}
        status={domains.data}
      />
    </View>
  );
}

/** The hairline `ListGroup` clones onto rows, drawn by hand between blocks that are not rows. */
const Divider = () => (
  <View
    style={{ height: 1, backgroundColor: tokens.color.border.subtle }}
    // Decoration, and a screen reader reading "horizontal rule" three times on one card is noise.
    accessibilityElementsHidden
    importantForAccessibility='no-hide-descendants'
  />
);
