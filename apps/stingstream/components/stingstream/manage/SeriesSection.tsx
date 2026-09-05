import { useState } from "react";
import { Image, TextInput, TouchableOpacity, View } from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { Colors } from "@/constants/Colors";
import { formatBytes, posterUrl } from "@/lib/stingstream/arr-types";
import { useAddSeries, useSeries } from "@/lib/stingstream/hooks";
import { EmptyState, QueryState } from "../shared/ScreenState";

export function SeriesSection() {
  const { data: series, isLoading, error, refetch } = useSeries();
  const [addOpen, setAddOpen] = useState(false);

  return (
    <View>
      <View className='flex-row items-center justify-between mb-2'>
        <Text className='text-white text-lg font-semibold'>Series</Text>
        <TouchableOpacity onPress={() => setAddOpen((v) => !v)}>
          <Text className='text-[#0584FE] font-semibold'>
            {addOpen ? "Cancel" : "+ Add"}
          </Text>
        </TouchableOpacity>
      </View>

      {addOpen && <AddSeriesForm onDone={() => setAddOpen(false)} />}

      <QueryState isLoading={isLoading} error={error} onRetry={refetch}>
        {!series || series.length === 0 ? (
          <EmptyState
            title='No series yet'
            detail='Add one by TVDB id above, or from the search screen once title lookup lands (see docs/UI-API-GAPS.md).'
          />
        ) : (
          <ListGroup>
            {series.map((s) => (
              <ListItem
                key={s.id}
                title={`${s.title} (${s.year})`}
                subtitle={[
                  s.monitored ? "Monitored" : "Unmonitored",
                  s.statistics?.episodeFileCount != null
                    ? `${s.statistics.episodeFileCount}/${s.statistics.episodeCount} episodes`
                    : null,
                  s.statistics?.sizeOnDisk
                    ? formatBytes(s.statistics.sizeOnDisk)
                    : null,
                ]
                  .filter(Boolean)
                  .join(" • ")}
              >
                {posterUrl(s.images) ? (
                  <Image
                    source={{ uri: posterUrl(s.images) }}
                    style={{ width: 32, height: 48, borderRadius: 4 }}
                  />
                ) : null}
              </ListItem>
            ))}
          </ListGroup>
        )}
      </QueryState>
    </View>
  );
}

function AddSeriesForm({ onDone }: { onDone: () => void }) {
  const [tvdbId, setTvdbId] = useState("");
  const [qualityProfileName, setQualityProfileName] = useState("");
  const [searchOnAdd, setSearchOnAdd] = useState(true);
  const addSeries = useAddSeries();

  const submit = async () => {
    const id = Number.parseInt(tvdbId, 10);
    if (!Number.isFinite(id) || id <= 0) {
      toast.error("Enter a valid TVDB id");
      return;
    }
    try {
      const series = await addSeries.mutateAsync({
        tvdbId: id,
        monitored: true,
        searchOnAdd,
        qualityProfileName: qualityProfileName.trim() || undefined,
      });
      toast.success(`Added ${series.title}`);
      setTvdbId("");
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add series");
    }
  };

  return (
    <View className='rounded-xl bg-neutral-900 p-4 mb-3'>
      <Text className='text-[#9899A1] text-xs mb-2'>
        Title search isn't available yet (Core has no lookup endpoint — see
        docs/UI-API-GAPS.md). Add by TVDB id in the meantime; you can find one
        on thetvdb.com.
      </Text>
      <TextInput
        placeholder='TVDB id, e.g. 71471'
        placeholderTextColor='#5A5960'
        keyboardType='number-pad'
        value={tvdbId}
        onChangeText={setTvdbId}
        className='bg-neutral-800 text-white rounded-lg px-3 py-2 mb-2'
      />
      <TextInput
        placeholder='Quality profile name (optional)'
        placeholderTextColor='#5A5960'
        value={qualityProfileName}
        onChangeText={setQualityProfileName}
        className='bg-neutral-800 text-white rounded-lg px-3 py-2 mb-2'
      />
      <TouchableOpacity
        onPress={() => setSearchOnAdd((v) => !v)}
        className='flex-row items-center mb-3'
      >
        <View
          className='w-5 h-5 rounded mr-2 items-center justify-center'
          style={{
            backgroundColor: searchOnAdd ? Colors.primary : "#1f1f1f",
          }}
        >
          {searchOnAdd && <Text className='text-white text-xs'>{"✓"}</Text>}
        </View>
        <Text className='text-white'>
          Search for missing episodes immediately
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        disabled={addSeries.isPending}
        onPress={submit}
        className='rounded-lg py-2 items-center'
        style={{ backgroundColor: Colors.primary }}
      >
        <Text className='text-white font-semibold'>
          {addSeries.isPending ? "Adding…" : "Add series"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}
