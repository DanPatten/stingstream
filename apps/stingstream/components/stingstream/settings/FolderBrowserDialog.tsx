import { getEnvironmentApi } from "@jellyfin/sdk/lib/utils/api";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { space } from "@/constants/theme";
import {
  DRIVES,
  folderName,
  parentPath,
} from "@/lib/stingstream/folderBrowser";
import { apiAtom } from "@/providers/JellyfinProvider";
import { LoadingState } from "../shared/ScreenState";

/**
 * Picking a folder on the server, rather than typing its path from memory.
 *
 * Dan: "Add support for multiple folders with proper BROWSER button". The listing is the media
 * server's own, so it is the server's disks that are shown, not the device holding the browser.
 * The path box stays, for somebody who already knows where they are going.
 *
 * The state lives in the body rather than here: on a device `Dialog` hands its children to the
 * global sheet once, when it opens, so a dialog whose content changes has to hold that state itself.
 */
export function FolderBrowserDialog({
  visible,
  initialPath,
  onClose,
  onSelect,
}: {
  visible: boolean;
  /** Where to open. The drive list when omitted. */
  initialPath?: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <Dialog
      visible={visible}
      onClose={onClose}
      title={t("libraries.browse_title")}
    >
      {visible ? (
        <FolderBrowserBody
          initialPath={initialPath ?? DRIVES}
          onClose={onClose}
          onSelect={onSelect}
        />
      ) : null}
    </Dialog>
  );
}

function FolderBrowserBody({
  initialPath,
  onClose,
  onSelect,
}: {
  initialPath: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}) {
  const { t } = useTranslation();
  const api = useAtomValue(apiAtom);
  const [path, setPath] = useState(initialPath);
  const [draft, setDraft] = useState(initialPath);

  const go = (next: string) => {
    setPath(next);
    setDraft(next);
  };

  const listing = useQuery({
    queryKey: ["stingstream", "folder-browser", path],
    queryFn: async () => {
      const environment = getEnvironmentApi(api!);
      const response =
        path === DRIVES
          ? await environment.getDrives()
          : await environment.getDirectoryContents({
              path,
              includeDirectories: true,
              includeFiles: false,
            });
      return (response.data ?? [])
        .filter((entry) => entry.Path)
        .sort((a, b) =>
          (a.Name ?? "").localeCompare(b.Name ?? "", undefined, {
            sensitivity: "base",
          }),
        );
    },
    enabled: !!api,
    retry: false,
    staleTime: 10_000,
  });

  return (
    <View style={{ gap: space["3"] }}>
      <View
        style={{ flexDirection: "row", alignItems: "center", gap: space["2"] }}
      >
        <Button
          testID='folder-browser-up'
          variant='secondary'
          size='sm'
          icon='chevronUp'
          disabled={path === DRIVES}
          onPress={() => go(parentPath(path))}
        >
          {t("libraries.browse_up")}
        </Button>
        <View style={{ flex: 1 }}>
          <Input
            testID='folder-browser-path'
            accessibilityLabel={t("libraries.browse_path")}
            placeholder={t("libraries.browse_path")}
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={() => go(draft.trim())}
            autoCapitalize='none'
            autoCorrect={false}
          />
        </View>
      </View>

      <View style={{ minHeight: 240 }}>
        {listing.isLoading ? (
          <LoadingState rows={5} />
        ) : listing.isError ? (
          <Text variant='body' tone='secondary'>
            {t("libraries.browse_error")}
          </Text>
        ) : (listing.data ?? []).length === 0 ? (
          <Text variant='body' tone='secondary'>
            {t("libraries.browse_empty")}
          </Text>
        ) : (
          <ListGroup>
            {(listing.data ?? []).map((entry) => (
              <ListItem
                key={entry.Path!}
                testID='folder-browser-entry'
                title={
                  path === DRIVES
                    ? entry.Name || entry.Path!
                    : folderName(entry.Path!)
                }
                icon='storage'
                showArrow
                onPress={() => go(entry.Path!)}
              />
            ))}
          </ListGroup>
        )}
      </View>

      <View
        style={{
          flexDirection: "row",
          justifyContent: "flex-end",
          gap: space["2"],
          marginTop: space["2"],
        }}
      >
        <Button variant='ghost' size='md' onPress={onClose}>
          {t("libraries.cancel")}
        </Button>
        <Button
          testID='folder-browser-select'
          variant='primary'
          size='md'
          disabled={path === DRIVES || listing.isError}
          onPress={() => onSelect(path)}
        >
          {t("libraries.browse_select")}
        </Button>
      </View>
    </View>
  );
}
