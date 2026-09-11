import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { ListGroup } from "@/components/list/ListGroup";
import {
  SaveStatus,
  TextFieldRow,
} from "@/components/stingstream/settings/fields";
import { useAutosave } from "@/components/stingstream/settings/useAutosave";
import {
  QueryState,
  stateOf,
} from "@/components/stingstream/shared/ScreenState";
import { space } from "@/constants/theme";
import { SERVER_NAME_QUERY_KEY } from "@/hooks/useServerName";
import {
  useServerConfiguration,
  useUpdateServerConfiguration,
} from "@/lib/stingstream/jellyfinConfig";
import { SettingsPane } from "./SettingsPane";

/**
 * The row for this server on Servers, opened.
 *
 * Every other server in that list is a row you press to manage, and this one used to be the
 * exception: pressing it went to the dashboard, so the one server whose settings you certainly
 * have was the only one with nowhere to go. Dan: *"change Servers -> This server to link to its
 * own settings page where you can change the server name"*.
 *
 * One control, because there is genuinely one thing here that is about the server *as a server*
 * rather than about its network, its storage or its accounts: what it is called. That name is what
 * every other node in a link shows for it and what the sidebar says, and until now the only chance
 * to set it was the setup form on first run.
 */
export const ThisServerPane: React.FC = () => {
  const { t } = useTranslation();
  const query = useServerConfiguration();
  const update = useUpdateServerConfiguration();
  const queryClient = useQueryClient();

  const { draft, set, saving } = useAutosave({
    value: query.data,
    save: async (next) => {
      try {
        // The whole document, never a patch: `updateConfiguration` replaces, so a body of just
        // `ServerName` would reset every other field to its C# default.
        await update.mutateAsync({
          ...next,
          ServerName: next.ServerName?.trim(),
        });
        // The sidebar and the Servers list read the name through a query of their own, which knows
        // nothing about the configuration document it came from.
        await queryClient.invalidateQueries({
          queryKey: SERVER_NAME_QUERY_KEY,
        });
        toast.success(t("sharing.this_server_saved"));
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : t("sharing.this_server_save_failed"),
        );
      }
    },
  });

  return (
    <SettingsPane title={t("sharing.this_server")}>
      <QueryState {...stateOf(query)}>
        {draft ? (
          <View style={{ gap: space["2"] }}>
            <ListGroup>
              <TextFieldRow
                title={t("sharing.this_server_name_title")}
                value={draft.ServerName ?? ""}
                onChangeText={(v) => set((d) => ({ ...d, ServerName: v }))}
              />
            </ListGroup>
            <SaveStatus saving={saving} />
          </View>
        ) : null}
      </QueryState>
    </SettingsPane>
  );
};
