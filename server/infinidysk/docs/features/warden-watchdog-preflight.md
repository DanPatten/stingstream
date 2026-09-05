# Warden, Watchdog, and Preflight

## Watchdog

Playback failover when a release cannot be served: try parallel candidates within a time budget, optional stall failover, and size-variant retention modes.

Enable and tune under [Watchdog settings](../configuration/watchdog.md).

## Preflight

Background warm-up of top search results before the user clicks (**off / light / standard / full**). Warms state used on the hot path so the first play is faster.

[Preflight settings](../configuration/preflight.md)

## Warden

Portable **dead-release** fingerprint ledger. Filter search hits that match known-dead releases; sync remote sources with quorum; optional private GitHub backup of your local list.

Fingerprints only — no credentials. [Warden settings](../configuration/warden.md)

Together with [Watchtower](watchtower.md), these form the readiness and safety layer around search and playback.
