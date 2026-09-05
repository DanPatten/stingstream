import { useState } from "react";
import { Alert, TextInput, TouchableOpacity, View } from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { Colors } from "@/constants/Colors";
import {
  type IndexerSettings,
  useAddIndexer,
  useDeleteIndexer,
  useIndexers,
} from "@/lib/stingstream/hooks";
import { EmptyState, QueryState } from "../shared/ScreenState";

const emptyForm: IndexerSettings = {
  Name: "",
  BaseUrl: "",
  ApiPath: "/api",
  ApiKey: "",
  Enabled: true,
  Priority: 25,
  MinimumSeeders: 1,
  EnableRss: true,
  EnableAutomaticSearch: true,
  EnableInteractiveSearch: true,
  MovieCategories: [2000],
  TvCategories: [5000],
  ForMovies: true,
  ForSeries: true,
};

export function IndexersSection() {
  const { data: indexers, isLoading, error, refetch } = useIndexers();
  const addIndexer = useAddIndexer();
  const deleteIndexer = useDeleteIndexer();
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<IndexerSettings>(emptyForm);

  const submit = async () => {
    if (!form.Name || !form.BaseUrl) {
      toast.error("Name and Torznab base URL are required");
      return;
    }
    try {
      await addIndexer.mutateAsync(form);
      toast.success(`Added indexer "${form.Name}"`);
      setForm(emptyForm);
      setFormOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add indexer");
    }
  };

  const remove = (indexer: IndexerSettings) => {
    if (!indexer.Id) return;
    Alert.alert(
      "Remove indexer?",
      `"${indexer.Name}" will be removed from both Radarr and Sonarr.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteIndexer.mutateAsync(indexer.Id!);
              toast.success(`Removed "${indexer.Name}"`);
            } catch (err) {
              toast.error(
                err instanceof Error ? err.message : "Could not remove indexer",
              );
            }
          },
        },
      ],
    );
  };

  return (
    <View>
      <View className='flex-row items-center justify-between mb-2'>
        <Text className='text-white text-lg font-semibold'>Indexers</Text>
        <TouchableOpacity onPress={() => setFormOpen((v) => !v)}>
          <Text className='text-[#0584FE] font-semibold'>
            {formOpen ? "Cancel" : "+ Add Torznab indexer"}
          </Text>
        </TouchableOpacity>
      </View>

      {formOpen && (
        <View className='rounded-xl bg-neutral-900 p-4 mb-3'>
          <Text className='text-[#9899A1] text-xs mb-2'>
            Testing an indexer before saving isn't available yet — Core has
            add/edit/delete but no test endpoint (see docs/UI-API-GAPS.md). Both
            apps still validate the URL when they search it.
          </Text>
          <TextInput
            placeholder='Name'
            placeholderTextColor='#5A5960'
            value={form.Name}
            onChangeText={(v) => setForm((f) => ({ ...f, Name: v }))}
            className='bg-neutral-800 text-white rounded-lg px-3 py-2 mb-2'
          />
          <TextInput
            placeholder='Torznab base URL, e.g. http://127.0.0.1:9117/api/v2.0/indexers/x/results/torznab'
            placeholderTextColor='#5A5960'
            autoCapitalize='none'
            value={form.BaseUrl}
            onChangeText={(v) => setForm((f) => ({ ...f, BaseUrl: v }))}
            className='bg-neutral-800 text-white rounded-lg px-3 py-2 mb-2'
          />
          <TextInput
            placeholder='API key (optional)'
            placeholderTextColor='#5A5960'
            autoCapitalize='none'
            value={form.ApiKey ?? ""}
            onChangeText={(v) => setForm((f) => ({ ...f, ApiKey: v }))}
            className='bg-neutral-800 text-white rounded-lg px-3 py-2 mb-2'
          />
          <TouchableOpacity
            disabled={addIndexer.isPending}
            onPress={submit}
            className='rounded-lg py-2 items-center'
            style={{ backgroundColor: Colors.primary }}
          >
            <Text className='text-white font-semibold'>
              {addIndexer.isPending ? "Adding…" : "Add indexer"}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      <QueryState isLoading={isLoading} error={error} onRetry={refetch}>
        {!indexers || indexers.length === 0 ? (
          <EmptyState
            title='No indexers configured'
            detail='Add a Torznab indexer above — it is pushed into both Radarr and Sonarr.'
          />
        ) : (
          <ListGroup>
            {indexers.map((indexer) => (
              <ListItem
                key={indexer.Id}
                title={indexer.Name}
                subtitle={[
                  indexer.Enabled ? "Enabled" : "Disabled",
                  indexer.ForMovies && indexer.ForSeries
                    ? "Movies + Series"
                    : indexer.ForMovies
                      ? "Movies"
                      : indexer.ForSeries
                        ? "Series"
                        : null,
                  `priority ${indexer.Priority}`,
                ]
                  .filter(Boolean)
                  .join(" • ")}
                onPress={() => remove(indexer)}
                textColor='red'
                showArrow={false}
              >
                <Text className='text-red-600'>Remove</Text>
              </ListItem>
            ))}
          </ListGroup>
        )}
      </QueryState>
    </View>
  );
}
