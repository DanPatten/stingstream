import type React from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Platform, Pressable, View } from "react-native";
import { SettingSwitch } from "@/components/common/SettingSwitch";
import DisabledSetting from "@/components/settings/DisabledSetting";
import {
  ACCENT_NAMES,
  type AccentName,
  accentPalette,
  tokens,
} from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { usePressableStates } from "@/hooks/usePressableStates";
import { isHeroCarouselAvailable } from "@/modules";
import { useSettings } from "@/utils/atoms/settings";
import { Icon } from "../common/Icon";
import { ListGroup } from "../list/ListGroup";
import { ListItem } from "../list/ListItem";

const SWATCH_SIZE = 32;

/** One accent swatch: a filled circle, a checkmark when selected, the usual hover/press/focus set. */
const AccentSwatch: React.FC<{
  name: AccentName;
  selected: boolean;
  label: string;
  onSelect: (name: AccentName) => void;
}> = ({ name, selected, label, onSelect }) => {
  const palette = accentPalette(name);
  const states = usePressableStates();

  return (
    <Pressable
      testID={`settings-accent-${name}`}
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
          backgroundColor: palette[500],
          alignItems: "center",
          justifyContent: "center",
          borderWidth: selected ? 2 : 0,
          borderColor: tokens.color.text.primary,
        },
        states.webStyle,
      ]}
    >
      {selected ? (
        <Icon name='check' size={16} color={palette.onAccent} />
      ) : null}
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
        <ListItem title={t("home.settings.appearance.accent_title")}>
          <View style={{ flexDirection: "row", gap: 10 }}>
            {ACCENT_NAMES.map((name) => (
              <AccentSwatch
                key={name}
                name={name}
                selected={settings.accent === name}
                label={t(`home.settings.appearance.accent_${name}`)}
                onSelect={(value) => updateSettings({ accent: value })}
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
        {/* The switch tracks the native view rather than a platform: it is
            the only way back once the carousel's own menu turns it off, so it
            has to be offered wherever the carousel can render. */}
        {isHeroCarouselAvailable() && (
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
          subtitle={t(
            "home.settings.appearance.merge_next_up_continue_watching_hint",
          )}
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
          subtitle={t(
            "home.settings.appearance.hide_remote_session_button_hint",
          )}
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
          onPress={() =>
            router.push("/settings/appearance/hide-libraries/page")
          }
          title={t("home.settings.other.hide_libraries")}
          subtitle={t("home.settings.other.select_libraries_you_want_to_hide")}
          showArrow
        />
      </ListGroup>
    </DisabledSetting>
  );
};
