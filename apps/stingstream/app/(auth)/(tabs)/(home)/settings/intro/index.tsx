import { useTranslation } from "react-i18next";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { useIntroSheet } from "@/providers/IntroSheetProvider";
import { storage } from "@/utils/mmkv";

function IntroPane() {
  const { showIntro } = useIntroSheet();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();

  return (
    <ScrollView
      contentInsetAdjustmentBehavior='automatic'
      contentContainerStyle={{
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
    >
      <View
        className='p-4 flex flex-col'
        style={{ paddingTop: Platform.OS === "android" ? 10 : 0 }}
      >
        <ListGroup title={t("home.settings.intro.title")}>
          <ListItem
            onPress={() => {
              showIntro();
            }}
            title={t("home.settings.intro.show_intro")}
          />
          <ListItem
            textColor='red'
            onPress={() => {
              storage.set("hasShownIntro", false);
            }}
            title={t("home.settings.intro.reset_intro")}
          />
        </ListGroup>
        <View className='h-24' />
      </View>
    </ScrollView>
  );
}

/**
 * The category column belongs on this page too.
 *
 * Without it this is a pane with no navigation beside it and no way back to
 * its category at all. The shell goes around the whole pane rather than
 * inside it, so an early return while a query is in flight does not take the
 * column with it.
 */
export default function IntroPage() {
  return (
    <SettingsShell categoryKey='about'>
      <IntroPane />
    </SettingsShell>
  );
}
