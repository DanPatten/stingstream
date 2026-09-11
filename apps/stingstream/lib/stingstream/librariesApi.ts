/**
 * The wire for `/stingstream/api/v1/libraries` — types, shaping, and plain `fetch`.
 *
 * A library is now the whole answer to "what does this server hold, and does it go and get more":
 * its folder is where movies or shows are written, and its switch is what starts the manager that
 * fetches them. `LibrariesController` writes both the settings row and `config.toml` in one call,
 * which is why the app makes one call rather than two and why there is no separate downloading
 * endpoint left to keep in step.
 *
 * **No React here.** The hooks live in `./libraries`, and this half imports nothing that reaches
 * `providers/JellyfinProvider` — whose import graph `bun:test` cannot load at all. Same split as
 * `downloadingApi.ts` / `downloading.ts`, and it is what makes this testable.
 *
 * **Plain `fetch`, not the generated client**, for the same reason `downloadingApi.ts` says: the
 * typed client is regenerated from a node built out of this working tree, which on a shared
 * checkout means picking up whatever other controllers are half-written at that moment. The two
 * paths below are pinned by the controller's own route attribute. Move them onto the typed client
 * the next time that document is regenerated for other reasons.
 */

import { t } from "i18next";
import { markExpectedError } from "@/utils/errors";
import {
  reportSessionExpired,
  SessionExpiredError,
} from "@/utils/sessionExpiry";

const PATH = "/Libraries";

/** What a library type means to the server. Matches `LibraryTypes` on the node. */
export const LIBRARY_TYPES = ["movies", "tvshows"] as const;
export type LibraryType = (typeof LIBRARY_TYPES)[number];

/** One library: what it is called, where it lives, and whether this server runs it. */
export interface Library {
  id: string;
  name: string;
  type: LibraryType | string;
  /** The folders on this server. Empty means "follow the supervisor's default". */
  paths: string[];
  /** Whether this server runs it at all: the library and the manager that fills it. */
  enabled: boolean;
  /** Hidden from readers here. Presentation only: a hidden library still imports and federates. */
  hidden: boolean;
  /** Movies and TV Shows. Never renamed, never removed. */
  builtin: boolean;
  /** Whether this node owns the folders. False for Recordings, which holds only peers' pointers. */
  managed: boolean;
}

/** What to change. An omitted property is left alone. */
export interface LibraryUpdate {
  /** The folder on this server. An empty string means "follow the supervisor's default". */
  path?: string;
  enabled?: boolean;
  hidden?: boolean;
}

/**
 * Why a folder was refused, in the shape the form renders against a field.
 *
 * `code` rather than matching on the sentence: the server owns the wording, and a screen that
 * branched on it would break the first time somebody improved a message.
 */
export interface LibraryProblem {
  error: string;
  code: string;
  field: string;
  conflictsWith?: string | null;
}

/** A refusal that belongs under an input rather than in a toast. */
export class LibraryPathError extends Error {
  readonly problem: LibraryProblem;

  constructor(problem: LibraryProblem) {
    super(problem.error);
    this.problem = problem;
  }
}

const authHeaders = (token?: string | null): Record<string, string> =>
  token ? { Authorization: `MediaBrowser Token="${token}"` } : {};

/**
 * Read a library whichever case it arrives in.
 *
 * StingStream's controllers are hosted inside Jellyfin, whose serializer names properties
 * `Name`/`Paths`/`Enabled` even though this API documents itself as camelCase. `downloadingApi.ts`
 * and `requestsApi.ts` deal with the same split the same way: the casing is a property of whose
 * serializer ran, not of the contract.
 */
const field = <T>(
  raw: Record<string, unknown>,
  name: string,
): T | undefined => {
  const upper = `${name[0].toUpperCase()}${name.slice(1)}`;
  return (raw[name] ?? raw[upper]) as T | undefined;
};

export const toLibrary = (body: unknown): Library => {
  const raw = (body ?? {}) as Record<string, unknown>;
  return {
    id: field<string>(raw, "id") ?? "",
    name: field<string>(raw, "name") ?? "",
    type: field<string>(raw, "type") ?? "movies",
    paths: (field<string[]>(raw, "paths") ?? []).filter(
      (p): p is string => typeof p === "string",
    ),
    // Absent counts as on, matching the node's own default: a row written before the switch
    // existed is a library the server is running.
    enabled: field<boolean>(raw, "enabled") ?? true,
    hidden: field<boolean>(raw, "hidden") ?? false,
    builtin: field<boolean>(raw, "builtin") ?? false,
    managed: field<boolean>(raw, "managed") ?? true,
  };
};

const toProblem = (body: unknown): LibraryProblem | null => {
  const raw = (body ?? {}) as Record<string, unknown>;
  const error = field<string>(raw, "error");
  const code = field<string>(raw, "code");
  if (!error || !code) return null;
  return {
    error,
    code,
    field: field<string>(raw, "field") ?? "path",
    conflictsWith: field<string>(raw, "conflictsWith") ?? null,
  };
};

async function readError(res: Response, what: string): Promise<Error> {
  // Same split as `meshApi`'s own reader: a revoked token ends the session rather than describing a
  // library that could not be read. This reader is separate from that one because it has to turn a
  // ProblemDetails body into a `LibraryPathError`, not because 401 means anything different here.
  if (res.status === 401) {
    reportSessionExpired();
    return markExpectedError(
      new SessionExpiredError(t("server.please_login_again")),
    );
  }
  if (res.status === 403) {
    return markExpectedError(
      new Error(`${what}: ${t("common.no_permission")}`),
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // A body that is not JSON tells us nothing the status has not already.
  }
  const problem = toProblem(body);
  if (problem) return new LibraryPathError(problem);
  const detail = (body as { error?: string; title?: string } | undefined)
    ?.error;
  return new Error(detail || `${what} failed (${res.status})`);
}

/** The path a library actually writes to, or empty when it follows the server's default. */
export const libraryPath = (library: Library): string => library.paths[0] ?? "";

export async function fetchLibraries(
  apiBaseUrl: string,
  accessToken?: string | null,
): Promise<Library[]> {
  const res = await fetch(`${apiBaseUrl}${PATH}`, {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readError(res, "GET /libraries");
  const body = await res.json();
  return Array.isArray(body) ? body.map(toLibrary) : [];
}

export async function saveLibrary(
  apiBaseUrl: string,
  id: string,
  update: LibraryUpdate,
  accessToken?: string | null,
): Promise<Library> {
  const res = await fetch(`${apiBaseUrl}${PATH}/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: {
      ...authHeaders(accessToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(update),
  });
  if (!res.ok) throw await readError(res, "PUT /libraries");
  return toLibrary(await res.json());
}
