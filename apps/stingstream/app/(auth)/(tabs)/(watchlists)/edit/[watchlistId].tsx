import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Switch,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/Button";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import useRouter from "@/hooks/useAppRouter";
import { useDismissKeyboardOnLeave } from "@/hooks/useDismissKeyboardOnLeave";
import { useTheme } from "@/hooks/useTheme";
import { useUpdateWatchlist } from "@/hooks/useWatchlistMutations";
import { useWatchlistDetailQuery } from "@/hooks/useWatchlists";
import type {
  StreamystatsWatchlistAllowedItemType,
  StreamystatsWatchlistSortOrder,
} from "@/utils/streamystats/types";

const ITEM_TYPES: Array<{
  value: StreamystatsWatchlistAllowedItemType;
  label: string;
}> = [
  { value: null, label: "All Types" },
  { value: "Movie", label: "Movies Only" },
  { value: "Series", label: "Series Only" },
  { value: "Episode", label: "Episodes Only" },
];

const SORT_OPTIONS: Array<{
  value: StreamystatsWatchlistSortOrder;
  label: string;
}> = [
  { value: "custom", label: "Custom Order" },
  { value: "name", label: "Name" },
  { value: "dateAdded", label: "Date Added" },
  { value: "releaseDate", label: "Release Date" },
];

export default function EditWatchlistScreen() {
  const { color } = useTheme();
  useDismissKeyboardOnLeave();
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { watchlistId } = useLocalSearchParams<{ watchlistId: string }>();
  const watchlistIdNum = watchlistId
    ? Number.parseInt(watchlistId, 10)
    : undefined;

  const { data: watchlist, isLoading } =
    useWatchlistDetailQuery(watchlistIdNum);
  const updateWatchlist = useUpdateWatchlist();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [allowedItemType, setAllowedItemType] =
    useState<StreamystatsWatchlistAllowedItemType>(null);
  const [defaultSortOrder, setDefaultSortOrder] =
    useState<StreamystatsWatchlistSortOrder>("custom");

  // Initialize form with watchlist data
  useEffect(() => {
    if (watchlist) {
      setName(watchlist.name);
      setDescription(watchlist.description ?? "");
      setIsPublic(watchlist.isPublic);
      setAllowedItemType(
        (watchlist.allowedItemType as StreamystatsWatchlistAllowedItemType) ??
          null,
      );
      setDefaultSortOrder(
        (watchlist.defaultSortOrder as StreamystatsWatchlistSortOrder) ??
          "custom",
      );
    }
  }, [watchlist]);

  const handleSave = useCallback(async () => {
    if (!name.trim() || !watchlistIdNum) return;

    try {
      await updateWatchlist.mutateAsync({
        watchlistId: watchlistIdNum,
        data: {
          name: name.trim(),
          description: description.trim() || undefined,
          isPublic,
          allowedItemType,
          defaultSortOrder,
        },
      });
      router.back();
    } catch {
      // Error handled by mutation
    }
  }, [
    name,
    description,
    isPublic,
    allowedItemType,
    defaultSortOrder,
    watchlistIdNum,
    updateWatchlist,
    router,
  ]);

  if (isLoading) {
    return (
      <View
        className='flex-1 items-center justify-center'
        style={{ backgroundColor: "#171717" }}
      >
        <ActivityIndicator size='large' />
      </View>
    );
  }

  if (!watchlist) {
    return (
      <View
        className='flex-1 items-center justify-center px-8'
        style={{ backgroundColor: "#171717" }}
      >
        <Text tone='secondary' className='text-lg'>
          {t("watchlists.not_found")}
        </Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      className='flex-1'
      style={{ backgroundColor: "#171717" }}
    >
      <ScrollView
        className='flex-1'
        contentContainerStyle={{
          paddingBottom: insets.bottom + 20,
        }}
        keyboardShouldPersistTaps='handled'
      >
        {/* Name */}
        <View className='px-4 py-4'>
          <Text tone='secondary' className='text-sm font-medium mb-2'>
            {t("watchlists.name_label")} *
          </Text>
          <Input
            value={name}
            onChangeText={setName}
            placeholder={t("watchlists.name_placeholder")}
          />
        </View>

        {/* Description */}
        <View className='px-4 py-4'>
          <Text tone='secondary' className='text-sm font-medium mb-2'>
            {t("watchlists.description_label")}
          </Text>
          <Input
            value={description}
            onChangeText={setDescription}
            placeholder={t("watchlists.description_placeholder")}
            multiline
            numberOfLines={3}
            textAlignVertical='top'
            style={{ minHeight: 80, alignItems: "flex-start" }}
          />
        </View>

        {/* Public Toggle */}
        <View className='px-4 py-4 flex-row items-center justify-between'>
          <View className='flex-1 mr-4'>
            <Text className='text-base font-medium'>
              {t("watchlists.is_public_label")}
            </Text>
            <Text tone='secondary' className='text-sm mt-1'>
              {t("watchlists.is_public_description")}
            </Text>
          </View>
          <Switch
            value={isPublic}
            onValueChange={setIsPublic}
            trackColor={{ false: "#374151", true: "#7c3aed" }}
            thumbColor={isPublic ? "#a78bfa" : "#9ca3af"}
          />
        </View>

        {/* Content Type */}
        <View className='px-4 py-4'>
          <Text tone='secondary' className='text-sm font-medium mb-2'>
            {t("watchlists.allowed_type_label")}
          </Text>
          <View className='flex-row flex-wrap gap-2'>
            {ITEM_TYPES.map((type) => (
              <TouchableOpacity
                key={type.value ?? "all"}
                onPress={() => setAllowedItemType(type.value)}
                style={{
                  backgroundColor:
                    allowedItemType === type.value
                      ? color.accent[500]
                      : color.bg["2"],
                }}
                className='px-4 py-2 rounded-lg'
              >
                <Text
                  weight={allowedItemType === type.value ? "medium" : "regular"}
                  style={{
                    color:
                      allowedItemType === type.value
                        ? color.accent.onAccent
                        : color.text.secondary,
                  }}
                >
                  {type.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Sort Order */}
        <View className='px-4 py-4'>
          <Text tone='secondary' className='text-sm font-medium mb-2'>
            {t("watchlists.sort_order_label")}
          </Text>
          <View className='flex-row flex-wrap gap-2'>
            {SORT_OPTIONS.map((sort) => (
              <TouchableOpacity
                key={sort.value}
                onPress={() => setDefaultSortOrder(sort.value)}
                style={{
                  backgroundColor:
                    defaultSortOrder === sort.value
                      ? color.accent[500]
                      : color.bg["2"],
                }}
                className='px-4 py-2 rounded-lg'
              >
                <Text
                  weight={
                    defaultSortOrder === sort.value ? "medium" : "regular"
                  }
                  style={{
                    color:
                      defaultSortOrder === sort.value
                        ? color.accent.onAccent
                        : color.text.secondary,
                  }}
                >
                  {sort.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Save Button */}
        <View className='px-4 pt-4'>
          <Button
            onPress={handleSave}
            disabled={!name.trim() || updateWatchlist.isPending}
            className={`py-3 ${!name.trim() ? "opacity-50" : ""}`}
          >
            {updateWatchlist.isPending ? (
              <ActivityIndicator color='white' />
            ) : (
              <View className='flex-row items-center'>
                <Ionicons name='checkmark' size={20} color='white' />
                <Text className='font-semibold text-base'>
                  {t("watchlists.save_button")}
                </Text>
              </View>
            )}
          </Button>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
