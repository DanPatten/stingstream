import type { ServerConfiguration } from "@jellyfin/sdk/lib/generated-client/models";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { ListGroup } from "@/components/list/ListGroup";
import { TranscodingSection } from "@/components/stingstream/admin/TranscodingSection";
import {
  SaveBar,
  TextFieldRow,
} from "@/components/stingstream/settings/fields";
import { QueryState } from "@/components/stingstream/shared/ScreenState";
import { space } from "@/constants/theme";
import {
  useServerConfiguration,
  useUpdateServerConfiguration,
} from "@/lib/stingstream/jellyfinConfig";
import { FocusTarget } from "../FocusTarget";
import { SettingsPane } from "./SettingsPane";

/** Jellyfin's own "no limit". Shown as an empty field rather than as 0. */
const NO_LIMIT = 0;

/**
 * What this machine can do, and what it will let a remote viewer take.
 *
 * The two halves used to be a tab of *Libraries & transcoding* (the encoder)
 * and nowhere at all (the ceiling), and the second is the one people go looking
 * for after a slow evening. Keeping them together is also the honest answer to
 * the confusion this restructure is about: **this** is the server-wide bitrate
 * cap, and the per-viewer quality preference that reads almost the same is on
 * Playback & subtitles, badged "This device".
 */
export const TranscodingPane: React.FC = () => {
  const { t } = useTranslation();

  return (
    <SettingsPane
      title={t("home.settings.nav.transcoding")}
      detail={t("home.settings.nav.transcoding_hint")}
    >
      <FocusTarget
        id={["hardware-acceleration", "encoding-threads", "transcode-path"]}
      >
        <TranscodingSection />
      </FocusTarget>
      <View style={{ marginTop: space["6"] }}>
        <FocusTarget id='remote-bitrate'>
          <RemoteLimits />
        </FocusTarget>
      </View>
    </SettingsPane>
  );
};

/**
 * The ceiling on what somebody outside the house may pull.
 *
 * `RemoteClientBitrateLimit` is bits per second in the document and megabits in
 * every conversation anybody has about it, so the field takes megabits and the
 * conversion happens here rather than in the reader's head.
 */
const RemoteLimits: React.FC = () => {
  const { t } = useTranslation();
  const query = useServerConfiguration();
  const update = useUpdateServerConfiguration();
  const [draft, setDraft] = useState<ServerConfiguration | null>(null);

  useEffect(() => {
    if (query.data && !draft) setDraft(query.data);
  }, [query.data, draft]);

  const dirty =
    !!draft && JSON.stringify(draft) !== JSON.stringify(query.data ?? null);

  const mbps = (bits: number | undefined) =>
    !bits || bits === NO_LIMIT ? "" : String(Math.round(bits / 1_000_000));

  const save = async () => {
    if (!draft) return;
    try {
      // The whole document: `updateConfiguration` replaces rather than patches.
      await update.mutateAsync(draft);
      toast.success(t("home.settings.transcoding.saved"));
    } catch (e) {
      toast.error(
        e instanceof Error
          ? e.message
          : t("home.settings.transcoding.save_failed"),
      );
    }
  };

  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.error}
      onRetry={query.refetch}
    >
      {draft ? (
        <View>
          <ListGroup title={t("home.settings.transcoding.remote_title")}>
            <TextFieldRow
              title={t("home.settings.transcoding.remote_bitrate_title")}
              subtitle={t("home.settings.transcoding.remote_bitrate_detail")}
              keyboardType='number-pad'
              placeholder={t("home.settings.transcoding.no_limit")}
              value={mbps(draft.RemoteClientBitrateLimit)}
              onChangeText={(v) =>
                setDraft((d) =>
                  d
                    ? {
                        ...d,
                        RemoteClientBitrateLimit:
                          (Number.parseInt(v, 10) || 0) * 1_000_000,
                      }
                    : d,
                )
              }
            />
          </ListGroup>
          <SaveBar
            dirty={dirty}
            saving={update.isPending}
            onDiscard={() => setDraft(query.data ?? null)}
            onSave={save}
          />
        </View>
      ) : null}
    </QueryState>
  );
};
