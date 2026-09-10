import type React from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Platform, Pressable, View } from "react-native";
import { SettingSwitch } from "@/components/common/SettingSwitch";
import DisabledSetting from "@/components/settings/DisabledSetting";
import { THEME_NAMES, type ThemeName, themePalette } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { usePressableStates } from "@/hooks/usePressableStates";
import { useTheme } from "@/hooks/useTheme";
import { isHeroAvailable } from "@/modules";
import { useSettings } from "@/utils/atoms/settings";
import { Icon } from "../common/Icon";
import { ListGroup } from "../list/ListGroup";
import { ListItem } from "../list/ListItem";

const SWATCH_SIZE = 32;
const SWATCH_DOT = 20;

/**
 * One theme swatch: the theme's own surface as the disc, its accent as the dot
 * inside, a checkmark when selected, and the usual hover/press/focus set.
 *
 * It has to show the surface as well as the accent. Dark and StingStream share
 * the same cyan accent, so three plain accent circles would put two identical
 * swatches side by side; with the surface behind it they read as near-black,
 * white and indigo, which is what actually distinguishes them on screen.
 */
const ThemeSwatch: React.FC<{
  name: ThemeName;
  selected: boolean;
  label: string;
  onSelect: (name: ThemeName) => void;
}> = ({ name, selected, label, onSelect }) => {
  const palette = themePalette(name);
  // The selected ring is drawn in the theme the person is looking at now, not
  // the one the swatch is offering: it belongs to the settings row, not to the
  // preview inside it.
  const { color } = useTheme();
  const states = usePressableStates();

  return (
    <Pressable
      testID={`settings-theme-${name}`}
      accessibilityRole='button'
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={() => onSelect(name)}
      {...states.handlers}
      style={[
        {
          width: SWATCH_SIZE,
          height: SWATCH_SIZE,
          borderRadius: SWATCH_SIZE / 2,
          backgroundColor: palette.bg["1"],
          alignItems: "center",
          justifyContent: "center",
          borderWidth: selected ? 2 : 1,
          // Unselected still needs a hairline, or the light swatch has no edge
          // against a light row.
          borderColor: selected ? color.text.primary : color.border.strong,
        },
        states.webStyle,
      ]}
    >
      <View
        style={{
          width: SWATCH_DOT,
          height: SWATCH_DOT,
          borderRadius: SWATCH_DOT / 2,
          backgroundColor: palette.accent[500],
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {selected ? (
          <Icon name='check' size={13} color={palette.accent.onAccent} />
        ) : null}
      </View>
    </Pressable>
  );
};

export const AppearanceSettings: React.FC = () => {
  const router = useRouter();
  const { settings, updateSettings, pluginSettings } = useSettings();
  const { t } = useTranslation();

  const disabled = useMemo(
    () =>
      pluginSettings?.showCustomMenuLinks?.locked === true &&
      pluginSettings?.hiddenLibraries?.locked === true,
    [pluginSettings],
  );

  if (!settings) return null;

  return (
    <DisabledSetting disabled={disabled}>
      <ListGroup title={t("home.settings.appearance.title")} className=''>
        <ListItem title={t("home.settings.appearance.theme_title")}>
          <View style={{ flexDirection: "row", gap: 10 }}>
            {THEME_NAMES.map((name) => (
              <ThemeSwatch
                key={name}
                name={name}
                selected={settings.theme === name}
                label={t(`home.settings.appearance.theme_${name}`)}
                onSelect={(value) => updateSettings({ theme: value })}
              />
            ))}
          </View>
        </ListItem>
        <ListItem
          title={t("home.settings.other.show_custom_menu_links")}
          subtitle={t("home.settings.other.show_custom_menu_links_hint")}
          disabled={pluginSettings?.showCustomMenuLinks?.locked}
          onPress={() =>
            Linking.openURL(
              "https://jellyfin.org/docs/general/clients/web-config/#custom-menu-links",
            )
          }
        >
          <SettingSwitch
            value={settings.showCustomMenuLinks}
            disabled={pluginSettings?.showCustomMenuLinks?.locked}
            onValueChange={(value) =>
              updateSettings({ showCustomMenuLinks: value })
            }
          />
        </ListItem>
        {/* `isHeroAvailable` (not `isHeroCarouselAvailable`, which only answers "is the native
            paged view in this binary"): WP4's `HeroSpotlight` gives web and Android a hero built
            in React Native, so the switch that turns it off has to exist wherever a hero can
            render, not just where the native view can. */}
        {isHeroAvailable() && (
          <ListItem
            title={t("home.settings.appearance.show_hero_carousel")}
            subtitle={t("home.settings.appearance.show_hero_carousel_hint")}
            disabled={pluginSettings?.showHeroCarousel?.locked}
          >
            <SettingSwitch
              value={settings.showHeroCarousel}
              disabled={pluginSettings?.showHeroCarousel?.locked}
              onValueChange={(value) =>
                updateSettings({ showHeroCarousel: value })
              }
            />
          </ListItem>
        )}
        <ListItem
          title={t("home.settings.appearance.merge_next_up_continue_watching")}
        >
          <SettingSwitch
            value={settings.mergeNextUpAndContinueWatching}
            onValueChange={(value) =>
              updateSettings({ mergeNextUpAndContinueWatching: value })
            }
          />
        </ListItem>
        <ListItem
          title={t("home.settings.appearance.use_episode_images_next_up")}
          subtitle={t(
            "home.settings.appearance.use_episode_images_next_up_hint",
          )}
        >
          <SettingSwitch
            value={settings.useEpisodeImagesForNextUp}
            onValueChange={(value) =>
              updateSettings({ useEpisodeImagesForNextUp: value })
            }
          />
        </ListItem>
        <ListItem
          title={t("home.settings.appearance.hide_remote_session_button")}
        >
          <SettingSwitch
            value={settings.hideRemoteSessionButton}
            onValueChange={(value) =>
              updateSettings({ hideRemoteSessionButton: value })
            }
          />
        </ListItem>
        {Platform.OS === "ios" && !Platform.isTV && (
          <ListItem
            title={t("home.settings.appearance.download_live_activity")}
            subtitle={t("home.settings.appearance.download_live_activity_hint")}
          >
            <SettingSwitch
              value={settings.showDownloadLiveActivity}
              onValueChange={(value) =>
                updateSettings({ showDownloadLiveActivity: value })
              }
            />
          </ListItem>
        )}
        <ListItem
          onPress={() => router.push("/settings/appearance/hide-libraries")}
          title={t("home.settings.other.hide_libraries")}
          subtitle={t("home.settings.other.select_libraries_you_want_to_hide")}
          showArrow
        />
      </ListGroup>
    </DisabledSetting>
  );
};
