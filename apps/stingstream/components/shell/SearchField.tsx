import { useSegments } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Input } from "@/components/common/Input";
import useRouter from "@/hooks/useAppRouter";

const MAX_WIDTH = 480;
/** Long enough that a fast typist does not push a route update per keystroke. */
const LIVE_UPDATE_DELAY = 250;

/**
 * The top bar's search box.
 *
 * Two behaviours, because a search field in a persistent chrome has two jobs.
 * From anywhere else, Enter is a navigation: it opens the Search tab with what
 * you typed. Once you are *on* Search, the field is that screen's input — the
 * screen already re-reads its `q` route param whenever it changes — so every
 * keystroke updates the param after a short debounce and results follow as you
 * type, with no second Enter.
 */
export const SearchField: React.FC = () => {
  const { t } = useTranslation();
  const router = useRouter();
  const segments = useSegments() as string[];
  const onSearchTab = segments.includes("(search)");

  const [value, setValue] = useState("");
  const onSearchTabRef = useRef(onSearchTab);
  onSearchTabRef.current = onSearchTab;

  useEffect(() => {
    if (!onSearchTab || value.length === 0) return;
    const timeout = setTimeout(() => {
      // `setParams` targets the focused route, which is the Search screen: the
      // top bar lives outside the navigator and has no route of its own.
      router.setParams({ q: value });
    }, LIVE_UPDATE_DELAY);
    return () => clearTimeout(timeout);
    // `router` is a fresh object every render (useAppRouter memoises on the
    // expo-router one, which changes), so depending on it would restart the
    // timer on every render and never fire.
  }, [value, onSearchTab]);

  const submit = () => {
    const q = value.trim();
    if (q.length === 0) return;
    if (onSearchTabRef.current) {
      router.setParams({ q });
      return;
    }
    // A tab root, so `replace` — the shell is one Stack of the tab groups and
    // pushing a second copy of Search onto it would put a back step between
    // you and where you were.
    router.replace({ pathname: "/(auth)/(tabs)/(search)", params: { q } });
  };

  return (
    <View style={{ flex: 1, maxWidth: MAX_WIDTH }}>
      <Input
        testID='shell-search'
        icon='search'
        value={value}
        onChangeText={setValue}
        onSubmitEditing={submit}
        returnKeyType='search'
        placeholder={t("search.search")}
        accessibilityLabel={t("search.search")}
        autoCorrect={false}
      />
    </View>
  );
};
