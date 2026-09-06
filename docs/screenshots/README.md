# Screenshots

Empty on purpose, for now. This is where the images the README and the Play Store listing point at
belong, and putting the directory in the tree with a note beats a broken link in the README and a
`checklist.md` step that says "find somewhere to put them".

## What is needed, and at what size

The Play Console requirements are the binding ones, because they are the only place an image is
*rejected* rather than merely looking wrong. `deploy/play/store-listing.md` has the full table; the
short version:

| File | Size | Used by |
|---|---|---|
| `icon-512.png` | 512 × 512, 32-bit PNG, **no alpha** | Play listing |
| `feature-graphic.png` | 1024 × 500 | Play listing |
| `phone-library.png` | 9:16, min 320 px on the short edge | README, Play |
| `phone-group.png` | as above | README, Play |
| `phone-playback.png` | as above | Play |
| `phone-downloads.png` | as above | Play |
| `tv-browse.png` | **1920 × 1080 landscape** | Play TV listing (**required**) |
| `tv-playback.png` | 1920 × 1080 | Play TV listing |
| `tv-quickconnect.png` | 1920 × 1080 | Play TV listing |
| `tv-banner.png` | **1280 × 720** | Play TV listing (**required**, and the most commonly missed asset) |

## What to show

The four screens that make the case, in order of how much they explain:

1. **A library with a peer's titles in it.** This is the whole product. It needs to be obvious that
   some of these films are on somebody else's computer and that nothing about them looks different.
2. **The Group screen**, with an invite code and a member list. It is what makes "private" concrete.
3. **Playback**, with the "Play from…" source list open, so the several-holders-one-film idea is
   visible rather than described.
4. **Manage or Downloads**, because "it replaces four programs" is otherwise just a claim.

## Two things to check before publishing any of them

* **No real filenames, no real titles you would not put on a billboard, no real usernames.** A
  screenshot goes on a public store page and stays there. Generate a library of public-domain films
  for these — the acceptance harnesses already make *Big Buck Bunny* and *Sita Sings the Blues*
  clips for exactly this kind of purpose.
* **No invite code, no group id, no node id in full.** An invite code is a live credential
  (`docs/SECURITY.md` §5) and a screenshot of one is a screenshot of a key. Blur it, or take the
  shot with a throwaway group and rotate its secret afterwards.
