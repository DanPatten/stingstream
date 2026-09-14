import { useInviteLibraries } from "@/lib/stingstream/invites";
import { LibraryPicker } from "../shared/LibraryPicker";

/**
 * "Choose libraries to share", for the moment a connection is being made.
 *
 * Every library starts selected. `selected` is `null` until somebody touches the list, and `null`
 * is sent as "every library", so a server that adds a library between opening this and pressing
 * Connect shares that one too, which is what an untouched list promised.
 */
export const ShareLibrariesPicker: React.FC<{
  selected: string[] | null;
  onChange: (next: string[]) => void;
  disabled?: boolean;
}> = ({ selected, onChange, disabled = false }) => {
  const libraries = useInviteLibraries();
  const available = libraries.data ?? [];
  const chosen = selected ?? available.map((library) => library.id);

  return (
    <LibraryPicker
      available={available}
      selected={chosen}
      loading={libraries.isPending}
      disabled={disabled}
      onToggle={(id) =>
        onChange(
          chosen.includes(id)
            ? chosen.filter((existing) => existing !== id)
            : [...chosen, id],
        )
      }
    />
  );
};
