# Privacy policy

**This file is the source text for the hosted policy.** Google Play requires a privacy policy at a
public URL before the Data Safety form can be saved, and the URL must stay live for as long as the
app is listed.

**Host it at:** `https://danpatten.github.io/stingstream/privacy`

GitHub Pages from `docs/` on `master` is the least work and has no third-party dependency. See
`checklist.md` §3 for the two-minute setup. Copy everything below the line into
`docs/privacy.md` (or a `gh-pages` branch) with front matter if the theme needs it; do not paste
this explanatory header.

Replace `<CONTACT EMAIL>` with a real address before publishing. Play rejects a policy with a
placeholder in it, and a policy with no contact route is a policy that cannot be complied with.

---

# StingStream — Privacy Policy

**Last updated: 5 September 2026**

## The short version

StingStream does not collect anything about you. There is no account with us, no analytics, no crash
reporting, no advertising identifier, and no server of ours that your library, your viewing or your
searches pass through.

StingStream is software you install on a computer you own. Your data stays on that computer and on
the devices you use to reach it.

## Who "we" are

StingStream is a free and open source project. The software is published at
`https://github.com/DanPatten/stingstream` under the GNU General Public License v3.0. There is no
company, no service and nothing to subscribe to.

Because the software is open source, every claim on this page can be checked against the source
code rather than taken on trust.

## What the app stores on your device

* Your server's address and the credentials you use to sign in to **your own** server.
* Anything you have downloaded for offline viewing.
* Local preferences: which server you last used, playback settings, whether you prefer speed or
  quality when several sources have the same film.
* A **node key** — a cryptographic identity for this device, generated on this device the first time
  you join a group. It is not derived from your phone's hardware identifiers, your Google account or
  anything about you, and it is used only so that other devices in your group can recognise this one.

All of it is removed when you uninstall the app.

## What the app sends, and where

### 1. Your own server

Everything the app does, it does against a StingStream server that **you** installed on a computer
**you** control. Your library, your viewing history, your searches, your requests and your account
all live there. We have no access to it and no way to obtain access to it.

If you do not run a server, the app does nothing at all.

### 2. Your group's coordinator, if your group has one

StingStream lets you pool libraries with people you invite. Two computers in different houses have to
find each other, and if neither is directly reachable, something has to introduce them. That
something is a *coordinator*.

A group may have no coordinator at all — that is the default, and in that mode nothing is sent to
anybody but the other members of your group. If your group does nominate one, it may be a
coordinator you run yourself, or the shared one this project operates.

A coordinator receives, from each member's device:

* the device's **node key** (a public key, as above);
* the device's **IP addresses**, so the other members can connect to it;
* an **encrypted blob** it cannot open, containing that same information for the other members of
  the group.

A coordinator does **not** receive, and cannot work out: the identity of your group, the names of
its members, the titles of anything you hold, or any of your media. The address at which your group
stores its information on a coordinator is derived from your group's secret key, which the
coordinator never sees.

Entries expire fifteen minutes after a device stops refreshing them. Nothing is written to disk.

### 3. Public relays

When two members' computers cannot connect to each other directly — which is common on mobile
networks and behind some home routers — the data travels through a *relay*.

By default these are the free public relays operated by **number 0 (n0)**, whose `iroh` library
StingStream uses for its peer-to-peer networking. Their privacy policy is at
`https://n0.computer/`. You can change which relays are used, or turn them off entirely, in the
app's settings.

A relay carries encrypted packets between two devices. It can see the two devices' node keys and IP
addresses and how much data passed. It cannot read any of it: the encryption is between the two
devices and the relay does not hold the key.

### 4. Nobody else

The app contains no analytics library, no crash reporting service, no advertising network and no
third-party software development kit that reports anything anywhere. It makes no network request to
any address that you have not configured, other than to the relays described above.

## What other members of your group can see

This is worth being plain about, because it is the point of the feature rather than a side effect.

Members of a group you have joined can see:

* the **titles, descriptions, artwork and technical details** of everything your server has chosen
  to share with the group;
* your **node name** — a name you choose for your computer;
* whether your computer is currently online, and roughly how fast the connection to it is;
* your device's **IP address**, because that is how a direct connection is made.

They **cannot** see: your account name, your password, what you have watched, what you have
searched for, what you have requested, or anything on your computer that is not in a shared library.

A group is invite-only. There is no directory, no discovery, and no way for a stranger to find your
server. You choose who is in a group, and any member can remove any other member at any time —
removal is immediate, replaces the group's key, and invalidates every invite code that existed
before it.

## Children

StingStream is not directed at children and is not part of Google Play's Designed for Families
programme. We do not knowingly collect information from anyone, of any age, because we do not
collect information.

## Deleting your data

There is no data of yours held by us to delete. To remove what exists elsewhere:

* **From a group's coordinator** — leave the group in the app. Your entry stops being refreshed and
  is discarded within fifteen minutes. Nothing is kept.
* **From this device** — uninstall the app. Your server address, your downloads and your node key go
  with it.
* **From your own server** — it is your computer; delete what you like. The StingStream server has a
  documented data directory and removing it removes everything.
* **From other members' computers** — ask them, or have someone remove you from the group, after
  which your titles disappear from their libraries within the group's grace period. What they have
  already downloaded is on their disk, exactly as it would be with any file you had sent them.

## Changes to this policy

If this policy changes, the date at the top changes and the previous version stays in the project's
git history, where anybody can see exactly what changed and when. Material changes will be noted in
the release notes of the version that introduces them.

## Contact

`<CONTACT EMAIL>`

Or open an issue at `https://github.com/DanPatten/stingstream/issues`. Please do not put anything
sensitive in a public issue.
