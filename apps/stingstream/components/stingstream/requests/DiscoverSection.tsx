import { useEffect, useState } from "react";
import { TextInput, View } from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import {
  type RequestSearchResult,
  requestTitle,
  searchAction,
  useCreateRequest,
  useRequestPolicy,
  useRequestSearch,
} from "@/lib/stingstream/requests";
import { EmptyState, QueryState } from "../shared/ScreenState";
import { SegmentedControl } from "../shared/SegmentedControl";
import { Poster, RowButton } from "./RequestPieces";
import { SeasonPicker } from "./SeasonPicker";

/**
 * Find something to ask for.
 *
 * The search goes through the node's own Radarr and Sonarr metadata lookups rather than a metadata
 * provider of the app's own, and every result comes back annotated with whether the *group* already
 * holds it. That annotation is the whole difference between this and the Seerr screen it replaces:
 * in a group that pools libraries, the interesting answer is usually "you already have this", and
 * discovering that only after pressing Request is too late to be useful.
 */
export function DiscoverSection() {
  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  const [kind, setKind] = useState<"all" | "movie" | "series">("all");
  const [picking, setPicking] = useState<RequestSearchResult | null>(null);

  const policy = useRequestPolicy();
  const search = useRequestSearch(debounced, kind === "all" ? undefined : kind);
  const create = useCreateRequest();

  // 400 ms, because every keystroke here costs the node two metadata lookups and a group-index
  // scan per result. Long enough that typing a title is one search, short enough not to feel stuck.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term), 400);
    return () => clearTimeout(timer);
  }, [term]);

  const ask = async (result: RequestSearchResult, seasons: number[]) => {
    try {
      const made = await create.mutateAsync({
        tmdbId: result.tmdbId || undefined,
        tvdbId: result.tvdbId || undefined,
        seasons,
        title: result.title,
        year: result.year,
        posterUrl: result.posterUrl,
      });
      // Three genuinely different outcomes, and saying "requested" for all of them would hide the
      // one that matters: a title the group already had starts no download at all.
      if (made.state === "available") {
        toast.success(`${requestTitle(made)} is already in your library`);
      } else if (made.state === "pending") {
        toast.success(`Asked for ${requestTitle(made)} — waiting for approval`);
      } else {
        toast.success(`Asked for ${requestTitle(made)}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const onRequest = (result: RequestSearchResult) => {
    if (result.kind === "series") {
      setPicking(result);
      return;
    }
    void ask(result, []);
  };

  const needsApproval = policy.data && policy.data.autoApprove !== "everyone";

  return (
    <View>
      <TextInput
        value={term}
        onChangeText={setTerm}
        placeholder='Search for a film or a series'
        placeholderTextColor='#5A5960'
        autoCorrect={false}
        returnKeyType='search'
        className='bg-neutral-900 rounded-xl px-4 py-3 text-white'
      />

      <View className='mt-3 -mx-4'>
        <SegmentedControl
          segments={[
            { key: "all", label: "Everything" },
            { key: "movie", label: "Films" },
            { key: "series", label: "Series" },
          ]}
          value={kind}
          onChange={(k) => setKind(k as typeof kind)}
        />
      </View>

      {needsApproval ? (
        <Text className='text-[#9899A1] text-xs mt-3'>
          {policy.data?.autoApprove === "admins_only"
            ? "Requests on this node wait for an administrator."
            : "Requests wait for an administrator unless you are trusted."}
        </Text>
      ) : null}

      <View className='h-3' />

      {debounced.trim().length <= 2 ? (
        <EmptyState
          title='Type a title'
          detail='Three letters or more. Results say whether somebody in your group already has it, so you do not ask for a download that would not happen.'
        />
      ) : (
        <QueryState
          isLoading={search.isLoading}
          error={search.error}
          onRetry={search.refetch}
        >
          {(search.data ?? []).length === 0 ? (
            <EmptyState
              title='Nothing found'
              detail={`Neither Radarr nor Sonarr found anything for "${debounced.trim()}". Both have to be configured on this node for search to work.`}
            />
          ) : (
            (search.data ?? []).map((result) => {
              const action = searchAction(result);
              return (
                <View
                  key={`${result.kind}:${result.itemKey}`}
                  className='flex-row gap-3 p-3 rounded-xl bg-neutral-900 mb-2'
                >
                  <Poster url={result.posterUrl} title={result.title} />
                  <View className='flex-1'>
                    <Text
                      className='text-white font-semibold'
                      numberOfLines={2}
                    >
                      {requestTitle(result)}
                    </Text>
                    <Text className='text-[#5A5960] text-[11px] mt-0.5'>
                      {result.kind === "movie" ? "Film" : "Series"}
                    </Text>
                    {result.availableInGroup ? (
                      <Text className='text-[#5FD08A] text-xs mt-1'>
                        Held by {result.holders.join(", ")}
                      </Text>
                    ) : result.overview ? (
                      <Text
                        className='text-[#9899A1] text-xs mt-1'
                        numberOfLines={2}
                      >
                        {result.overview}
                      </Text>
                    ) : null}
                    <View className='flex-row mt-2'>
                      <RowButton
                        label={action.label}
                        disabled={action.disabled || create.isPending}
                        onPress={
                          action.disabled ? undefined : () => onRequest(result)
                        }
                      />
                    </View>
                  </View>
                </View>
              );
            })
          )}
        </QueryState>
      )}

      {picking ? (
        <SeasonPicker
          visible
          title={requestTitle(picking)}
          onCancel={() => setPicking(null)}
          onConfirm={(seasons) => {
            const result = picking;
            setPicking(null);
            void ask(result, seasons);
          }}
        />
      ) : null}
    </View>
  );
}
