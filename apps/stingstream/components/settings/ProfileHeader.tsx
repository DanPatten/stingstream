import * as Application from "expo-application";
import Constants from "expo-constants";
import { useAtom } from "jotai";
import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { Pill } from "@/components/common/Pill";
import { Image } from "@/components/common/ServerImage";
import { Skeleton } from "@/components/common/Skeleton";
import { Text } from "@/components/common/Text";
import { useServerName } from "@/hooks/useServerName";
import { useTheme } from "@/hooks/useTheme";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import { getUserImageUrl } from "@/utils/jellyfin/image/getUserImageUrl";
import { formatVersionLabel, pickVersion } from "./appVersionLabel";

const AVATAR_SIZE = 64;

/** Read a native/config accessor defensively — a version string must never crash Settings. */
const safeRead = <T,>(fn: () => T | null | undefined): T | null => {
  try {
    return fn() ?? null;
  } catch {
    return null;
  }
};

/**
 * "v0.2.0 (2)" on native, "v0.2.0" on web — the marketing version plus a build number where one
 * actually exists. The formatting itself (`formatVersionLabel`) and the candidate-picking
 * (`pickVersion`) live in `appVersionLabel.ts`, free of these platform imports, and are unit
 * tested there; this function only supplies the candidates.
 *
 * `expo-application`'s native module has no web implementation, so `Application.
 * nativeApplicationVersion`/`nativeBuildVersion` come back `null` there. The row this replaces
 * papered over that gap with `utils/version.ts`'s graduated dev/CI string (branch, commit, a
 * CI-only run number meant for a build artifact, not a phone-in-hand user) — on web that run
 * number surfaced as a plain object rather than a string, and the row printed the literal text
 * "#[object Object]" (F-30).
 *
 * Web reads three candidates, in order, and never falls back to a literal:
 *  1. `Constants.expoConfig?.version` — the documented API, mirrors `app.json`.
 *  2. `Constants.manifest?.version` — `expo-constants`'s *web* implementation
 *     (`ExponentConstants.web.ts`) actually returns the whole `app.json`-shaped object here
 *     (`process.env.APP_MANIFEST`), even though its TS type describes the native embedded-manifest
 *     shape, which has no `version` — hence the cast.
 *  3. `process.env.EXPO_PUBLIC_APP_VERSION` — set by `app.config.ts` from the exact config that
 *     export resolved. Both 1 and 2 are baked in at Metro bundle time from `app.json` by
 *     `babel-preset-expo`'s own injection, and persistent-cache staleness there is a real,
 *     observed failure mode: a version bump landing in `app.json` and a later `expo export
 *     --platform web` still reading the old version through both of them (F-30 follow-up).
 *     `EXPO_PUBLIC_*` goes through Expo's separate, single-purpose inline-env-var transform, so it
 *     is never behind that same cache.
 *
 * There is no web equivalent of `versionCode`/`buildNumber` — confirmed live: `expo export
 * --platform web` does not embed `app.json`'s `android`/`ios` blocks into the bundle at all, so
 * `Constants.expoConfig.android` is always `undefined` there — so the web string never grows a
 * parenthetical rather than fabricating one from a field that does not exist for this platform.
 */
export function appVersionLabel(): string {
  const web = Platform.OS === "web";
  const version = web
    ? pickVersion([
        Constants.expoConfig?.version,
        (Constants.manifest as { version?: string } | null)?.version,
        process.env.EXPO_PUBLIC_APP_VERSION,
      ])
    : pickVersion([
        safeRead(() => Application.nativeApplicationVersion),
        Constants.expoConfig?.version,
      ]);
  const build = web ? null : safeRead(() => Application.nativeBuildVersion);

  return formatVersionLabel(version, build);
}

const initialsFor = (name?: string | null): string => {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
};

/**
 * A handful of shapes that are a hostname or a placeholder, never a name someone chose — a raw
 * IPv4, an mDNS `.local` name, or one of the literal words a fresh install ships with. The gateway
 * marker (`mesh/crates/stingstream/src/gateway/web.rs`) forwards whatever the admin typed at first
 * run verbatim, and this is the one guard standing between an unconfigured node and a machine
 * hostname on the profile card.
 */
const looksLikeHostnameOrDefault = (name: string): boolean =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(name) ||
  /\.local$/i.test(name) ||
  /^(localhost|server|unknown)$/i.test(name.trim());

/**
 * The Plex-style card at the top of Settings: who you are, on what, and which build.
 *
 * The server label is never derived from a URL, a Jellyfin server name or a machine hostname —
 * only the node marker's own `serverName` (set by the admin at first run) or a generic fallback,
 * so this card can never leak or guess at an upstream product's identity.
 */
export const ProfileHeader: React.FC = () => {
  const { t } = useTranslation();
  const { accent } = useTheme();
  const [api] = useAtom(apiAtom);
  const [user] = useAtom(userAtom);
  const [imageFailed, setImageFailed] = useState(false);
  // Above the early return, not below it. Signing out sets `user` to null, so the skeleton branch
  // rendered one hook fewer than the card did and React threw "Rendered fewer hooks than expected"
  // straight into the error boundary -- every sign-out, on the screen the sign-out button is on.
  //
  // `useServerName` asks the server and falls back to the marker, which is the stale one -- see the
  // hook. `looksLikeHostnameOrDefault` still filters what it hands back, because a name that is
  // really a hostname is worse than the generic word.
  const reportedName = useServerName();
  const serverLabel =
    reportedName && !looksLikeHostnameOrDefault(reportedName)
      ? reportedName
      : t("home.settings.sections.generic_server");

  if (!user) {
    return (
      <View
        testID='settings-profile'
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 12,
        }}
      >
        <Skeleton
          width={AVATAR_SIZE}
          height={AVATAR_SIZE}
          radius={AVATAR_SIZE / 2}
        />
        <View style={{ marginLeft: 14, flex: 1 }}>
          <Skeleton width='55%' height={22} style={{ marginBottom: 8 }} />
          <Skeleton width='35%' height={14} />
        </View>
      </View>
    );
  }

  const serverAddress = api?.basePath;
  const userId = user.Id;
  const primaryImageTag = user.PrimaryImageTag;
  const imageUrl =
    !imageFailed && serverAddress && userId && primaryImageTag
      ? getUserImageUrl({
          serverAddress,
          userId,
          primaryImageTag,
          width: AVATAR_SIZE * 2,
        })
      : null;

  return (
    <View
      testID='settings-profile'
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 12,
      }}
    >
      <View
        style={{
          width: AVATAR_SIZE,
          height: AVATAR_SIZE,
          borderRadius: AVATAR_SIZE / 2,
          backgroundColor: accent[500],
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {imageUrl ? (
          <Image
            source={{ uri: imageUrl }}
            style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }}
            contentFit='cover'
            onError={() => setImageFailed(true)}
          />
        ) : (
          <Text
            variant='heading'
            weight='bold'
            style={{ color: accent.onAccent }}
          >
            {initialsFor(user.Name)}
          </Text>
        )}
      </View>
      <View style={{ marginLeft: 14, flexShrink: 1 }}>
        <Text variant='title' weight='semibold' numberOfLines={1}>
          {user.Name}
        </Text>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            marginTop: 4,
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <Text variant='caption' tone='secondary' numberOfLines={1}>
            {serverLabel}
          </Text>
          <Pill label={appVersionLabel()} tone='neutral' size='sm' />
        </View>
      </View>
    </View>
  );
};
