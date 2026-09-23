# Mark as Played Flow

**Date**: 2026-01-10, rewritten 2026-09-23
**Category**: state-management
**Key files**: `hooks/useSetWatched.ts`, `utils/watched.ts`, `hooks/useMarkAsPlayed.ts`

## Detail

Every watched/unwatched control (the title page check and "..." row, `PlayedStatus`, the card
menu `ItemCardMenu`, the native action sheet, the TV long press) goes through
`useSetWatched()` → `usePlaybackManager().markItemPlayed/markItemUnplayed`. `useMarkAsPlayed(items)`
is the same hook bound to a component's items.

It patches every cached query that holds a copy of an affected item before the request
(`patchWatchedInData`: the item, and episodes inside a marked show or season), rolls back on
failure, and then invalidates `watchedInvalidationKeys(items)`. A new screen whose cards show a
watched state needs its query key prefix in that list, or its badges go stale until a refetch.

The server recurses for a Series or Season, so send the container, not its episodes.
