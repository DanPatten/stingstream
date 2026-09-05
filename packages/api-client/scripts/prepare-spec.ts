/**
 * `openapi-typescript` validates the spec with Redocly before generating,
 * which enforces globally-unique `operationId`s (correctly, per the OpenAPI
 * spec). StingStream.Core's ASP.NET controllers each have their own `Get`
 * action (Settings.Get, Status.Get, ...), so the generated document repeats
 * `operationId: "Get"` across paths and generation fails outright.
 *
 * This is a client-side, non-lossy workaround: prefix every operationId with
 * its controller tag before handing the spec to the generator. It only
 * affects the named `operations` interface openapi-typescript can produce;
 * the `paths` interface (what `openapi-fetch` actually keys requests on) is
 * indexed by URL and method, never by operationId, so this has zero effect
 * on how the generated client is called. Fixing the duplication server-side
 * is server code (StingStream.Core), out of scope here — see
 * docs/UI-API-GAPS.md.
 */
export function dedupeOperationIds(spec: any): any {
  const seen = new Map<string, number>();
  for (const pathItem of Object.values(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(
      pathItem as Record<string, any>,
    )) {
      if (
        !operation ||
        typeof operation !== "object" ||
        !("operationId" in operation)
      ) {
        continue;
      }
      const tag: string = operation.tags?.[0] ?? method;
      const base = `${tag}_${operation.operationId}`;
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      operation.operationId = count === 0 ? base : `${base}_${count}`;
    }
  }
  return spec;
}
