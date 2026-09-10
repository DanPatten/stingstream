import { Ionicons } from "@expo/vector-icons";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  SheetBackdrop,
  type SheetBackdropProps,
  SheetModal,
  type SheetModalRef,
  SheetView,
} from "@/components/common/Sheet";
import { Text } from "@/components/common/Text";
import useRouter from "@/hooks/useAppRouter";
import { useConfirmDelete } from "@/hooks/useConfirmDelete";
import { useDeletePlaylist } from "@/hooks/usePlaylistMutations";
import { useTheme } from "@/hooks/useTheme";

interface Props {
  open: boolean;
  setOpen: (open: boolean) => void;
  playlist: BaseItemDto | null;
}

export const PlaylistOptionsSheet: React.FC<Props> = ({
  open,
  setOpen,
  playlist,
}) => {
  const { color } = useTheme();
  const bottomSheetModalRef = useRef<SheetModalRef>(null);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const deletePlaylist = useDeletePlaylist();
  const confirmDelete = useConfirmDelete();

  const snapPoints = useMemo(() => ["25%"], []);

  useEffect(() => {
    if (open) bottomSheetModalRef.current?.present();
    else bottomSheetModalRef.current?.dismiss();
  }, [open]);

  const handleSheetChanges = useCallback(
    (index: number) => {
      if (index === -1) {
        setOpen(false);
      }
    },
    [setOpen],
  );

  const renderBackdrop = useCallback(
    (props: SheetBackdropProps) => (
      <SheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />
    ),
    [],
  );

  const handleDeletePlaylist = useCallback(() => {
    if (!playlist?.Id) return;

    confirmDelete({
      title: t("music.playlists.delete_playlist"),
      message: t("music.playlists.delete_confirm", { name: playlist.Name }),
      onConfirm: () => {
        deletePlaylist.mutate(
          { playlistId: playlist.Id! },
          {
            onSuccess: () => {
              setOpen(false);
              router.back();
            },
          },
        );
      },
    });
  }, [playlist, deletePlaylist, setOpen, router, t, confirmDelete]);

  if (!playlist) return null;

  return (
    <SheetModal
      ref={bottomSheetModalRef}
      index={0}
      snapPoints={snapPoints}
      onChange={handleSheetChanges}
      backdropComponent={renderBackdrop}
      handleIndicatorStyle={{
        backgroundColor: "white",
      }}
      backgroundStyle={{
        backgroundColor: "#171717",
      }}
    >
      <SheetView
        style={{
          flex: 1,
          paddingLeft: Math.max(16, insets.left),
          paddingRight: Math.max(16, insets.right),
          paddingBottom: insets.bottom,
        }}
      >
        <View
          style={{ backgroundColor: color.bg["2"] }}
          className='flex-col rounded-xl overflow-hidden'
        >
          <TouchableOpacity
            onPress={handleDeletePlaylist}
            className='flex-row items-center px-4 py-3.5'
          >
            <Ionicons name='trash-outline' size={22} color='#ef4444' />
            <Text tone='danger' className='ml-4 text-base'>
              {t("music.playlists.delete_playlist")}
            </Text>
          </TouchableOpacity>
        </View>
      </SheetView>
    </SheetModal>
  );
};

const _styles = StyleSheet.create({
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "#404040",
  },
});
