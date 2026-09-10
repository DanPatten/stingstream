import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Pill } from "@/components/common/Pill";
import { SettingSwitch } from "@/components/common/SettingSwitch";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { space } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import {
  DOWNLOADING_KEYS,
  type DownloadingKey,
  DownloadingUnmanagedError,
  useDownloading,
  useDownloadingHealth,
  useSaveDownloading,
} from "@/lib/stingstream/downloading";
import { ScreenHeaderRow } from "../shared/ScreenHeaderRow";
import { EmptyState, LoadingState } from "../shared/ScreenState";

/**
 * Whether this server fetches things it does not have yet.
 *
 * The control that used to not exist. Everything on this page, everything behind Requests, and
 * three of the four categories in this settings group are served by processes `config.toml` can
 * switch off — and when they were off the app could only say so. "Downloading is not set up on
 * this server. An administrator can enable it in Server settings." named a screen that had not
 * existed since the settings tree was rebuilt, so following it landed on nothing at all.
 *
 * It is the whole of `/settings/downloading`, the first page in the group and the one a reader
 * arrives at from the Requests notice. A switch is a poor fit for anywhere else: it is not a
 * preference, it decides what the server *runs*.
 */
export function DownloadingSection() {
  const { t } = useTranslation();
  const settings = useDownloading();
  const save = useSaveDownloading();

  if (settings.isLoading) {
    return <LoadingState rows={3} />;
  }

  // A node nobody's supervisor started has no config.toml, so there is nothing here to switch.
  // Saying so is better than a dead switch: this is what a developer running Jellyfin directly
  // sees, and it is a real state rather than a fault.
  if (settings.error instanceof DownloadingUnmanagedError) {
    return (
      <EmptyState
        icon='warning'
        title={t("downloading.unmanaged_title")}
        detail={t("downloading.unmanaged_detail")}
      />
    );
  }

  const set = async (key: DownloadingKey, value: boolean) => {
    try {
      // One key per call, and the others left out rather than sent as they were read: the server
      // treats an omitted switch as "leave it", so two people on two screens cannot undo each
      // other's change by each sending a whole document.
      await save.mutateAsync({ [key]: value });
      toast.success(
        value ? t("downloading.turned_on") : t("downloading.turned_off"),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <View testID='downloading-switches'>
      <ScreenHeaderRow title={t("downloading.title")} />
      <Text
        variant='caption'
        tone='secondary'
        style={{ marginBottom: space["3"] }}
      >
        {t("downloading.detail")}
      </Text>
      <ListGroup>
        {DOWNLOADING_KEYS.map((key) => (
          <DownloadingRow
            key={key}
            which={key}
            value={settings.data?.[key] ?? false}
            saving={save.isPending}
            onChange={(v) => set(key, v)}
          />
        ))}
      </ListGroup>
    </View>
  );
}

/**
 * One switch, with what is actually running beside it.
 *
 * The switch is the *setting*; the pill is the *fact*. They disagree for a few seconds after every
 * change, because the supervisor notices the file on its own timer and a manager takes a moment to
 * come up — and they disagree permanently when something is wrong, which is the case worth
 * designing for: a switch that silently sprang back would leave a reader with no idea why.
 *
 * The three states are the child's three states, and they used to be two. `running` collapsed
 * `healthy` and `starting` into one boolean, so a manager still doing its first-run database
 * migration read **Running** — beside the connection error its own health probe had just recorded,
 * because the subtitle showed `last_error` whether or not the child had since answered. One row
 * said the thing was up, working and broken at the same time. `starting` is its own pill now, and
 * the error is shown only while the child is not healthy.
 */
function DownloadingRow({
  which,
  value,
  saving,
  onChange,
}: {
  which: DownloadingKey;
  value: boolean;
  saving: boolean;
  onChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const { accent } = useTheme();
  const health = useDownloadingHealth(which);

  const status = (() => {
    if (!value) return null;
    if (health.state === undefined) return null;
    if (health.state === "healthy") {
      return {
        label: t("downloading.state_running"),
        tone: "success" as const,
      };
    }
    // On, and not answering yet. A manager's first run migrates its database before it binds a
    // port, which takes longer than the supervisor's five-second tick, so this is the ordinary
    // state for a minute after the switch goes on rather than a fault.
    if (health.state === "starting") {
      return {
        label: t("downloading.state_starting"),
        tone: "neutral" as const,
      };
    }
    return {
      label: t("downloading.state_failed"),
      tone: "danger" as const,
    };
  })();

  return (
    <ListItem
      title={t(`downloading.${which}_title`)}
      // `last_error` is what the *last* probe said, and a child that has since answered still
      // carries it until the next healthy tick clears it. Showing it under a healthy manager put
      // a connection failure under a Running pill, so it is offered only when the child is not
      // healthy -- which is the only time it explains anything.
      subtitle={
        health.state !== "healthy" && health.error
          ? health.error
          : t(`downloading.${which}_detail`)
      }
    >
      <View
        style={{ flexDirection: "row", alignItems: "center", gap: space["2"] }}
      >
        {status ? (
          <Pill label={status.label} tone={status.tone} size='sm' />
        ) : null}
        <SettingSwitch
          value={value}
          disabled={saving}
          onValueChange={onChange}
          trackColor={{ true: accent[500] }}
        />
      </View>
    </ListItem>
  );
}
