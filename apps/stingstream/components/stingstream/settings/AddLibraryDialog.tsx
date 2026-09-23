import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { FormError } from "@/components/common/FormError";
import type { IconName } from "@/components/common/Icon";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { FilterChip } from "@/components/filters/FilterChip";
import { space } from "@/constants/theme";
import {
  LibraryPathError,
  type LibraryProblem,
  type LibraryType,
  useCreateLibrary,
} from "@/lib/stingstream/libraries";
import { FolderBrowserDialog } from "./FolderBrowserDialog";
import { FolderList } from "./FolderList";

/** The kinds a reader can add, in the order they are offered. */
const TYPES: { key: LibraryType; labelKey: string; icon: IconName }[] = [
  { key: "movies", labelKey: "libraries.type_movies", icon: "movies" },
  { key: "tvshows", labelKey: "libraries.type_tvshows", icon: "tvShows" },
  {
    key: "homevideos",
    labelKey: "libraries.type_homevideos",
    icon: "otherVideos",
  },
];

/**
 * A new library: what kind, what it is called, and its folders.
 *
 * Recordings is not one of the kinds any more (Dan, 2026-09-14); Other videos took its place. A node
 * that already has Recordings keeps it, and `POST /libraries` still accepts the type, which
 * `tools/e2e-m7.ps1` relies on.
 *
 * A dialog that creates something is the one place a settings screen has a submit button.
 */
export function AddLibraryDialog({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Dialog visible={visible} onClose={onClose} title={t("libraries.add")}>
      {visible ? <AddLibraryBody onClose={onClose} /> : null}
    </Dialog>
  );
}

function AddLibraryBody({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const create = useCreateLibrary();
  const [type, setType] = useState<LibraryType>("movies");
  const [name, setName] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [problem, setProblem] = useState<LibraryProblem | null>(null);

  const ready = name.trim().length > 0 && paths.length > 0;

  const submit = () => {
    setProblem(null);
    create.mutate(
      { name: name.trim(), type, paths },
      {
        onSuccess: () => {
          toast.success(t("libraries.added"));
          onClose();
        },
        onError: (err) =>
          setProblem(
            err instanceof LibraryPathError
              ? err.problem
              : { error: err.message, code: "", field: "" },
          ),
      },
    );
  };

  // The dialog has already refused a folder that collides with one in `paths`, and says so, so
  // this only has to take it. The node checks the whole set again when the library is created.
  const addPath = (path: string) => {
    setProblem(null);
    setPaths((current) => [...current, path]);
  };

  return (
    <View style={{ gap: space["4"] }}>
      <View style={{ gap: space["2"] }}>
        <Label>{t("libraries.type_title")}</Label>
        <View
          style={{ flexDirection: "row", flexWrap: "wrap", gap: space["2"] }}
        >
          {TYPES.map((option) => (
            <FilterChip
              key={option.key}
              testID={`library-type-${option.key}`}
              label={t(option.labelKey)}
              icon={option.icon}
              iconPosition='start'
              active={type === option.key}
              onPress={() => {
                setType(option.key);
                setProblem(null);
              }}
            />
          ))}
        </View>
      </View>

      <View style={{ gap: space["2"] }}>
        <Label>{t("libraries.name_title")}</Label>
        <Input
          testID='library-name'
          placeholder={t("libraries.name_placeholder")}
          value={name}
          onChangeText={(v) => {
            setName(v);
            if (problem?.field === "name") setProblem(null);
          }}
          error={problem?.field === "name" ? problem.error : null}
          editable={!create.isPending}
        />
      </View>

      <View style={{ gap: space["2"] }}>
        <Label>{t("libraries.folders_title")}</Label>
        <FolderList
          paths={paths}
          disabled={create.isPending}
          onRemove={(path) =>
            setPaths((current) => current.filter((p) => p !== path))
          }
          onAdd={() => setBrowsing(true)}
        />
      </View>

      <FormError
        message={problem && problem.field !== "name" ? problem.error : null}
      />

      <View
        style={{
          flexDirection: "row",
          justifyContent: "flex-end",
          gap: space["2"],
        }}
      >
        <Button variant='ghost' size='md' onPress={onClose}>
          {t("libraries.cancel")}
        </Button>
        <Button
          testID='library-create'
          variant='primary'
          size='md'
          loading={create.isPending}
          disabled={!ready || create.isPending}
          onPress={submit}
        >
          {t("libraries.add_action")}
        </Button>
      </View>

      <FolderBrowserDialog
        visible={browsing}
        existing={paths}
        onClose={() => setBrowsing(false)}
        onAdd={addPath}
      />
    </View>
  );
}

function Label({ children }: { children: string }) {
  return (
    <Text variant='caption' tone='secondary' weight='medium'>
      {children}
    </Text>
  );
}
