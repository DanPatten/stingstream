import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Icon } from "@/components/common/Icon";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { type RequestReason, reasonsFor } from "@/lib/stingstream/requestsApi";

/**
 * How long a note may be.
 *
 * One line, because the field is one line: `Input` draws a fixed-height box, so anything longer
 * scrolls out of sight while it is being typed. Long enough for what somebody actually writes here
 * ("audio is out of sync from season 2") and short enough that a request card can show it whole
 * rather than truncating the half that mattered.
 */
const REASON_NOTE_MAX = 120;

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
  note,
  onNoteChange,
}: {
  kind: "movie" | "series";
  value: RequestReason | null;
  onChange: (reason: RequestReason) => void;
  note: string;
  onNoteChange: (note: string) => void;
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

      {/*
        Only once a reason is chosen, and never required. The three reasons carry the part an
        administrator can act on; this is for the half a list cannot hold -- which episode, which
        track, what is actually wrong with the encode. Asking for it before a reason is picked would
        be asking somebody to explain something they have not said yet, and requiring it would put a
        writing task in front of a button that already works.
      */}
      {value ? (
        <View style={{ marginTop: 12 }}>
          <Input
            placeholder={t("requests.reason_note_placeholder")}
            value={note}
            onChangeText={onNoteChange}
            maxLength={REASON_NOTE_MAX}
            autoCapitalize='sentences'
            returnKeyType='done'
          />
        </View>
      ) : null}
    </View>
  );
}
