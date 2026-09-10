import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Checkbox } from "@/components/common/Checkbox";
import { Text } from "@/components/common/Text";
import { ListItem } from "@/components/list/ListItem";
import { LoadingState } from "./ScreenState";

/** A library, by whichever name the endpoint that listed it uses. */
export interface PickableLibrary {
  id: string;
  name: string;
  collectionType?: string | null;
}

export interface LibraryPickerProps {
  available: PickableLibrary[];
  /** The chosen ids. The whole list, because an absent id is how one is un-chosen. */
  selected: string[];
  onToggle: (id: string) => void;
  loading?: boolean;
  disabled?: boolean;
}

/**
 * "Which of my libraries?" — asked of a person being invited, and of a server being linked to.
 *
 * One component because it is one question. Dan's sharing model has two audiences and the same
 * control serves both: a person invite names the libraries the account will see, and a server link
 * names the libraries that server's users will see. Keeping them identical is the point — somebody
 * who has used one already knows the other.
 */
export const LibraryPicker: React.FC<LibraryPickerProps> = ({
  available,
  selected,
  onToggle,
  loading = false,
  disabled = false,
}) => {
  const { t } = useTranslation();

  if (loading) return <LoadingState rows={3} />;

  if (available.length === 0) {
    return (
      <Text variant='caption' tone='tertiary'>
        {t("invites.libraries_none")}
      </Text>
    );
  }

  return (
    <View style={{ gap: 4 }}>
      {available.map((library) => (
        <LibraryChoice
          key={library.id}
          library={library}
          selected={selected.includes(library.id)}
          disabled={disabled}
          onToggle={() => onToggle(library.id)}
        />
      ))}
    </View>
  );
};

const LibraryChoice: React.FC<{
  library: PickableLibrary;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
}> = ({ library, selected, disabled, onToggle }) => (
  <ListItem
    title={library.name}
    disabled={disabled}
    onPress={onToggle}
    // The row *is* the checkbox, so it says so: a screen reader announces the library's name and
    // whether it is ticked, and the box beside it is decorative.
    //
    // `aria-checked` as well as `accessibilityState`, because this build of react-native-web maps
    // the role and drops the state — the row came out as a checkbox that never said whether it was
    // ticked. The first is what the web reads, the second is what a phone reads.
    accessibilityRole='checkbox'
    accessibilityState={{ checked: selected, disabled }}
    aria-checked={selected}
    iconAfter={<Checkbox checked={selected} disabled={disabled} />}
  />
);
