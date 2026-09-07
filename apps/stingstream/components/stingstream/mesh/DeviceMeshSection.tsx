import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { Pill, type PillTone } from "@/components/common/Pill";
import { useMesh } from "@/providers/MeshProvider";

/**
 * What this device's own embedded node is doing, as one status pill.
 *
 * Worth showing plainly, because it is the difference between playback arriving one hop from the
 * holder's disk and playback arriving through the server — and nothing else in the UI would ever
 * tell the user which of those is happening. A single line on purpose (pass-02 critique F-34): the
 * old layout carried a card, a title and an explanatory paragraph that repeated the empty-state
 * copy below it. A browser (and any build with no embedded mesh) always proxies through the
 * server, which is a fact worth one sentence, not a diagnostic panel.
 */
export function DeviceMeshSection() {
  const { t } = useTranslation();
  const { available, running, status, peers } = useMesh();

  if (!available) {
    return (
      <StatusPill
        tone='neutral'
        label={
          Platform.OS === "web"
            ? t("sharing.this_device_unavailable_web")
            : t("sharing.this_device_unavailable_native")
        }
      />
    );
  }

  if (!running || !status) {
    return (
      <StatusPill tone='warning' label={t("sharing.this_device_starting")} />
    );
  }

  const online = peers.filter((p) => p.online && !p.isSelf);
  const direct = online.filter(
    (p) => p.path === "direct" || p.path === "mixed",
  ).length;
  const relayed = online.filter((p) => p.path === "relay").length;

  const label =
    online.length === 0
      ? t("sharing.this_device_no_peers")
      : relayed === 0
        ? t("sharing.this_device_all_direct", { count: online.length })
        : direct === 0
          ? t("sharing.this_device_all_relayed", { count: online.length })
          : t("sharing.this_device_mixed", { direct, relayed });

  return (
    <StatusPill
      tone={
        online.length === 0 ? "neutral" : relayed === 0 ? "success" : "info"
      }
      label={label}
    />
  );
}

function StatusPill({ tone, label }: { tone: PillTone; label: string }) {
  return (
    <View testID='sharing-status' style={{ alignItems: "flex-start" }}>
      <Pill icon='devices' tone={tone} label={label} />
    </View>
  );
}

/** The one-line summary the Settings screen shows on its Sharing row. */
export function useMeshSummary(): string {
  const { t } = useTranslation();
  const { available, running, status, peers } = useMesh();
  if (!available) return t("sharing.summary_not_available");
  if (!running || !status) return t("sharing.this_device_starting");
  const online = peers.filter((p) => p.online && !p.isSelf);
  if (online.length === 0) return t("sharing.this_device_no_peers");
  const relayed = online.filter((p) => p.path === "relay").length;
  return relayed === online.length
    ? t("sharing.summary_online_relayed", { count: online.length })
    : t("sharing.summary_online_direct", { count: online.length });
}
