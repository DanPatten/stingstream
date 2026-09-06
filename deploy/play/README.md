# Play Store listing

Everything Google asks for, written out so it can be pasted rather than composed under time
pressure, plus the list of things only Dan can do.

**Nothing here has been submitted.** No Play Console account has been created, no app identity has
been registered, nothing has been uploaded. This is preparation, and §7 is the part that needs a
person.

Two listings, one app. `org.stingstream.app` ships to phones and to Google TV / Android TV from the
same package; Play treats the TV form factor as a separate *listing surface* on the same app entry,
not as a separate app, so the store text below is written once and the TV-specific fields are called
out where they differ.

| File | What it is |
|---|---|
| `store-listing.md` | Short description, full description, feature list, what's-new text |
| `content-rating.md` | Every question in Google's IARC questionnaire, with the answer and why |
| `data-safety.md` | The Data Safety declaration, form section by form section |
| `privacy-policy.md` | The privacy policy, ready to host on GitHub Pages |
| `checklist.md` | What Dan has to do in Play Console, in order |

---

## The one thing that shapes all of it

**StingStream collects nothing.** There is no analytics SDK, no crash reporter, no advertising id,
no account with us — there is no "us" to have an account with. The app talks to three kinds of place
and nowhere else:

1. **The user's own node**, which is a computer they installed our server on. Everything is there:
   their account, their library, their watch history.
2. **Their group's coordinator**, if the group has one. Optional. It sees node ids and IP addresses
   so that two nodes can find each other; it never sees a group id, a title, or any content.
3. **Public relays** — n0's, by default — which carry encrypted packets between nodes that cannot
   reach each other directly, and can read none of it.

Google's Data Safety form has no box for "nothing leaves the device except to a server the user
owns", so `data-safety.md` walks through how each question is answered and why. The honest answer to
most of them is "not collected", and the place that needs care is **Data shared**, because the
coordinator and the relays are third parties in Google's sense even though they are infrastructure
rather than a business relationship.

## The one thing that will get it rejected if it is not handled

**A media app that plays whatever the user's own server holds.** Google is fine with this — it is
what Plex, Jellyfin, Emby, VLC and Kodi all are — but the listing must not read as though we supply
the content, and it must not name or imply any source of copyrighted material. The descriptions in
`store-listing.md` are written to that line: StingStream is a player and a server for **your own**
media library, shared with **people you invite**. No indexers are named. No content is named. The
download features are described as what they are — a download client you point at services you
already subscribe to.

`checklist.md` §6 has the specific declarations this drives.
