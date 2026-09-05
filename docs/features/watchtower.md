# Watchtower

Watchtower keeps titles on your lists **ready**: each is pre-resolved to a healthy release and re-verified over time — the same ranking and health checks as Watchdog, run ahead of demand.

**Pointer-only.** It stores segment maps and shortlists (kilobytes), not video. Nothing downloads until playback is requested.

## Loops

```mermaid
flowchart LR
  Sync[Sync_lists] --> Resolve[Resolve_winners]
  Resolve --> Keep[Keep_fresh_STAT]
  Keep -->|dead| Resolve
```

1. **Sync** — enumerate enabled sources into a deduped wanted set.
2. **Resolve** — search, filter by size/grabs, STAT-verify, keep shortlist; bounded by daily budget and warm-set cap.
3. **Keep-fresh** — re-STAT winners without grabbing; promote backups or re-resolve.

## Sources

- Manual IMDb ids on the Watchtower page
- Stremio catalog URLs
- URL lists (JSON or newline ids)
- Whole series (expanded via TVmaze / Kitsu where supported)

## Safety

Reuses indexer hit trackers and rate limiters. Off until enabled; conservative defaults. Configure under [Watchtower settings](../configuration/watchtower.md).

## Status notes

Movies, episodes, and series expansion are supported for common id namespaces; some catalog ids are accepted but not yet expanded. Cross-namespace dedup is a follow-up.
