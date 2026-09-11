import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import {
  useSetSharedLibraries,
  useSharedLibraries,
} from "@/lib/stingstream/mesh";
import { LibraryPicker } from "../shared/LibraryPicker";

/**
 * Which of this server's libraries the other side gets.
 *
 * Dan: *"Each side picks its own."* So this edits **your** half only. What you see of theirs is
 * their decision, made on their own server, and saying that plainly is more honest than a control
 * that looks editable and is not.
 *
 * Saved on every tap rather than behind a Save button: there is one field, the server republishes
 * immediately, and a screen that can be left half-applied is how somebody ends up believing they
 * un-shared something they did not.
 *
 * **A link starts closed**, which is why this is also the last step of *Add server* and not only a
 * thing you can go and find afterwards. A group with no row shares nothing
 * (`SharedLibraryStore`), so the moment the link is made is the one moment its owner is certainly
 * thinking about what to put in it.
 */
export const SharedLibrariesSection: React.FC<{ group: string }> = ({
  group,
}) => {
  const { t } = useTranslation();
  const libraries = useSharedLibraries(group);
  const save = useSetSharedLibraries();

  const shared = libraries.data?.shared ?? [];

  const toggle = (id: string) => {
    const next = shared.includes(id)
      ? shared.filter((existing) => existing !== id)
      : [...shared, id];
    save.mutate(
      { group, libraries: next },
      { onError: (e) => toast.error(e.message) },
    );
  };

  return (
    <View>
      <Text variant='caption' tone='secondary' weight='medium'>
        {t("sharing.link_libraries_title")}
      </Text>
      <Text variant='caption' tone='tertiary' style={{ marginBottom: 8 }}>
        {t("sharing.link_libraries_hint")}
      </Text>
      <LibraryPicker
        available={libraries.data?.available ?? []}
        selected={shared}
        onToggle={toggle}
        loading={libraries.isPending}
        disabled={save.isPending}
      />
    </View>
  );
};
