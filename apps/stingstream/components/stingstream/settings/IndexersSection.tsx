import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Input } from "@/components/common/Input";
import { Pill } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { radius } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import {
  type ConnectivityTestResult,
  type IndexerSettings,
  useAddIndexer,
  useDeleteIndexer,
  useIndexers,
  useTestIndexer,
} from "@/lib/stingstream/hooks";
import { confirmDestructive } from "../shared/confirm";
import { ScreenHeaderRow } from "../shared/ScreenHeaderRow";
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
  const { color } = useTheme();
  const { t } = useTranslation();
  const { data: indexers, isLoading, error, refetch } = useIndexers();
  const addIndexer = useAddIndexer();
  const deleteIndexer = useDeleteIndexer();
  const testIndexer = useTestIndexer();
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<IndexerSettings>(emptyForm);
  const [showApiKey, setShowApiKey] = useState(false);
  const [verdict, setVerdict] = useState<ConnectivityTestResult | null>(null);

  const submit = async () => {
    if (!form.Name || !form.BaseUrl) {
      toast.error(t("server_settings.indexers_name_and_url_required"));
      return;
    }
    try {
      await addIndexer.mutateAsync(form);
      toast.success(
        t("server_settings.indexers_added_toast", { name: form.Name }),
      );
      setForm(emptyForm);
      setVerdict(null);
      setShowApiKey(false);
      setFormOpen(false);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("server_settings.indexers_add_error"),
      );
    }
  };

  /**
   * Gap 9 closed. The verdict is stored rather than toasted: a bad Torznab key
   * produces a sentence per app naming the field that failed, which is worth
   * leaving on screen next to the field somebody is about to correct.
   */
  const test = async () => {
    if (!form.Name || !form.BaseUrl) {
      toast.error(t("server_settings.indexers_name_and_url_required"));
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
            : t("server_settings.indexers_test_error"),
      });
    }
  };

  const remove = async (indexer: IndexerSettings) => {
    if (!indexer.Id) return;
    const ok = await confirmDestructive(
      t("server_settings.indexers_remove_confirm_title"),
      t("server_settings.indexers_remove_confirm_message", {
        name: indexer.Name,
      }),
      t("common.remove"),
    );
    if (!ok) return;
    try {
      await deleteIndexer.mutateAsync(indexer.Id);
      toast.success(
        t("server_settings.indexers_removed_toast", { name: indexer.Name }),
      );
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("server_settings.indexers_remove_error"),
      );
    }
  };

  return (
    <View>
      <ScreenHeaderRow
        title={t("server_settings.indexers_title")}
        accessory={
          <Button
            variant='secondary'
            size='sm'
            icon={formOpen ? "close" : "add"}
            onPress={() => setFormOpen((v) => !v)}
          >
            {formOpen
              ? t("common.cancel")
              : t("server_settings.indexers_add_action")}
          </Button>
        }
      />

      {formOpen && (
        <View
          style={{
            borderRadius: radius.lg,
            backgroundColor: color.bg["1"],
            padding: 16,
            marginBottom: 12,
          }}
        >
          <Text variant='caption' tone='secondary' style={{ marginBottom: 8 }}>
            {t("server_settings.indexers_test_explainer")}
          </Text>
          <Input
            placeholder={t("server_settings.indexers_name_placeholder")}
            value={form.Name}
            onChangeText={(v) => setForm((f) => ({ ...f, Name: v }))}
            style={{ marginBottom: 8 }}
          />
          <Input
            placeholder={t("server_settings.indexers_base_url_placeholder")}
            autoCapitalize='none'
            value={form.BaseUrl}
            onChangeText={(v) => setForm((f) => ({ ...f, BaseUrl: v }))}
            style={{ marginBottom: 8 }}
          />
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
            }}
          >
            <View style={{ flex: 1 }}>
              <Input
                placeholder={t("server_settings.indexers_api_key_placeholder")}
                autoCapitalize='none'
                secureTextEntry={!showApiKey}
                value={form.ApiKey ?? ""}
                onChangeText={(v) => setForm((f) => ({ ...f, ApiKey: v }))}
              />
            </View>
            <Pressable
              onPress={() => setShowApiKey((v) => !v)}
              hitSlop={8}
              accessibilityRole='button'
            >
              <Text variant='caption' weight='semibold' tone='accent'>
                {showApiKey ? t("common.hide") : t("common.show")}
              </Text>
            </Pressable>
          </View>
          {verdict && (
            <Text
              variant='caption'
              tone={verdict.Ok ? undefined : "danger"}
              style={[
                { marginBottom: 8 },
                verdict.Ok ? { color: color.state.success } : undefined,
              ]}
            >
              {verdict.Message}
            </Text>
          )}

          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button
              variant='secondary'
              style={{ flex: 1 }}
              loading={testIndexer.isPending}
              onPress={() => void test()}
            >
              {t("server_settings.test_action")}
            </Button>
            <Button
              variant='primary'
              style={{ flex: 1 }}
              loading={addIndexer.isPending}
              onPress={() => void submit()}
            >
              {t("server_settings.indexers_add_indexer_action")}
            </Button>
          </View>
        </View>
      )}

      <QueryState isLoading={isLoading} error={error} onRetry={refetch}>
        {!indexers || indexers.length === 0 ? (
          <EmptyState
            title={t("server_settings.indexers_empty_title")}
            detail={t("server_settings.indexers_empty_detail")}
          />
        ) : (
          <ListGroup>
            {indexers.map((indexer) => (
              <ListItem
                key={indexer.Id}
                title={indexer.Name}
                subtitle={[
                  indexer.ForMovies && indexer.ForSeries
                    ? t("server_settings.indexers_for_both")
                    : indexer.ForMovies
                      ? t("server_settings.indexers_for_movies")
                      : indexer.ForSeries
                        ? t("server_settings.indexers_for_series")
                        : null,
                  t("server_settings.indexers_priority", {
                    priority: indexer.Priority,
                  }),
                ]
                  .filter(Boolean)
                  .join(" • ")}
              >
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                  }}
                >
                  <Pill
                    label={
                      indexer.Enabled
                        ? t("server_settings.enabled_label")
                        : t("server_settings.disabled_label")
                    }
                    tone={indexer.Enabled ? "success" : "neutral"}
                    size='sm'
                  />
                  <Pressable
                    onPress={() => void remove(indexer)}
                    hitSlop={8}
                    accessibilityRole='button'
                    accessibilityLabel={t(
                      "server_settings.indexers_remove_action",
                      {
                        name: indexer.Name,
                      },
                    )}
                  >
                    <Text tone='danger' weight='semibold'>
                      {t("common.remove")}
                    </Text>
                  </Pressable>
                </View>
              </ListItem>
            ))}
          </ListGroup>
        )}
      </QueryState>
    </View>
  );
}
