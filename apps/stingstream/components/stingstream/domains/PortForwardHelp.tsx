import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Dialog } from "@/components/common/Dialog";
import { Text } from "@/components/common/Text";
import { NODE_GATEWAY_PORT } from "@/constants/Networking";
import { space, tokens } from "@/constants/theme";
import type { MeshDomainsStatus } from "@/lib/stingstream/meshApi";
import { useHealthz } from "@/lib/stingstream/status";

/**
 * Four numbered steps, in the order they have to happen.
 *
 * Instructions rather than a button, because none of it is ours to press: it happens in a router
 * administration page we cannot reach and in an ACME client we do not ship.
 *
 * Three things it is careful about, each because leaving it out sends somebody down an evening
 * that cannot work:
 *
 * 1. **The address reservation is step one**, not a footnote. Forwarding a port to an address the
 *    router hands to a different machine after a reboot is the most common way this quietly stops
 *    working weeks later.
 * 2. **Carrier-grade NAT is named inside step two**, with the actual ranges, because that is where
 *    somebody is looking at the moment they could find out — and if they are behind it, none of
 *    the remaining steps can help them.
 * 3. **The certificate is a step, not an aside.** A forwarded port gets a browser here and gets it
 *    a certificate warning, and this app needs a secure context to sign anybody in: outside one
 *    `crypto.randomUUID` and secure storage are simply absent. Every earlier version of this
 *    advice stopped at the port, which is why people arrived believing that was enough.
 *
 * The reverse-proxy line is last and deliberately short: it is the one case where all four are
 * already done by something else, so it is an escape hatch rather than a fifth step.
 */
export function PortForwardHelp({
  visible,
  onClose,
  status,
}: {
  visible: boolean;
  onClose: () => void;
  /** For this machine's own LAN address, so step one names a real value. */
  status: MeshDomainsStatus | undefined;
}) {
  const { t } = useTranslation();
  const healthz = useHealthz();

  // Real values wherever there are any: a step that names this machine's own address is one
  // somebody can follow without working anything out. The fallbacks are the shipped defaults, for
  // the moment before `/healthz` answers — a blank in the middle of an instruction is worse than a
  // value that is right almost always.
  const gatewayPort = healthz.data?.gateway?.port ?? NODE_GATEWAY_PORT;
  const lan =
    hostnameOf(status?.lanUrls?.[0]) ?? t("domains.manual_this_machine");
  const dataDir = healthz.data?.node?.data_dir;
  // The server's own separator, not this browser's idea of one: a Windows node reported
  // `E:\...\data/tls`, which is a path somebody has to mentally repair before they can use it.
  const tls = dataDir
    ? `${dataDir}${dataDir.includes("\\") ? "\\" : "/"}tls`
    : t("domains.manual_tls_folder");

  return (
    <Dialog
      visible={visible}
      onClose={onClose}
      title={t("domains.manual_title")}
      description={t("domains.manual_intro")}
    >
      <View style={{ gap: space["4"] }}>
        <Step
          n={1}
          title={t("domains.manual_step1_title")}
          body={t("domains.manual_step1_body", { lan })}
        />
        <Step
          n={2}
          title={t("domains.manual_step2_title")}
          body={t("domains.manual_step2_body", { port: gatewayPort })}
        />
        <Step
          n={3}
          title={t("domains.manual_step3_title")}
          body={t("domains.manual_step3_body")}
        />
        <Step
          n={4}
          title={t("domains.manual_step4_title")}
          body={t("domains.manual_step4_body", { tls })}
        />

        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: tokens.color.border.subtle,
            paddingTop: space["3"],
            gap: space["2"],
          }}
        >
          <Text variant='caption' weight='medium'>
            {t("domains.manual_done")}
          </Text>
          <Text variant='caption' tone='tertiary'>
            {t("domains.manual_proxy")}
          </Text>
        </View>
      </View>
    </Dialog>
  );
}

/** The host out of a LAN URL, or nothing — a malformed one must not blank the whole step. */
const hostnameOf = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

const Step = ({
  n,
  title,
  body,
}: {
  n: number;
  title: string;
  body: string;
}) => (
  <View style={{ flexDirection: "row", gap: space["3"] }}>
    {/* A number, not a bullet: these are strictly in order, and a certificate without a forwarded
        port produces something nothing can reach. */}
    <Text variant='caption' weight='semibold' tone='tertiary'>
      {n}.
    </Text>
    <View style={{ flex: 1, gap: space["1"] }}>
      <Text variant='caption' weight='semibold'>
        {title}
      </Text>
      <Text variant='caption' tone='secondary' selectable>
        {body}
      </Text>
    </View>
  </View>
);
