import { getNodeBaseUrl } from "@stingstream/api-client";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { FocusTarget } from "@/components/settings/FocusTarget";
import { DECLINED_DETECTED_DOMAIN_KEY } from "@/constants/Networking";
import { space } from "@/constants/theme";
import {
  useDeleteMeshTunnel,
  useMeshDomains,
  useSetMeshSharingSettings,
} from "@/lib/stingstream/mesh";
import { apiAtom } from "@/providers/JellyfinProvider";
import {
  bareHostname,
  detectedDomain,
  domainsMethod,
} from "@/utils/mesh/domainsStatus";
import { storage } from "@/utils/mmkv";
import { confirmAction, confirmDestructive } from "../shared/confirm";
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
 * What is here now is a fact and a choice, in that order:
 *
 * - **The address**, which every server has: a LAN one until a domain is set, that domain after.
 *   Read-only, because it is the outcome of a route rather than a setting of its own.
 * - **The two routes.** Cloudflare, which is a press and a token; or your own domain, which is a
 *   router, DNS and a certificate, or a proxy that already does all three. Each opens a dialog that
 *   carries the whole of its route including naming the server.
 *
 * ## One in use, the other a switch
 *
 * With nothing set up, both rows are setups. Once one route is in use it is marked so, and the
 * other row becomes a switch to it — Dan: *"If a domain was already setup then reflect that with a
 * way to switch between the two methods"*. The switches do the coordinating a person would
 * otherwise do by hand: moving to Cloudflare prefills the hostname already in use, and moving to
 * your own domain stops the tunnel once the new address is saved.
 *
 * ## An address the node never heard of
 *
 * A domain can already work without the node knowing it: a tunnel or proxy the owner runs
 * themselves, which the app is connected through right now. The page used to show the LAN address
 * over that. It now asks, once, whether to save the domain it can see (`detectedDomain`), and
 * remembers a no for that address so it does not ask on every visit. Asked rather than saved,
 * because the stored address is what invite links are built from.
 *
 * A third route briefly existed, Cloudflare's account-free tunnel on a name that changes every
 * restart. Dan cut it, and it is gone from the node too.
 */
export function DomainsScreen() {
  const { t } = useTranslation();
  const domains = useMeshDomains();
  const stop = useDeleteMeshTunnel();
  const saveAddress = useSetMeshSharingSettings();
  const api = useAtomValue(apiAtom);
  const [setUpOpen, setSetUpOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);

  const status = domains.data;
  const method = domainsMethod(status);
  // No check on whether `cloudflared` is installed: `sidedoor::cloudflared::ensure` fetches one on
  // the first press. Dan: *"I want a one click cloudflare setup"*.

  // The node's address, not the media server's path inside it, which would put an upstream
  // product's name on screen and is not what anybody pointed a domain at.
  const connected = api?.basePath ? getNodeBaseUrl(api.basePath) : null;
  const detected = detectedDomain(status, connected);

  // Once per page visit: a refetch after a declined prompt must not ask again, and a save that
  // lands makes `detected` null on its own.
  const asked = useRef(false);
  useEffect(() => {
    if (!detected || asked.current) return;
    if (storage.getString(DECLINED_DETECTED_DOMAIN_KEY) === detected) return;
    asked.current = true;
    void (async () => {
      const host = bareHostname(detected);
      const yes = await confirmAction(
        t("domains.detected_title", { host }),
        t("domains.detected_message"),
        t("domains.detected_confirm"),
      );
      if (!yes) {
        storage.set(DECLINED_DETECTED_DOMAIN_KEY, detected);
        return;
      }
      try {
        await saveAddress.mutateAsync({ publicAddress: detected });
        toast.success(t("sharing.own_saved"));
      } catch (e) {
        toast.error((e as Error).message);
      }
    })();
  }, [detected, saveAddress, t]);

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

  const inUse = t("domains.in_use");

  return (
    <View style={{ gap: space["6"] }}>
      <FocusTarget id={["public-domain", "domains-status"]}>
        <ListGroup title={t("domains.status_title")}>
          {/* Wrapped so the group can draw its hairline onto it: the rule is cloned onto the
              child's style, and `DomainsStatus` takes no style of its own. */}
          <View>
            <DomainsStatus status={status} />
          </View>
        </ListGroup>
      </FocusTarget>

      <FocusTarget id={["cloudflare-tunnel"]}>
        <ListGroup
          title={
            method === "none"
              ? t("domains.choose_title")
              : t("domains.method_title_active")
          }
        >
          {method === "cloudflare" ? (
            <ListItem
              icon='domains'
              title={t("domains.tunnel_row_title")}
              subtitle={inUse}
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

          {method === "own" ? (
            <ListItem
              icon='network'
              title={t("domains.own_row_title")}
              subtitle={inUse}
              showArrow
              onPress={() => setManualOpen(true)}
              testID='domains-own-in-use'
            />
          ) : null}

          {/* The route not in use, level with the one that is. Setups while nothing is set up,
              switches once something is. */}
          {method !== "cloudflare" ? (
            <ListItem
              icon='domains'
              title={
                method === "own"
                  ? t("domains.switch_to_cloudflare")
                  : t("domains.setup_action")
              }
              subtitle={t("domains.setup_detail")}
              showArrow
              onPress={() => setSetUpOpen(true)}
              testID='domains-tunnel-setup'
            />
          ) : null}

          {method !== "own" ? (
            <ListItem
              icon='network'
              title={
                method === "cloudflare"
                  ? t("domains.switch_to_own")
                  : t("domains.manual_action")
              }
              subtitle={t("domains.manual_detail")}
              showArrow
              onPress={() => setManualOpen(true)}
              testID='domains-manual-help'
            />
          ) : null}
        </ListGroup>
      </FocusTarget>

      <TunnelDialog
        visible={setUpOpen}
        onClose={() => setSetUpOpen(false)}
        initialHostname={
          status?.publicAddress ? bareHostname(status.publicAddress) : ""
        }
      />
      <ManualDomainDialog
        visible={manualOpen}
        onClose={() => setManualOpen(false)}
        status={status}
        tunnelRunning={method === "cloudflare"}
      />
    </View>
  );
}
