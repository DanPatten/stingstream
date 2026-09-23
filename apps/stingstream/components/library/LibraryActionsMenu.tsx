import { getItemRefreshApi } from "@jellyfin/sdk/lib/utils/api";
import { useAtomValue } from "jotai";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { toast } from "sonner-native";
import { Icon } from "@/components/common/Icon";
import type { OptionGroup } from "@/components/PlatformDropdown";
import { PlatformDropdown } from "@/components/PlatformDropdown";
import { headerTarget } from "@/components/shell/headerTarget";
import { GrantLibraryAccessDialog } from "@/components/stingstream/users/GrantLibraryAccessDialog";
import useRouter from "@/hooks/useAppRouter";
import { useTheme } from "@/hooks/useTheme";
import {
  libraryForJellyfinId,
  useLibraries,
} from "@/lib/stingstream/libraries";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import { logAndCaptureError } from "@/utils/log";

/**
 * The "..." beside a library's title, as Plex has it: scan the files, grant access, manage.
 *
 * Administrators only, and not on TV: every action here changes the server. On a library page it
 * offers Manage library; on the library's own settings page it offers Delete instead.
 */
export function LibraryActionsMenu({
  jellyfinId,
  name,
  showManage = false,
  onDelete,
}: {
  /** The media server's id. Empty for a library that is switched off. */
  jellyfinId?: string;
  name: string;
  showManage?: boolean;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  const { color } = useTheme();
  const api = useAtomValue(apiAtom);
  const user = useAtomValue(userAtom);
  const router = useRouter();
  const isAdmin = Boolean(user?.Policy?.IsAdministrator);
  const libraries = useLibraries(isAdmin && showManage);
  const row = showManage
    ? libraryForJellyfinId(libraries.data, jellyfinId)
    : undefined;

  const [open, setOpen] = useState(false);
  const [granting, setGranting] = useState(false);

  const scan = useCallback(async () => {
    if (!api || !jellyfinId) return;
    try {
      // What the media server's own "Scan library files" sends: find new and removed files, keep
      // the metadata already there. A collection folder's refresh walks its children itself.
      await getItemRefreshApi(api).refreshItem({
        itemId: jellyfinId,
        metadataRefreshMode: "Default",
        imageRefreshMode: "Default",
        replaceAllMetadata: false,
        replaceAllImages: false,
      });
      toast.success(t("libraries.scan_success"));
    } catch (error) {
      logAndCaptureError("Library scan failed", error);
      toast.error(t("libraries.scan_error"));
    }
  }, [api, jellyfinId, t]);

  const groups = useMemo<OptionGroup[]>(() => {
    const options: OptionGroup["options"] = [];
    if (jellyfinId) {
      options.push(
        {
          type: "action",
          label: t("libraries.scan_files"),
          onPress: () => void scan(),
        },
        {
          type: "action",
          label: t("libraries.grant_access"),
          onPress: () => setGranting(true),
        },
      );
    }
    if (row) {
      options.push({
        type: "action",
        label: t("libraries.manage"),
        onPress: () =>
          router.push(`/settings/libraries/${encodeURIComponent(row.id)}`),
      });
    }
    if (onDelete) {
      options.push({
        type: "action",
        label: t("libraries.delete"),
        onPress: onDelete,
      });
    }
    return options.length ? [{ options }] : [];
  }, [jellyfinId, row, onDelete, scan, router, t]);

  if (!isAdmin || Platform.isTV || groups.length === 0) return null;

  return (
    <>
      <PlatformDropdown
        open={open}
        onOpenChange={setOpen}
        title={name}
        groups={groups}
        trigger={
          <View
            testID='library-actions'
            accessible
            accessibilityRole='button'
            accessibilityLabel={t("libraries.options")}
            style={{
              ...headerTarget,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name='more' size={22} color={color.text.secondary} />
          </View>
        }
      />
      {jellyfinId ? (
        <GrantLibraryAccessDialog
          visible={granting}
          libraryId={jellyfinId}
          libraryName={name}
          onClose={() => setGranting(false)}
        />
      ) : null}
    </>
  );
}
