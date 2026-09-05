import { useState } from "react";
import { TextInput, TouchableOpacity, View } from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { Colors } from "@/constants/Colors";
import {
  type ConnectivityTestResult,
  type IndexerSettings,
  useAddIndexer,
  useDeleteIndexer,
  useIndexers,
  useTestIndexer,
} from "@/lib/stingstream/hooks";
import { confirmDestructive } from "../shared/confirm";
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
  const testIndexer = useTestIndexer();
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<IndexerSettings>(emptyForm);
  const [verdict, setVerdict] = useState<ConnectivityTestResult | null>(null);

  const submit = async () => {
    if (!form.Name || !form.BaseUrl) {
      toast.error("Name and Torznab base URL are required");
      return;
    }
    try {
      await addIndexer.mutateAsync(form);
      toast.success(`Added indexer "${form.Name}"`);
      setForm(emptyForm);
      setVerdict(null);
      setFormOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add indexer");
    }
  };

  /**
   * Gap 9 closed. The verdict is stored rather than toasted: a bad Torznab key
   * produces a sentence per app naming the field that failed, which is worth
   * leaving on screen next to the field somebody is about to correct.
   */
  const test = async () => {
    if (!form.Name || !form.BaseUrl) {
      toast.error("Name and Torznab base URL are required");
      return;
    }
    setVerdict(null);
    try {
      setVerdict(await testIndexer.mutateAsync(form));
    } catch (err) {
      setVerdict({
        Ok: false,
        Message:
          err instanceof Error
            ? err.message
            : "Neither app could be asked about it.",
      });
    }
  };

  const remove = async (indexer: IndexerSettings) => {
    if (!indexer.Id) return;
    const ok = await confirmDestructive(
      "Remove indexer?",
      `"${indexer.Name}" is removed from StingStream's settings. It stays configured inside Radarr and Sonarr until it is removed there too — sync only ever adds and updates.`,
      "Remove",
    );
    if (!ok) return;
    try {
      await deleteIndexer.mutateAsync(indexer.Id);
      toast.success(`Removed "${indexer.Name}"`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not remove indexer",
      );
    }
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
            "Test" asks Radarr and Sonarr to try it, using exactly the resource
            a save would store. The two send different category lists, so both
            are asked: an endpoint with films but no television passes one and
            fails the other.
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
          {verdict && (
            <View className='mb-2'>
              <Text
                className={
                  verdict.Ok ? "text-green-500 text-xs" : "text-red-500 text-xs"
                }
              >
                {verdict.Ok ? "✓ " : "✕ "}
                {verdict.Message}
              </Text>
            </View>
          )}

          <View className='flex-row gap-2'>
            <TouchableOpacity
              disabled={testIndexer.isPending}
              onPress={() => void test()}
              className='flex-1 rounded-lg py-2 items-center bg-neutral-800'
            >
              <Text className='text-white'>
                {testIndexer.isPending ? "Testing…" : "Test"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              disabled={addIndexer.isPending}
              onPress={submit}
              className='flex-1 rounded-lg py-2 items-center'
              style={{ backgroundColor: Colors.primary }}
            >
              <Text className='text-white font-semibold'>
                {addIndexer.isPending ? "Adding…" : "Add indexer"}
              </Text>
            </TouchableOpacity>
          </View>
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
                onPress={() => void remove(indexer)}
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
