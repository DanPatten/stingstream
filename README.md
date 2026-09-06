# StingStream

**Your movies and shows, on every screen you own, shared with the people you choose.**

StingStream is a free app that turns a computer in your home into your own private streaming
service. It plays your films and series on your phone, your tablet, your TV and in a web browser.
It finds and downloads the titles you ask for. And it lets you pool your collection with friends
and family: their films show up in your library, your films show up in theirs, and everything
streams directly between your homes.

There is no company in the middle. No account to create with us, no subscription, no cloud storage,
and nothing you have to rent or host. Two homes with an internet connection are enough.

---

## What you can do

- **Watch anywhere.** Your collection on the sofa, on the train, or in the garden. Pick up where you
  left off on any device.
- **Share with a small circle.** Create a group, send a friend an invite code, and their titles
  appear in your library within seconds, with posters and descriptions, as if they were your own.
  You can remove someone at any time and they lose access immediately.
- **Ask for something new.** Search for a film or a show and add it. StingStream fetches it for you
  and tells you when it's ready. Anyone in your group can make a request; you decide whether
  requests need your approval.
- **Never download twice.** If someone in your group already has a title, you simply watch theirs.
- **Watch together.** Start a film with a friend in another house and stay in sync, with pauses
  and skips shared between you.
- **Take it offline.** Download to your phone and watch on a plane.
- **Use your TV.** A full remote-controlled interface for Google TV and Android TV. Sign in on the
  TV by approving a code on your phone, no typing.
- **Subtitles, sorted.** Pick the languages your group wants and they arrive with the film.

---

## Getting it

Everything is on the **[Releases page](https://github.com/DanPatten/stingstream/releases)**.

| Where it runs | What to download |
|---|---|
| **Windows** (the computer that holds your collection) | `StingStream-Setup-…-win-x64.exe` — a normal installer. It runs in the background and starts with Windows. |
| **Linux** | The `.deb` for Debian and Ubuntu, or the `.AppImage` for anything else. |
| **Docker** | `ghcr.io/danpatten/stingstream-node` — see [`docs/INSTALL.md`](docs/INSTALL.md). |
| **macOS** | A `.tar.gz` for Apple Silicon and Intel Macs. Not yet signed, so macOS will ask you to allow it the first time. |
| **Android phone or tablet** | `stingstream-phone-….apk` |
| **Google TV / Android TV** | `stingstream-tv-….apk` |

The Windows, Linux, Docker and macOS downloads are the **home server** part: install one of those
on the computer where your files live. The Android downloads are the **app**: install it on the
devices you watch on. You can also open the server's address in any web browser and watch there
with nothing installed.

> Currently pre-release. It works end to end and is used daily, but expect rough edges and please
> report anything odd (see below).

---

## Your first five minutes

1. **Install the server** on your home computer and open `http://localhost:8790` in a browser.
2. **Create your account.** This is the only login you will ever need; it lives on your own computer.
3. **Point it at your media**, if you already have some: choose the folders that hold your films
   and shows. They appear in the library with artwork within a few minutes.
4. **Set up downloading**, if you want it: add the sources you use under Settings, and add a film
   to see it arrive.
5. **Install the app** on your phone or TV and enter your server's address. On the TV, approve the
   code it shows from your phone instead of typing.
6. **Invite someone.** Open Groups, create a group, and send the invite code to a friend who has
   done steps one and two. Their library and yours merge; each of you keeps your own account,
   your own history and your own settings.

---

## How sharing works, in plain terms

A **group** is a handful of people who chose each other. Each person keeps their own StingStream
on their own computer. When you join a group, the others' titles are listed in your library, and
when you press play the film streams straight from their computer to your screen, encrypted the
whole way. Nobody's files are copied unless you choose to keep a personal copy.

Groups are private by design. There is no public list, no search for strangers, and no way for
someone outside a group to see what's in it. An invite code is the only way in, and removing a
member also makes every old invite code stop working.

Your watch history, favourites and resume points never leave your own computer.

---

## Do I need to run a server somewhere?

No. Two homes with ordinary internet can form a group with nothing else involved: StingStream
finds the other computer and connects directly, and it uses well-known public relays only when a
direct connection is impossible. If you want, a group can nominate its own helper server for two
extras: joining a group while the person who invited you is offline, and reaching your library from
a plain web browser away from home. Setting one up is documented in
[`deploy/coordinator/README.md`](deploy/coordinator/README.md), but it is optional.

---

## Frequently asked questions

**Is it really free?** Yes. StingStream is open source under the GPL. There is nothing to buy and
no premium tier.

**Where do my files and my account live?** On your own computer, in a folder you control. Nothing
is uploaded to us because there is no "us".

**What does it play?** Almost anything. Files play in their original quality when your device can
handle them, and are converted on the fly when it can't.

**Does it work on iPhone or Apple TV?** Not yet. The web browser works on both in the meantime.

**Does it work on older TV sticks?** It needs a 64-bit device. Google TV, recent Android TVs and
the 4K Fire TV sticks are fine; the oldest 32-bit Fire TV sticks are not supported.

**Can I use my own downloader or an existing collection?** Yes. Point it at folders you already
have, and use the built-in downloading or connect the tools you already run.

**What does StingStream not do?** It does not provide any content. It plays and shares media you
already have, with people you already know.

---

## Help and problems

Something not working? Open an issue on the
[issues page](https://github.com/DanPatten/stingstream/issues) and describe what you did and what
you saw. The server has a **Node status** page in Settings that shows what's running; a screenshot
of it helps a lot.

---

StingStream is free and open source, licensed GPL-3.0-or-later. See [`LICENSE`](LICENSE).
