# Inviting a person

Two different things are called an invite in this repository, and telling them apart is the first
thing to know.

| | |
|---|---|
| **A server link** | One *server* invited to share with another. A base58 code carrying the group secret, redeemed by a node. `docs/MESH.md` §2. |
| **A person invite** | One *person* invited to watch on your server. A token that creates an account **here**, scoped to the libraries you picked. This document. |

**In the app these are one button.** Dan, on the old screen: *"It needs to be simplier and not a
'group' persay. I want the ability as the server owner to either invite end users (they dont own
another server) or other server owners."* So Sharing shows **People** and **Servers**, and *Invite
someone* asks which of the two you mean — "someone to watch" or "someone who runs StingStream" —
rather than asking about a concept from the transport. The word *group* survives on the wire, in
`group.rs` and in `docs/MESH.md`, and nowhere a person reads.

Both branches ask the same next question, with the same control
(`components/stingstream/shared/LibraryPicker.tsx`): **which of my libraries?** For a person that is
their account's `EnabledFolders`; for a server it is what this node publishes into that link. Dan:
*"Each side picks its own"* — you choose what they see of yours, they choose what you see of theirs,
each on their own server. `StingStream.Core/Sharing/` holds the second, and
`docs/MESH.md` §4 covers how it reaches the other side.

**A link starts closed.** A new server link shares nothing until its owner picks, which is why
accepting an invite lands on that link's own screen rather than a list: the moment you accept is the
one moment you are certainly thinking about what to share back.

They share a link shape and nothing else. `/join` tells them apart by asking the server rather than
by looking at the string — the alphabets overlap, so guessing would be guessing.

| | |
|---|---|
| Server | `server/jellyfin/src/StingStream.Core/Invites/`, `Controllers/InvitesController.cs` |
| App | `apps/stingstream/lib/stingstream/invitesApi.ts`, `app/join.tsx`, `components/stingstream/invites/` |
| Tests | `StingStream.Core.Tests/InviteGateTests.cs`, `lib/stingstream/invitesApi.test.ts` |

---

## 1. What it is for

Dan, choosing the shape of Part 5:

> *"You get invited to a server and you create an account if you never logged in. Then that server
> stores the account. The server is what links other servers together, not the end user client —
> they are just the consumer."*

That sentence removes a question rather than answering it. The question was *where does somebody
with no server of their own sign in*, and Part 4 answered it with a central account service that
Dan then deleted. The better answer is that nobody is in that position: you always have a server —
the one that invited you — and the federated library (M3b) has already materialised everything that
server's mesh can reach into its own Jellyfin. So "sign in and see everything shared with you" needs
nothing central. It is already what a node does.

What was missing was never identity. It was an invite that creates the account.

## 2. What Jellyfin gives, and what it does not

Across servers, Jellyfin has no sharing at all: users are local to one server, with per-library
access through `UserPolicy.EnableAllFolders` / `EnabledFolders`, and the federation request has been
open about five years. That model is **kept**, not replaced. Two things are added to it:

* an invite that creates the account, so nobody has to be given a password by somebody else;
* a library that already contains your friends' servers, which the mesh was doing anyway.

## 3. Decisions

| | |
|---|---|
| Who may invite | **Only an administrator.** Holding an account on somebody's server does not let you hand out accounts on it — that is a decision about their disk, their bandwidth and their library. |
| What an invite grants | **The libraries the inviter picks, per invite.** Not a role, not a default, not everything. |
| How long it lasts | Between a day and a year; seven days if nobody chose. |
| How many people | **One.** An invite is spent by the account it creates. |

## 4. The token

Thirty-two bytes of randomness, URL-safe base64, unpadded — forty-three characters. Unpadded
because a trailing `=` is the character most likely to be eaten by a chat client; 256 bits because
it creates an account and has to be unguessable by somebody who can ask this server about a great
many of them.

**It is stored as a SHA-256 and nothing else.** A copy of `core.db` — a backup, a support bundle, a
disk somebody sold — cannot be turned back into a working invite. Losing the token means minting
another, which is one tap and the correct answer.

**It never touches a URL.** It rides in the link's fragment, which a browser does not send, and both
anonymous routes take it in a request **body**. The obvious shape for "tell me about this invite" is
`GET /invites/{token}`, and it would write a credential that creates an account into this server's
access log, the gateway's, and every proxy in between — where it would outlive the invite by however
long logs are kept. That is why `lookup` is a `POST` that changes nothing.

## 5. Single use and expiry are real here

`docs/MESH.md` and Part 3 of the plan record why single-use and expiry were **dropped** for group
invites: the group secret inside the code *is* the credential, so there is no admitting party and
nobody is in a position to say "that one is spent". A person invite is the opposite — the server
admits, it holds the row, and it decides.

And it decides in SQLite, not in C#. `InviteStore.TryRedeemAsync` is one
`UPDATE ... WHERE redeemed_at IS NULL`, because read-then-write has a window the width of a user
creation and a link in a group chat is exactly the thing that gets opened twice in the same second.
The invite is claimed **before** the account is created and given back if creation fails, so
whoever loses the race is never left holding an account nobody meant to make.

## 6. The trap

`UserPolicy`'s defaults are `EnableAllFolders = true` and `EnabledFolders = []`
(`Jellyfin.Data/UserEntityExtensions.cs`, `AddDefaultPermissions`). **A user created by
`CreateUserAsync` and left alone sees every library.** An invite naming one library out of four
would therefore have handed over all four, silently, looking correct on every screen.
`InviteService.ApplyLibraryScopeAsync` turns it off explicitly and writes the chosen list in its
place.

The policy is also read back before it is written, because `IUserManager.UpdatePolicyAsync` replaces
the **whole** policy: there is no partial update and no `GetPolicy` on the interface, so building a
fresh `UserPolicy` here would silently reset `IsAdministrator`, `EnableMediaPlayback` and
`SyncPlayAccess` to defaults on the way past.

If scoping fails after the account exists, the account is **disabled** rather than left alone. An
administrator finding a disabled account is recoverable; a friend quietly holding access to
libraries nobody shared with them is not.

## 7. Endpoints

All under `/stingstream/api/v1/invites`.

| Route | Who | What |
|---|---|---|
| `GET /libraries` | Admin | Every library on this server, for the picker. Includes the federated "Shared" ones — passing on what a friend shared is a choice, and it is the inviter's |
| `GET /` | Admin | Every invite ever minted, newest first, with its status and the account it created |
| `POST /` | Admin | Mint. `{Label, Libraries[], ExpiresInDays}` → `{Token, Url, Invite}`. **The only time the token is returned** |
| `DELETE /{id}` | Admin | Withdraw. By id, never by token, so withdrawing never means handling the credential again |
| `POST /lookup` | Anonymous | `{Token}` → the server's name, who invited you, and the libraries. `404` for a token nobody minted; `410` with a sentence for one that is spent, expired or withdrawn |
| `POST /accept` | Anonymous | `{Token, Username, Password}` → creates the account, applies the policy, returns a session |

**Why `404` and `410` are told apart.** Distinguishing them reveals that a particular 256-bit string
was once an invite — which requires already holding that string, and whoever holds it is the person
the link was sent to. What it buys them is "ask whoever sent it for a new one" instead of a dead
end. A token that never existed still gets nothing, because there is nobody on the other end of it
to help.

The controller does **not** derive from `StingStreamControllerBase`. It re-declares `[ApiController]`,
`[Route]`, `[Produces]` and `[ApiExplorerSettings]` by hand, exactly as `SetupController` and
`WebhooksController` do — without the last of those these operations vanish from `openapi.json` and
the generated client silently never learns about them.

## 8. Storage

One table, `invites`, in `core.db`. The DDL lives in `InviteStore.EnsureSchema` rather than in
`CoreDatabase.ApplySchema` — `docs/CONTRIBUTING.md` rule 2 — and every statement is
`IF NOT EXISTS`, so `CoreDatabase.SchemaVersion` does not move.

| Column | |
|---|---|
| `id` | Opaque. Safe to show, log and put in a URL; what revocation addresses |
| `token_hash` | SHA-256 of the token, `UNIQUE`. The only form of it on disk |
| `label` | The administrator's own note. Shown to them, never to the invited person |
| `libraries` | JSON array of collection-folder GUIDs |
| `created_by`, `created_by_name` | Who minted it. The name is **copied**, not looked up: a rename should not retroactively change who somebody believes invited them |
| `created_at`, `expires_at` | |
| `redeemed_at`, `redeemed_user`, `redeemed_user_name` | The account it created, or null |
| `revoked_at` | Withdrawn, or null |

Rows are **kept** after an invite is spent. An administrator looking at an account they do not
recognise should be able to find the invite that created it, and this is the only record of that.

## 9. The landing page

`/join` lives **outside** `(auth)`, and that is the whole reason it moved there. A person invite is
opened by definition by somebody who cannot sign in, and inside `(auth)` the session guard sent them
to a login form for an account that does not exist yet. Outside it, the guard's other half would
bounce a *signed-in* visitor to Home and tear the screen down under them — so `useProtectedRoute`
exempts the route by name, the way it already exempts the top-shelf launcher, and the page decides
what each of the two should see.

It reads the fragment **during render**, before any effect can run and before anything navigates,
then asks `POST /invites/lookup`:

* **200** — a person invite. Create-account screen, with the server's name, who invited them, and
  the libraries listed before they are asked for anything.
* **404** — not a person invite. Almost always a group code, so the code is remembered and they are
  sent to the Join screen deep in Settings, which is what this route did before person invites
  existed.
* **410** — it *was* one and cannot be used. The node's own sentence, which already ends in what to
  do next.

## 10. Acceptance

`tools/e2e-invite.ps1` is the harness: server A mints an invite for one library out of two, a cold
client opens the link, creates an account, signs in, sees **only** the shared library, and plays a
film that lives on **server B**. That last hop is the point — it proves the invited person gets the
federated library rather than only A's own files.

`InviteGateTests` covers the decision itself: live, unknown, spent, expired, withdrawn, and the
order they are reported in. There is no HTTP harness in that suite by design (`SetupGate` says why),
which is exactly the reason the decision is a pure static and the controller only calls it.
