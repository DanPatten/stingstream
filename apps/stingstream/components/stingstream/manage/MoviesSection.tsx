import { useState } from "react";
import { Image, TextInput, TouchableOpacity, View } from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { Colors } from "@/constants/Colors";
import { formatBytes, posterUrl } from "@/lib/stingstream/arr-types";
import { useAddMovie, useMovies } from "@/lib/stingstream/hooks";
import { EmptyState, QueryState } from "../shared/ScreenState";

export function MoviesSection() {
  const { data: movies, isLoading, error, refetch } = useMovies();
  const [addOpen, setAddOpen] = useState(false);

  return (
    <View>
      <View className='flex-row items-center justify-between mb-2'>
        <Text className='text-white text-lg font-semibold'>Movies</Text>
        <TouchableOpacity onPress={() => setAddOpen((v) => !v)}>
          <Text className='text-[#0584FE] font-semibold'>
            {addOpen ? "Cancel" : "+ Add"}
          </Text>
        </TouchableOpacity>
      </View>

      {addOpen && <AddMovieForm onDone={() => setAddOpen(false)} />}

      <QueryState isLoading={isLoading} error={error} onRetry={refetch}>
        {!movies || movies.length === 0 ? (
          <EmptyState
            title='No movies yet'
            detail='Add one by TMDB id above, or from the search screen once title lookup lands (see docs/UI-API-GAPS.md).'
          />
        ) : (
          <ListGroup>
            {movies.map((movie) => (
              <ListItem
                key={movie.id}
                title={`${movie.title} (${movie.year})`}
                subtitle={[
                  movie.hasFile
                    ? "Downloaded"
                    : movie.monitored
                      ? "Monitored"
                      : "Unmonitored",
                  movie.sizeOnDisk ? formatBytes(movie.sizeOnDisk) : null,
                ]
                  .filter(Boolean)
                  .join(" • ")}
              >
                {posterUrl(movie.images) ? (
                  <Image
                    source={{ uri: posterUrl(movie.images) }}
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

function AddMovieForm({ onDone }: { onDone: () => void }) {
  const [tmdbId, setTmdbId] = useState("");
  const [qualityProfileName, setQualityProfileName] = useState("");
  const [searchOnAdd, setSearchOnAdd] = useState(true);
  const addMovie = useAddMovie();

  const submit = async () => {
    const id = Number.parseInt(tmdbId, 10);
    if (!Number.isFinite(id) || id <= 0) {
      toast.error("Enter a valid TMDB id");
      return;
    }
    try {
      const movie = await addMovie.mutateAsync({
        tmdbId: id,
        monitored: true,
        searchOnAdd,
        qualityProfileName: qualityProfileName.trim() || undefined,
      });
      toast.success(`Added ${movie.title}`);
      setTmdbId("");
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add movie");
    }
  };

  return (
    <View className='rounded-xl bg-neutral-900 p-4 mb-3'>
      <Text className='text-[#9899A1] text-xs mb-2'>
        Title search isn't available yet (Core has no lookup endpoint — see
        docs/UI-API-GAPS.md). Add by TMDB id in the meantime; you can find one
        on themoviedb.org.
      </Text>
      <TextInput
        placeholder='TMDB id, e.g. 10378'
        placeholderTextColor='#5A5960'
        keyboardType='number-pad'
        value={tmdbId}
        onChangeText={setTmdbId}
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
        <Text className='text-white'>Search for it immediately</Text>
      </TouchableOpacity>
      <TouchableOpacity
        disabled={addMovie.isPending}
        onPress={submit}
        className='rounded-lg py-2 items-center'
        style={{ backgroundColor: Colors.primary }}
      >
        <Text className='text-white font-semibold'>
          {addMovie.isPending ? "Adding…" : "Add movie"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}
