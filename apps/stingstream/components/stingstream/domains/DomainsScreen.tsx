import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { FocusTarget } from "@/components/settings/FocusTarget";
import { space } from "@/constants/theme";
import { useDeleteMeshTunnel, useMeshDomains } from "@/lib/stingstream/mesh";
import { hasTunnel } from "@/utils/mesh/domainsStatus";
import { confirmDestructive } from "../shared/confirm";
import { DomainsStatus } from "./DomainsStatus";
import { ManualDomainDialog } from "./ManualDomainDialog";
import { TunnelDialog } from "./TunnelDialog";

/**
 * Where people reach this server: what the address is now, and the two ways to change it.
 *
 * ## The shape, and why it is two cards
 *
 * One card came first, holding a status, an address field and two buttons. Dan: *"the top should
 * show the current domain (LAN or if set). Then the user can EITHER setup cloudflare OR manually
 * set their domain ... setting the name should be part of the cloudflare flow. Right now its
 * unclear and too much is meshed together"*.
 *
 * That names the actual fault. The field was the shared half of two routes that exclude each other,
 * so the card asked somebody to fill it in *and* offered two buttons that would each fill it in for
 * them, with nothing saying whether doing one meant they should also do the other. What is here now
 * is a fact and a choice, in that order:
 *
 * - **The address**, which every server has: a LAN one until a domain is set, that domain after.
 *   Read-only, because it is the outcome of a route rather than a setting of its own.
 * - **Two rows, one each for the two routes.** Cloudflare, which is a press and a token; or your
 *   own domain, which is a router, DNS and a certificate. Each opens a dialog that carries the
 *   whole of its route including naming the server, so neither leaves anything on the page to
 *   coordinate by hand.
 *
 * ## The two ways, and there are only two
 *
 * A third briefly existed: Cloudflare's account-free tunnel, on a `*.trycloudflare.com` name that
 * changes every restart. Dan cut it — *"they either configure a domain manually OR via
 * cloudflare"* — and it is gone from the node too, not merely hidden. An address that cannot be
 * sent to anybody is not an answer to the question this page asks.
 *
 * With a tunnel up, the Cloudflare row is replaced by the tunnel itself and its Disconnect. The
 * manual row stays: moving from a tunnel to your own reverse proxy means setting the address there
 * first, and disconnecting afterwards.
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
      <FocusTarget id={["public-domain", "domains-status"]}>
        <ListGroup title={t("domains.status_title")}>
          {/* What is true right now, first: a domain that resolves nowhere and a certificate that
              expired last week both used to look exactly like success from in here. Wrapped so the
              group can draw its hairline onto it -- the rule is cloned onto the child's style, and
              `DomainsStatus` takes no style of its own. */}
          <View>
            <DomainsStatus status={domains.data} />
          </View>

          {running ? (
            <ListItem
              icon='domains'
              title={t("domains.tunnel_row_title")}
              subtitle={t("domains.tunnel_running")}
            >
              <Button
                variant='ghost'
                size='sm'
                onPress={disconnect}
                loading={stop.isPending}
                testID='domains-tunnel-disconnect'
              >
                {t("domains.tunnel_disconnect")}
              </Button>
            </ListItem>
          ) : null}
        </ListGroup>
      </FocusTarget>

      <FocusTarget id={["cloudflare-tunnel"]}>
        <ListGroup title={t("domains.choose_title")}>
          {/* Cloudflare first, and only while there is no tunnel: with one up, the row above is
              this route's state and setting a second tunnel over the top of it is not a thing
              anybody means to do from here. */}
          {running ? null : (
            <ListItem
              icon='domains'
              title={t("domains.setup_action")}
              subtitle={t("domains.setup_detail")}
              showArrow
              onPress={() => setSetUpOpen(true)}
              testID='domains-tunnel-setup'
            />
          )}

          {/* The other route, level with it rather than tucked underneath. They are not equally
              easy, which the subtitles say; they are equally real, which the layout should. */}
          <ListItem
            icon='network'
            title={t("domains.manual_action")}
            subtitle={t("domains.manual_detail")}
            showArrow
            onPress={() => setManualOpen(true)}
            testID='domains-manual-help'
          />
        </ListGroup>
      </FocusTarget>

      <TunnelDialog visible={setUpOpen} onClose={() => setSetUpOpen(false)} />
      <ManualDomainDialog
        visible={manualOpen}
        onClose={() => setManualOpen(false)}
        status={domains.data}
      />
    </View>
  );
}
