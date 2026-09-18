/**
 * The shape of `/healthz`, and the one place that reconciles its two forms.
 *
 * Split from `status.ts` for the same reason `downloadingApi.ts` is split from `downloading.ts`:
 * `status.ts` reaches `./client` and from there react-native, which `bun:test` cannot load. The
 * types and the pure normaliser live here so they can be tested; `status.ts` re-exports them so
 * callers still have one import.
 */

export interface HealthzChild {
  name: string;
  enabled: boolean;
  state: string;
  port: number;
  pid?: number;
  restarts: number;
  base_url: string;
  healthy_since?: string;
  last_exit?: string;
  /**
   * Why this child is not running, when the supervisor knows. A missing binary, or a refusal to
   * start something `config.toml` asked for. Absent whenever there is nothing to say, which is
   * most of the time.
   */
  last_error?: string;
  /**
   * The build this child is running, probed by the supervisor when the child
   * first becomes healthy (M4.5). Absent when the child is disabled, has never
   * answered, or has no way to be asked — all real states, not errors.
   */
  version?: string | null;
}

export interface HealthzResponse {
  status: string;
  node: {
    id: string;
    name: string;
    dev: boolean;
    first_run: boolean;
    /**
     * Absent in the redacted document — the node does not tell a caller that is not on its machine
     * where it keeps its files. Typed as required until 2026-09-17, which is how
     * `NodeStatusScreen` came to render `undefined` into a row the moment a reader opened it
     * through a domain.
     */
    data_dir?: string;
  };
  /** Absent in the redacted document, for the same reason as `data_dir`. */
  gateway?: { port: number };
  children: HealthzChild[];
  /**
   * Whether the node answered with the redacted document it gives a caller that is not on its
   * machine, in which case `children` is empty because the node did not say which children it
   * runs — not because it runs none.
   */
  redacted: boolean;
  /** How many children the node reports, which it tells even a stranger. */
  childCount: number;
}

/**
 * `/healthz` answers two different documents, and `children` is a different *type* in each.
 *
 * On the machine it is the list of children. To anybody else the gateway builds a redacted document
 * by hand (`gateway/mod.rs`, `public_health`) where `children` is a **count** — "how many, not
 * which, on which port, at which version". Every caller here read it as the list either way, so a
 * node reached through a domain or a tunnel crashed four screens on `children.find is not a
 * function` rather than degrading.
 *
 * Normalising once, here, is what keeps that from being every caller's problem: past this point
 * `children` is always an array, and `redacted` is how a caller tells "this node runs none" from
 * "this node would not say". They are not the same answer and must not collapse into one — see
 * `useArrReady`.
 */
export function normalizeHealthz(body: unknown): HealthzResponse {
  const doc = (body ?? {}) as Record<string, unknown> & HealthzResponse;
  const children = doc.children as unknown;

  if (Array.isArray(children)) {
    return { ...doc, children, redacted: false, childCount: children.length };
  }
  return {
    ...doc,
    children: [],
    redacted: true,
    childCount: typeof children === "number" ? children : 0,
  };
}
