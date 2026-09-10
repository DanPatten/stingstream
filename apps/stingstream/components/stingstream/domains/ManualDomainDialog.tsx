import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Dialog } from "@/components/common/Dialog";
import { FormError } from "@/components/common/FormError";
import { Text } from "@/components/common/Text";
import { NODE_GATEWAY_PORT } from "@/constants/Networking";
import { space } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import {
  useMeshSharingSettings,
  useSetMeshSharingSettings,
} from "@/lib/stingstream/mesh";
import type { MeshDomainsStatus } from "@/lib/stingstream/meshApi";
import { useHealthz } from "@/lib/stingstream/status";
import { isUntouched } from "@/utils/mesh/sharingAddress";
import {
  SharingAddress,
  type SharingAddressValue,
  sharingAddress,
  sharingAddressReady,
  sharingAddressUrl,
} from "./SharingAddress";

/**
 * The whole of the manual route: the domain itself, and the four things that have to be true for
 * it to work.
 *
 * ## Why the field is in here rather than on the page
 *
 * It used to be a box on the Domains card, above a button that opened these steps and beside a
 * button that set up Cloudflare. Dan: *"the user can EITHER setup cloudflare OR manually set their
 * domain ... setting the name should be part of the cloudflare flow. Right now its unclear and too
 * much is meshed together"*. The box was the shared half of two routes that exclude each other,
 * and a shared half is what makes two routes read as one long form: Cloudflare writes the address
 * itself (`post_tunnel`), so anybody taking that route was looking at an input they must not touch,
 * and anybody taking this one had the instructions in one place and the field in another.
 *
 * Each route names the server itself now. This one saves the address; `TunnelDialog` derives it
 * from the hostname it is given. The page behind them holds no input at all.
 *
 * ## What the steps are careful about
 *
 * Instructions rather than a button, because none of it is ours to press: it happens in a router
 * administration page we cannot reach and in an ACME client we do not ship.
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
export function ManualDomainDialog({
  visible,
  onClose,
  status,
}: {
  visible: boolean;
  onClose: () => void;
  /** For this machine's own LAN address, so step one names a real value. */
  status: MeshDomainsStatus | undefined;
}) {
  const { color } = useTheme();
  const { t } = useTranslation();
  const healthz = useHealthz();
  const settings = useMeshSharingSettings();
  const save = useSetMeshSharingSettings();

  const [own, setOwn] = useState<SharingAddressValue>(sharingAddress());
  const [error, setError] = useState<string | null>(null);

  const stored = settings.data?.publicAddress;

  // Seeded when the dialog opens, not once for the life of the component: `Dialog` stays mounted
  // for as long as the page does, so seeding once would leave a stale draft in the box the second
  // time somebody opened it, including after Cloudflare had written a different address underneath
  // them. Keyed on `visible` alone and not on `stored` — re-seeding whenever the query refetches
  // would overwrite what somebody is halfway through typing.
  useEffect(() => {
    if (!visible) return;
    setError(null);
    setOwn(sharingAddress(stored ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

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

  // Save lights up only for something actually typed, which is also what keeps a stored address
  // this browser cannot re-derive from being re-judged: an untouched field is never saved at all.
  const untouched = isUntouched(own, stored);
  const ready = sharingAddressReady(own);

  const onSave = async () => {
    setError(null);
    try {
      await save.mutateAsync({ publicAddress: sharingAddressUrl(own) });
      toast.success(t("sharing.own_saved"));
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Dialog
      visible={visible}
      onClose={onClose}
      title={t("domains.manual_title")}
      description={t("domains.manual_intro")}
      actions={[
        {
          label: t("sharing.own_save"),
          onPress: onSave,
          loading: save.isPending,
          disabled: !ready || untouched || save.isPending,
          testID: "domains-manual-save",
        },
      ]}
    >
      <View style={{ gap: space["4"] }}>
        <View style={{ gap: space["1"] }}>
          <Text variant='caption' weight='medium' tone='secondary'>
            {t("domains.manual_field_label")}
          </Text>
          <SharingAddress
            value={own}
            onChange={setOwn}
            disabled={save.isPending}
            placeholder={t("sharing.own_field_placeholder")}
            stored={stored}
            testID='sharing-own-address'
          />
          <FormError message={error} />
        </View>

        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: color.border.subtle,
            paddingTop: space["4"],
            gap: space["4"],
          }}
        >
          <Text variant='caption' weight='semibold' tone='tertiary'>
            {t("domains.manual_steps_title")}
          </Text>

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
