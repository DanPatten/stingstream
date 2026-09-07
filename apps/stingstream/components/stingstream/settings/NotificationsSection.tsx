import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { radius, tokens } from "@/constants/theme";
import type { NotificationSettings } from "@/lib/stingstream/hooks";
import { ScreenHeaderRow } from "../shared/ScreenHeaderRow";
import { SaveBar, ToggleRow } from "./fields";

export function NotificationsSection({
  value,
  onSave,
  saving,
}: {
  value: NotificationSettings;
  onSave: (next: NotificationSettings) => Promise<void>;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const dirty = JSON.stringify(draft) !== JSON.stringify(value);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");

  const events: { key: keyof NotificationSettings; label: string }[] = [
    { key: "OnGrab", label: t("server_settings.notifications_on_grab") },
    { key: "OnDownload", label: t("server_settings.notifications_on_import") },
    { key: "OnUpgrade", label: t("server_settings.notifications_on_upgrade") },
    { key: "OnRename", label: t("server_settings.notifications_on_rename") },
    { key: "OnDelete", label: t("server_settings.notifications_on_delete") },
  ];

  return (
    <View>
      <ScreenHeaderRow title={t("server_settings.notifications_title")} />
      <ListGroup title={t("server_settings.notifications_webhook_group_title")}>
        <ToggleRow
          title={t("server_settings.notifications_enabled_title")}
          value={draft.WebhookEnabled ?? false}
          onValueChange={(v) => setDraft((d) => ({ ...d, WebhookEnabled: v }))}
        />
        {events.map((e) => (
          <ToggleRow
            key={e.key}
            title={e.label}
            value={(draft[e.key] as boolean) ?? false}
            onValueChange={(v) => setDraft((d) => ({ ...d, [e.key]: v }))}
          />
        ))}
      </ListGroup>

      <View style={{ height: 12 }} />

      <ListGroup title={t("server_settings.notifications_extra_group_title")}>
        {(draft.Extra ?? []).map((wh, i) => (
          <ListItem
            key={wh.Id ?? i}
            title={
              wh.Name ||
              wh.Url ||
              t("server_settings.notifications_webhook_fallback_name")
            }
            subtitle={
              wh.Enabled
                ? t("server_settings.notifications_enabled_label")
                : t("server_settings.notifications_disabled_label")
            }
            onPress={() =>
              setDraft((d) => ({
                ...d,
                Extra: (d.Extra ?? []).filter((_, idx) => idx !== i),
              }))
            }
            textColor='red'
          >
            <Text tone='danger'>{t("common.remove")}</Text>
          </ListItem>
        ))}
        {(draft.Extra ?? []).length === 0 && (
          <ListItem
            title={t("server_settings.notifications_none_configured")}
          />
        )}
      </ListGroup>

      <View
        style={{
          borderRadius: radius.lg,
          backgroundColor: tokens.color.bg["1"],
          padding: 16,
          marginTop: 12,
        }}
      >
        <Input
          placeholder={t("server_settings.notifications_name_placeholder")}
          value={newName}
          onChangeText={setNewName}
          style={{ marginBottom: 8 }}
        />
        <Input
          placeholder={t("server_settings.notifications_url_placeholder")}
          autoCapitalize='none'
          value={newUrl}
          onChangeText={setNewUrl}
          style={{ marginBottom: 12 }}
        />
        <Button
          variant='secondary'
          onPress={() => {
            if (!newUrl.trim()) {
              toast.error(t("server_settings.notifications_url_required"));
              return;
            }
            setDraft((d) => ({
              ...d,
              Extra: [
                ...(d.Extra ?? []),
                {
                  Id: `${Date.now()}`,
                  Name: newName.trim() || newUrl.trim(),
                  Url: newUrl.trim(),
                  Method: 1,
                  Enabled: true,
                },
              ],
            }));
            setNewName("");
            setNewUrl("");
          }}
        >
          {t("server_settings.notifications_add_webhook_action")}
        </Button>
      </View>

      <SaveBar
        dirty={dirty}
        saving={saving}
        onDiscard={() => setDraft(value)}
        onSave={async () => {
          try {
            await onSave(draft);
            toast.success(t("server_settings.notifications_save_success"));
          } catch (err) {
            toast.error(
              err instanceof Error
                ? err.message
                : t("server_settings.save_error"),
            );
          }
        }}
      />
    </View>
  );
}
