# Store listing text

Field names are Google Play Console's. Character limits are Google's and are counted below; do not
paste past them, Console truncates silently in the preview and then rejects on save.

---

## App name (30 characters)

```
StingStream
```

*11 characters. Not "StingStream — Media Server" or similar: the extra words are keyword stuffing,
Play's policy names it, and the icon plus the short description already say what it is.*

---

## Short description (80 characters)

```
One app for your own media server, your downloads, and the group you share with.
```

*79 characters. It has to carry three ideas — it is a player, it is a server, and the sharing is
private — because it is the only text most people read.*

**Alternate, if the first reads as too long a list:**

```
Your media server, your downloads, and your friends' libraries. One app.
```

*71 characters.*

---

## Full description (4000 characters)

```
StingStream is one app for the whole self-hosted media stack. Install the server on a
computer you own, open the app, and everything is in one place: your library, your
downloads, what you want to watch next, and — if you want it — the libraries of the
people you have invited.

No accounts with us. No subscription. No cloud. Your server is your server.


WHAT IT REPLACES

Most people running their own media library end up with four or five programs that do
not know about each other: something to play files, something to find them, something
to download them, and something to manage all of it from the sofa. StingStream is one
install, one interface and one login for all of it.

  • Watch — your whole library, on your phone, your tablet and your TV.
  • Manage — what you are missing, what is on the way, what arrived, what failed.
  • Download — a built-in download engine, or your existing one if you prefer.
  • Share — pool libraries with people you invite, and nobody else.


SHARING, THE WAY IT SHOULD WORK

Create a group. Send someone an invite code. Their titles appear in your library, with
posters, descriptions and quality badges, exactly like your own — because they really
are in your library now, as extra sources for the same film.

Press play and the video streams peer-to-peer, directly from their computer to yours,
encrypted the whole way. Nothing passes through a company's servers. If a direct
connection is not possible, an encrypted relay carries the packets without being able
to read them.

Nothing leaves your group. There is no public directory, no discovery, no browsing
strangers' libraries. A group is people who chose each other.

You can remove someone at any time, and it takes effect immediately: their access ends,
the group's key is replaced, and every invite code that existed before stops working.


ON YOUR TELEVISION

StingStream is built for Google TV and Android TV as well as for phones. Full remote
control support, ten-foot layouts, and pairing without typing a password: your TV shows
a code, you approve it on your phone, and you are in.


OFFLINE

Download anything in your group to your phone and watch it on a plane. Downloads pull
the original file over the mesh, so what you watch offline is what you would have
watched at home.


TOGETHER

Start a watch party and everyone in the group sees the same frame at the same time,
whether they are in the next room or in another country. Pausing pauses it for
everybody.


ALSO IN THE BOX

  • Requests — anyone in the group can ask for something; whoever is best placed to
    fetch it does, automatically.
  • Subtitles in the languages your group has asked for, fetched once and shared.
  • Recordings from a TV tuner, shared like anything else.
  • Cast to a Chromecast, at home or away.
  • Speed-first or quality-first playback, your choice, per person.


WHAT YOU NEED

A computer to run the StingStream server on — Windows, macOS, Linux or Docker. That is
the only requirement. Everything else, including finding your other devices across the
internet, works with nothing hosted anywhere.

StingStream is free and open source software, GPL-3.0. The code is at
github.com/DanPatten/stingstream.


WHAT STINGSTREAM IS NOT

It does not provide any content. It is a player and a server for media you already
have, and a way to share it with people you already know. What you put on your own
server is your business and your responsibility.
```

*About 3 100 characters, leaving room for the store-required legal line if one is added later.*

---

## What's new (500 characters) — first release

```
The first public release.

Watch your own library and your group's on a phone, a tablet or a Google TV. Stream
peer-to-peer, encrypted, with nothing in between. Download for offline, watch together
across the group, cast to a Chromecast, and ask for what you are missing.

Requires the StingStream server on a computer you own: github.com/DanPatten/stingstream
```

*354 characters.*

---

## Feature list (for the "app details" tags and the graphic assets)

Ordered by how much they matter to somebody deciding in eight seconds.

1. **One app for a whole self-hosted media stack** — player, library, downloads, management.
2. **Private group sharing** — pool libraries with people you invite; nothing public, ever.
3. **Peer-to-peer streaming** — direct, encrypted, no company in the middle.
4. **Phone, tablet and Google TV** — one app, ten-foot layout on the television.
5. **Offline downloads** — the original file, watchable on a plane.
6. **Watch together** — synchronised playback across the group.
7. **Requests** — ask for something; the best-placed node fetches it.
8. **Automatic subtitles** in the group's chosen languages.
9. **Chromecast**, at home and away.
10. **Free and open source**, GPL-3.0, no accounts, no telemetry, no subscription.

---

## Graphic assets required

Not written here because they are pictures, but listed so the checklist can point at them. Put them
in `deploy/play/assets/` when they exist; `docs/APP-RELEASE.md` has the branding.

| Asset | Size | Notes |
|---|---|---|
| App icon | 512 × 512 PNG, 32-bit, no alpha | Same mark as the launcher icon |
| Feature graphic | 1024 × 500 PNG or JPEG | No text smaller than the icon; it is scaled down hard |
| Phone screenshots | 2–8, 16:9 or 9:16, min 320 px | Library, a group's shared titles, playback, downloads |
| 7" tablet screenshots | 1–8, optional but improves ranking | |
| 10" tablet screenshots | 1–8, optional | |
| **TV screenshots** | 1–8, **1920 × 1080 landscape, required for the TV listing** | Browse, playback with the remote overlay, QuickConnect pairing |
| **TV banner** | **1280 × 720 PNG, required for the TV listing** | This is the launcher tile on Android TV; it is not optional and the upload is rejected without it |

**The TV banner is the one people forget.** Android TV will not accept an app into the TV listing
without `android:banner` in the manifest *and* a 1280 × 720 banner in Console, and the error message
does not say which is missing.

---

## Category and tags

| Field | Value |
|---|---|
| App or game | App |
| Category | **Video Players & Editors** |
| Tags | Media player, Video streaming, Home entertainment |
| Contains ads | **No** |
| In-app purchases | **No** |
| Target audience | 13+ (see `content-rating.md` for why not "everyone") |

*Not "Entertainment": that category is where streaming services live and invites comparison with
them. Video Players & Editors is where VLC, Plex, Jellyfin and Kodi are, which is the right shelf.*
