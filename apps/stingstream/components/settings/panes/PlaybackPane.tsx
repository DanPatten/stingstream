import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { TabsBar } from "@/components/common/Tabs";
import { PlaybackPolicySetting } from "@/components/stingstream/sources/PlaybackPolicySetting";
import { space } from "@/constants/theme";
import { ChromecastSettings } from "../ChromecastSettings";
import { FocusTarget } from "../FocusTarget";
import { GestureControls } from "../GestureControls";
import { MediaProvider } from "../MediaContext";
import { MediaToggles } from "../MediaToggles";
import { MpvBufferSettings } from "../MpvBufferSettings";
import { MpvVoSettings } from "../MpvVoSettings";
import { MusicSettings } from "../MusicSettings";
import { PlaybackControlsSettings } from "../PlaybackControlsSettings";
import { SegmentSkipSettings } from "../SegmentSkipSettings";
import { SubtitleToggles } from "../SubtitleToggles";
import { VideoPlayerSelector } from "../VideoPlayerSelector";
import { SettingsPane } from "./SettingsPane";

type Section = "playback" | "audio" | "music";

const SECTIONS: Section[] = ["playback", "audio", "music"];

/**
 * A section name from the URL, or the first one.
 *
 * Narrowed rather than cast, the same guard the old Admin screen used: the value
 * arrives from a query string, and a screen that trusted it would render
 * nothing at all for a typo — every branch missing, a blank page under a tab
 * bar. It is also how the redirects from the pages this replaced land on the
 * right section, and how the settings search jumps to one.
 */
export const sectionFromParam = (value: string | undefined): Section =>
  SECTIONS.find((s) => s === value) ?? "playback";

/**
 * Everything about how *this* app plays something.
 *
 * Four pages before this — Playback controls, Audio & subtitles, Music, Skip
 * segments — each one click deep off a flat list, each about the same act. They
 * are sections of one page now, switched by the same `TabsBar` Requests and the
 * arr library already use: flat, same-depth sections of one screen, deliberately
 * local state rather than a nested router stack.
 *
 * Every control here is `device`-scoped without exception, which is what makes
 * the badge in the header worth reading: the server's own ceiling on what a
 * remote viewer may pull is a different control, on a different page, and
 * mistaking one for the other is the confusion this whole restructure is about.
 */
export const PlaybackPane: React.FC<{ initialSection?: string }> = ({
  initialSection,
}) => {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>(
    sectionFromParam(initialSection),
  );

  return (
    <SettingsPane title={t("home.settings.nav.playback")} scope='device'>
      <View
        testID='settings-playback-tabs'
        style={{ marginBottom: space["4"] }}
      >
        <TabsBar
          segments={[
            {
              key: "playback",
              label: t("home.settings.playback.tab_playback"),
            },
            { key: "audio", label: t("home.settings.playback.tab_audio") },
            { key: "music", label: t("home.settings.playback.tab_music") },
          ]}
          value={section}
          onChange={(v) => setSection(v as Section)}
        />
      </View>

      <MediaProvider>
        {section === "playback" ? (
          <View style={{ gap: space["4"] }}>
            <FocusTarget id={["video-player", "playback-quality"]}>
              <VideoPlayerSelector />
              <PlaybackPolicySetting />
            </FocusTarget>
            <MediaToggles />
            <FocusTarget id='gestures'>
              <GestureControls />
            </FocusTarget>
            <PlaybackControlsSettings />
            <FocusTarget id='segment-skip'>
              <SegmentSkipSettings />
            </FocusTarget>
            <MpvBufferSettings />
            <MpvVoSettings />
            {Platform.isTV ? null : (
              <FocusTarget id='chromecast'>
                <ChromecastSettings />
              </FocusTarget>
            )}
          </View>
        ) : null}

        {section === "audio" ? (
          <FocusTarget
            id={["audio-language", "subtitle-language", "subtitle-style"]}
          >
            <SubtitleToggles />
          </FocusTarget>
        ) : null}
      </MediaProvider>

      {section === "music" ? (
        <FocusTarget id='music-cache'>
          <MusicSettings />
        </FocusTarget>
      ) : null}
    </SettingsPane>
  );
};
