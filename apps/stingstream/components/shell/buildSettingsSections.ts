import type { UserDto } from "@jellyfin/sdk/lib/generated-client/models";

/**
 * Which rows the Settings screen lists, for one account on one platform.
 *
 * Pure for the same reason `buildSidebarItems.ts` is: who sees which settings
 * row is a *rule*, not rendering, and every one of these rules is one somebody
 * will change later. Keeping it out of the component means
 * `buildSettingsSections.test.ts` can pin all of them without rendering React,
 * a navigator or the Jellyfin SDK.
 *
 * The rule that matters most here: **a row that can only fail is worse than no
 * row.** Servers, Plugins and Network all end at screens whose every call needs
 * Jellyfin's `RequiresElevation` policy or configures the server rather than
 * this copy of the app, so a client who opened one got a permission error over
 * an empty page. Same reasoning the sidebar already applies to Users, Manage
 * and Transfers.
 *
 * Hiding a row is not the control, though — it is the courtesy. The gate is
 * `RequiresAdmin` on the route itself, because a URL can be pasted.
 */

export type SettingsRowKind =
  /** Opens a page. `route` is set. */
  | "link"
  /**
   * "This device" — the embedded mesh light node's own status. Not a link, and
   * its detail line is computed at render (`useMeshSummary`), so the builder
   * emits the row and the screen fills in the value.
   */
  | "deviceStatus";

export interface SettingsRow {
  /** Stable identity, for React keys and for assertions. */
  key: string;
  kind: SettingsRowKind;
  label: string;
  /** The grey line under the label, where a row has one. */
  detail?: string;
  /** Where it goes. Present on every `link` row and on no other. */
  route?: string;
  testID?: string;
}

export interface SettingsGroup {
  key: "general" | "sharing" | "server";
  title: string;
  testID: string;
  rows: SettingsRow[];
}

type Translate = (key: string) => string;

const link = (
  key: string,
  route: string,
  label: string,
  extras: Partial<SettingsRow> = {},
): SettingsRow => ({ key, kind: "link", label, route, ...extras });

/**
 * The Settings screen's rows, in order.
 *
 * Everything the screen renders *around* these — the profile header, the
 * language selector, storage, Link device, passkeys, sign out and About — is
 * unconditional or platform-conditional rather than role-conditional, so it
 * stays in the component. This function owns only the part with a rule in it.
 */
export function buildSettingsGroups(
  user: UserDto | null | undefined,
  t: Translate,
): SettingsGroup[] {
  const isAdmin = Boolean(user?.Policy?.IsAdministrator);

  const general: SettingsRow[] = [
    link(
      "appearance",
      "/settings/appearance",
      t("home.settings.appearance.title"),
    ),
    link(
      "playback-controls",
      "/settings/playback-controls",
      t("home.settings.playback_controls.title"),
    ),
    link(
      "audio-subtitles",
      "/settings/audio-subtitles",
      t("home.settings.audio_subtitles.title"),
    ),
    link("music", "/settings/music", t("home.settings.music.title")),
    // Network and Plugins are administration wearing app-settings clothes.
    // Network reports the server's own addresses and Plugins points the client
    // at third-party services (Streamystats, Marlin, KefinTweaks) that are a
    // decision about the install, not about one viewer's phone.
    ...(isAdmin
      ? [
          link(
            "network",
            "/settings/network",
            t("home.settings.network.title"),
          ),
          link(
            "plugins",
            "/settings/plugins",
            t("home.settings.plugins.plugins_title"),
          ),
        ]
      : []),
  ];

  const sharing: SettingsRow[] = [
    // Servers, not "Sharing": what this screen lists is the other people's
    // servers this one pools libraries with. Administrator-only — every mesh
    // route behind it requires elevation, and it was offered to everybody on
    // web, phone and TV until now.
    ...(isAdmin
      ? [
          link(
            "servers",
            "/settings/servers",
            t("home.settings.sections.servers"),
            {
              detail: t("home.settings.sections.servers_hint"),
              testID: "settings-servers",
            },
          ),
        ]
      : []),
    // The counterpart, and the one everybody keeps: the row above is about
    // *this* server, which is the owner's business, and this one is about the
    // server the reader runs, which is theirs. Dan asked for exactly that when
    // the row above went behind the gate.
    link("my-server", "/settings/my-server", t("identity.my_server_title"), {
      detail: t("identity.my_server_hint"),
      testID: "settings-my-server",
    }),
    {
      key: "this-device",
      kind: "deviceStatus",
      label: t("home.settings.sections.this_device"),
    },
  ];

  // The whole group, not row by row: every one of these is elevated, so for a
  // client there is nothing left in it to show a heading above.
  const server: SettingsRow[] = isAdmin
    ? [
        // First, and its own row: who can get in is the question people come
        // here with most, and it used to be a tab behind a screen about
        // transcoding.
        link("users", "/users", t("home.settings.sections.users"), {
          detail: t("home.settings.sections.users_hint"),
          testID: "settings-users",
        }),
        link(
          "server-settings",
          "/settings/server",
          t("home.settings.sections.server_settings"),
          { detail: t("home.settings.sections.server_settings_hint") },
        ),
        link(
          "libraries-and-transcoding",
          "/settings/admin",
          t("home.settings.sections.libraries_and_transcoding"),
          {
            detail: t("home.settings.sections.libraries_and_transcoding_hint"),
          },
        ),
        link(
          "server-status",
          "/settings/node",
          t("home.settings.sections.server_status"),
          { detail: t("home.settings.sections.server_status_hint") },
        ),
        link("logs", "/settings/logs", t("home.settings.logs.logs_title")),
      ]
    : [];

  return [
    {
      key: "general" as const,
      title: t("home.settings.sections.general"),
      testID: "settings-section-general",
      rows: general,
    },
    {
      key: "sharing" as const,
      title: t("home.settings.sections.sharing"),
      testID: "settings-section-sharing",
      rows: sharing,
    },
    {
      key: "server" as const,
      title: t("home.settings.sections.server"),
      testID: "settings-section-server",
      rows: server,
    },
    // A heading with nothing under it is not a section.
  ].filter((group) => group.rows.length > 0);
}

/** Every row, in render order — the shape most assertions want. */
export const flattenSettings = (groups: SettingsGroup[]): SettingsRow[] =>
  groups.flatMap((group) => group.rows);
