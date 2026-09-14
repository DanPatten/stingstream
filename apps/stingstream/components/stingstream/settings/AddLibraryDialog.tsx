import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { FormError } from "@/components/common/FormError";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { FilterChip } from "@/components/filters/FilterChip";
import { space } from "@/constants/theme";
import {
  type LibraryCreate,
  LibraryPathError,
  type LibraryProblem,
  useCreateLibrary,
} from "@/lib/stingstream/libraries";
import { FolderBrowserDialog } from "./FolderBrowserDialog";
import { FolderList } from "./FolderList";

type AddType = LibraryCreate["type"];

/**
 * A new library: what kind, what it is called, and its folders.
 *
 * Recordings is one of the kinds rather than a row every node starts with (Dan, 2026-09-13), so it
 * is offered here only while this node does not already have it. It takes no name and one folder:
 * where this node's own recordings are written. Leaving that empty keeps the default.
 *
 * A dialog that creates something is the one place a settings screen has a submit button.
 */
export function AddLibraryDialog({
  visible,
  offerRecordings,
  onClose,
}: {
  visible: boolean;
  offerRecordings: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Dialog visible={visible} onClose={onClose} title={t("libraries.add")}>
      {visible ? (
        <AddLibraryBody offerRecordings={offerRecordings} onClose={onClose} />
      ) : null}
    </Dialog>
  );
}

function AddLibraryBody({
  offerRecordings,
  onClose,
}: {
  offerRecordings: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const create = useCreateLibrary();
  const [type, setType] = useState<AddType>("movies");
  const [name, setName] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [problem, setProblem] = useState<LibraryProblem | null>(null);

  const recordings = type === "recordings";
  const types: { key: AddType; label: string }[] = [
    { key: "movies", label: t("libraries.type_movies") },
    { key: "tvshows", label: t("libraries.type_tvshows") },
    ...(offerRecordings
      ? [{ key: "recordings" as const, label: t("libraries.type_recordings") }]
      : []),
  ];

  const ready = recordings || (name.trim().length > 0 && paths.length > 0);

  const submit = () => {
    setProblem(null);
    create.mutate(
      { name: recordings ? "" : name.trim(), type, paths },
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

  const addPath = (path: string) => {
    setBrowsing(false);
    setProblem(null);
    setPaths((current) =>
      recordings
        ? [path]
        : current.some((p) => p.toLowerCase() === path.toLowerCase())
          ? current
          : [...current, path],
    );
  };

  return (
    <View style={{ gap: space["4"] }}>
      <View style={{ gap: space["2"] }}>
        <Label>{t("libraries.type_title")}</Label>
        <View
          style={{ flexDirection: "row", flexWrap: "wrap", gap: space["2"] }}
        >
          {types.map((option) => (
            <FilterChip
              key={option.key}
              label={option.label}
              active={type === option.key}
              onPress={() => {
                setType(option.key);
                setProblem(null);
                if (option.key === "recordings") setPaths((p) => p.slice(0, 1));
              }}
            />
          ))}
        </View>
      </View>

      {recordings ? null : (
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
      )}

      <View style={{ gap: space["2"] }}>
        <Label>{t("libraries.folders_title")}</Label>
        <FolderList
          paths={paths}
          disabled={create.isPending}
          onRemove={(path) =>
            setPaths((current) => current.filter((p) => p !== path))
          }
          onAdd={
            recordings && paths.length > 0 ? undefined : () => setBrowsing(true)
          }
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
        initialPath={paths[paths.length - 1]}
        onClose={() => setBrowsing(false)}
        onSelect={addPath}
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
