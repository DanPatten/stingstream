import { Redirect, useLocalSearchParams } from "expo-router";

/** One library's page lived at `/settings/storage/<id>` until 2026-09-22. See `../index.tsx`. */
export default function MovedToLibrary() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <Redirect
      href={`/settings/libraries/${encodeURIComponent(id ?? "")}` as never}
    />
  );
}
