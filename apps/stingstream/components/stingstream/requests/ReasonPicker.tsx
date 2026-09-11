import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { type RequestReason, reasonsFor } from "@/lib/stingstream/requestsApi";

/**
 * Why somebody wants a title the library already has.
 *
 * Shown only when the group already holds what was asked for, which is the one moment the question
 * is worth asking: the copy may be missing an episode, may be a poor encode, or a better release
 * may exist. Without it, asking for something already on the shelf quietly did nothing at all.
 *
 * Single select, and the sheet will not submit until one is chosen. Deliberately the same list
 * shape as the policy screen's modes rather than a control of its own, because a reader has met it
 * already and there is nothing novel happening here.
 */
export function ReasonPicker({
  kind,
  value,
  onChange,
}: {
  kind: "movie" | "series";
  value: RequestReason | null;
  onChange: (reason: RequestReason) => void;
}) {
  const { t } = useTranslation();

  return (
    <View style={{ marginTop: 16 }}>
      <Text variant='body' weight='semibold' style={{ marginBottom: 8 }}>
        {t("requests.duplicate_reason_label")}
      </Text>
      <ListGroup>
        {reasonsFor(kind).map((reason) => (
          <ListItem
            key={reason}
            title={t(`requests.reason_${reason}`)}
            onPress={() => onChange(reason)}
          >
            {value === reason ? <Icon name='check' tone='accent' /> : null}
          </ListItem>
        ))}
      </ListGroup>
    </View>
  );
}
