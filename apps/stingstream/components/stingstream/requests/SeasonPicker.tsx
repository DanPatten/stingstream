import { useState } from "react";
import { Modal, ScrollView, TouchableOpacity, View } from "react-native";
import { Text } from "@/components/common/Text";
import { RowButton } from "./RequestPieces";

/**
 * Which seasons of a series to ask for.
 *
 * Two things about the shape, both learned from what the node does with the answer:
 *
 * * **An empty selection means "all of them", and is the default.** It is not the same as "none":
 *   Sonarr's `addOptions.monitor: all` and a per-season tick list are different mechanisms, and
 *   the request carries an empty list precisely so the node can use the first. Somebody who opens
 *   the picker, ticks nothing and confirms gets the whole show, which is what they would expect.
 * * **Season 0 is not offered.** It is the specials folder, and "the whole show" to a person does
 *   not include the Christmas special nobody asked for. The node's `ApplySeasons` agrees.
 *
 * The season *count* is not known here — the request is made from a search result, before anything
 * has been added to Sonarr — so the picker offers a generous fixed range and the node ticks only
 * the seasons the series actually has. Asking for season 12 of a nine-season show is harmless:
 * `ApplySeasons` simply never finds it.
 */
export function SeasonPicker({
  visible,
  title,
  initial,
  onCancel,
  onConfirm,
  maxSeason = 20,
}: {
  visible: boolean;
  title: string;
  initial?: number[];
  onCancel: () => void;
  onConfirm: (seasons: number[]) => void;
  maxSeason?: number;
}) {
  const [chosen, setChosen] = useState<number[]>(initial ?? []);

  const toggle = (season: number) =>
    setChosen((current) =>
      current.includes(season)
        ? current.filter((s) => s !== season)
        : [...current, season].sort((a, b) => a - b),
    );

  return (
    <Modal
      visible={visible}
      transparent
      animationType='fade'
      onRequestClose={onCancel}
    >
      <View className='flex-1 justify-end bg-black/70'>
        <View className='bg-neutral-900 rounded-t-2xl p-4 max-h-[70%]'>
          <Text className='text-white text-lg font-semibold'>{title}</Text>
          <Text className='text-[#9899A1] text-xs mt-1'>
            {chosen.length === 0
              ? "Every season. Tick some to ask for only those."
              : `Seasons ${[...chosen].sort((a, b) => a - b).join(", ")}.`}
          </Text>

          <ScrollView className='mt-3' contentContainerStyle={{ gap: 8 }}>
            <View className='flex-row flex-wrap gap-2'>
              {Array.from({ length: maxSeason }, (_, i) => i + 1).map(
                (season) => {
                  const active = chosen.includes(season);
                  return (
                    <TouchableOpacity
                      key={season}
                      accessibilityRole='button'
                      accessibilityLabel={`Season ${season}`}
                      accessibilityState={{ selected: active }}
                      onPress={() => toggle(season)}
                      className='rounded-full px-3 py-2'
                      style={{
                        backgroundColor: active ? "#9334E9" : "#262626",
                      }}
                    >
                      <Text
                        className={
                          active ? "text-white font-semibold" : "text-[#9899A1]"
                        }
                      >
                        {season}
                      </Text>
                    </TouchableOpacity>
                  );
                },
              )}
            </View>
          </ScrollView>

          <View className='flex-row gap-2 mt-4'>
            <View className='flex-1'>
              <RowButton label='Cancel' tone='quiet' onPress={onCancel} />
            </View>
            {chosen.length > 0 && (
              <View className='flex-1'>
                <RowButton
                  label='All seasons'
                  tone='quiet'
                  onPress={() => setChosen([])}
                />
              </View>
            )}
            <View className='flex-1'>
              <RowButton
                label='Request'
                onPress={() => onConfirm([...chosen].sort((a, b) => a - b))}
              />
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}
