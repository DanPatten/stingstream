# Inviting a person

Two different things are called an invite in this repository, and telling them apart is the first
thing to know.

| | |
|---|---|
| **A server link** | One *server* sharing with another. A base58 code admitting a node to a group, redeemed by that node. Started by inviting the person who runs it (§11), or from Settings, Servers, *Add server* (§11e). `docs/MESH.md` §2. |
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
| What an invite grants | **The libraries the inviter picks, per invite.** Not a default, not everything. |
| What role it grants | **Watch, or administrator — asked at mint time, defaulting to watch.** Dan: *"when inviting ask if they should be an admin or end user (default end user)"*. An administrator invite names no libraries, because Jellyfin checks `IsAdministrator` before it checks folders and a picker there would be boxes that change nothing. §3b. |
| The username | **The owner sets it, the invited person may change it.** Pre-filled on the landing page; blank means they choose. |
| How long it lasts | **Until somebody deletes it.** No expiry, no short-term links. |
| How many people | **One.** An invite is spent by the account it creates. |
| Ending one | **Delete.** The row goes; the account it created stays. |

## 3a. The link

An invite is a link, and it is now nearly always a link rather than a bare token. Dan: *"After
creating generate A FULL LINK to the server, if no domain is setup use the host's ip address for LAN
and if there is a domain setup then use that instead."*

`InviteService.LinkAsync` answers in that order:

1. **`sharing.public_address`** — the owner's own domain, over HTTPS, works from anywhere.
2. **The side door's `lan-ip-http` candidate** — this machine's address on its own network, over
   plain HTTP. `MintedInvite.UrlIsLan` is true, and the dialog says so with a *Set it up now* that
   opens the address field.
3. **Null** — only for a node bound to loopback with no domain, which is every harness node and
   nobody's real server. The screen shows the bare token.

**The LAN address deliberately does not come from Jellyfin.** `IServerApplicationHost` is already
injected here and `GetApiUrlForLocalAccess` looks like the obvious answer, but it reports
*Jellyfin's* port and `BaseUrl` — and Jellyfin sits behind the gateway on a different port under a
`/jellyfin` prefix. It would produce a URL that looks right and reaches the wrong thing. The side
door's candidate is built by the gateway from its own bound address, which is the one a browser can
open. `MeshStatus.DecodeSideDoor` is Core's first and only reader of that record.

## 3b. The role

An invite creates one of two kinds of person, and the form asks which before it asks anything else.
**The default is *Watch*, and that is the whole point of having a default here**: a link that hands
over the server should never be what somebody gets by not answering a question.

`invites.is_administrator` is `INTEGER NOT NULL DEFAULT 0`, added by the same
`try ALTER TABLE / catch duplicate column name` step the `token` column uses. The default is
load-bearing rather than incidental — every invite minted before the column existed created a
viewer, and an upgrade must not silently promote one.

Three things follow from Jellyfin checking `IsAdministrator` **before** it checks folders:

* `InviteGate.ValidateMint` stops requiring a library for an administrator invite. Requiring one
  would make the inviter answer a question whose answer is then discarded.
* `InviteService.MintAsync` stores an **empty** library list for one, rather than storing the
  picker's value and ignoring it. A row that named libraries it does not grant would make the Users
  screen and the landing page both say something untrue.
* `ApplyLibraryScopeAsync` writes `EnableAllFolders = true` for an administrator and an explicit
  list for a viewer. Both branches are explicit, so a future change to Jellyfin's own defaults
  cannot quietly turn one kind of invite into the other.

`EnableContentDeletion` and `EnableRemoteControlOfOtherUsers` follow the role. They were
unconditionally false, which was right when every invited account was a guest; withholding them from
an administrator would be a role that looks like one and is not.

**The minted dialog says out loud what an administrator link is**, before the link itself. It is not
a confirmation — the question was already asked and answered on the form — it is for the moment
after, when the link is on screen and about to be pasted somewhere. Single use is the only thing
standing behind it.

**One account is never either of them: the owner.** The account that claimed the server at first
run is marked *Owner* on the Users screen instead of *Administrator*, its administrator switch is
locked, and it cannot be deleted. Dan: *"cannot be changed and is the first admin setup, no
transfer support and they are always an admin"*. `setup/admin` writes the id down as it claims the
account — `IUserManager.GetFirstUser` is an unordered `FirstOrDefault`, so it answers correctly
today by accident and is not a thing to rest a permanent fact on — and `GET /users/owner` reads it
back. There is no setter at any level, which is the property worth having: nothing can move it.
`SetupGate.ChooseOwner` is the rule, and a node set up before the id existed falls back to its first
account and records that.

**Changing it afterwards is the Users screen's job, not this one.** `UserDialog` has an
Administrator switch, guarded by `adminChangeBlocked`: you cannot demote yourself, and you cannot
demote the last administrator. Demoting writes `EnableAllFolders = false` with an empty list, so a
former administrator can see nothing until somebody picks — an account that quietly kept every
library after being demoted is the outcome that must not happen.

## 4. The token

Thirty-two bytes of randomness, URL-safe base64, unpadded — forty-three characters. Unpadded
because a trailing `=` is the character most likely to be eaten by a chat client; 256 bits because
it creates an account and has to be unguessable by somebody who can ask this server about a great
many of them.

**It is stored as a SHA-256, and as itself until it is spent.** `token_hash` is what `lookup` and
`accept` match on and the only form that outlives redemption; `invites.token` beside it is what
`GET /{id}/link` re-serves, and it is cleared when the invite is redeemed or the row is deleted.
That is a real, bounded cost — a copy of `core.db` taken while an invite is outstanding contains a
working one — accepted so that somebody can find a link again rather than mint a second. The same
trade, written down in the same words, as `link_requests.code`.

**It never touches a URL.** It rides in the link's fragment, which a browser does not send, and both
anonymous routes take it in a request **body**. The obvious shape for "tell me about this invite" is
`GET /invites/{token}`, and it would write a credential that creates an account into this server's
access log, the gateway's, and every proxy in between — where it would outlive the invite by however
long logs are kept. That is why `lookup` is a `POST` that changes nothing.

## 5. Single use is real here; expiry is gone on purpose

`docs/MESH.md` and Part 3 of the plan record why single-use and expiry were **dropped** for group
invites: the group secret inside the code *is* the credential, so there is no admitting party and
nobody is in a position to say "that one is spent". A person invite is the opposite — the server
admits, it holds the row, and it decides.

**Single use is the property that was ever load-bearing. Expiry was not, and it is gone.** Dan:
*"these all work indefinetly until revoked - no short term links."* An invite works until somebody
deletes it. The argument the old bound was written on — that a link outliving its reason is a
standing offer of an account, sitting in a chat history — is answered better by deleting the link
than by a date nobody chose, since the person who cares is looking at a list of them.

`expires_at` is `TEXT NOT NULL` and this schema has no migration mechanism (§8), so "never" is
stored as `InviteGate.NeverExpires` — a date no invite can outlive — and `InviteGate.IsNever` reads
it back. **Rows minted before this keep their real date and still expire**: dropping the check
outright would bring somebody's long-dead invite back to life, so `InviteStatus.Expired` stays and
simply stops being reachable for anything new.

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
| `GET /libraries` | Admin | Every library on this server, for the picker. There is no separate "Shared" library to include or withhold any more — see the note in §10 |
| `GET /` | Admin | Every invite ever minted, newest first, with its status and the account it created |
| `POST /` | Admin | Mint. `{Label, Libraries[], IsAdministrator}` → `{Token, Url, UrlIsLan, Invite}`. **The only time the token is returned.** `IsAdministrator` absent means false, which is what an older client sends and the reading that grants least |
| `GET /{id}/link` | Admin | The link again, for an invite nobody has redeemed. Re-serves the token, which is why `invites.token` exists at all — see the note in §4 |
| `DELETE /{id}` | Admin | Delete. By id, never by token, so deleting never means handling the credential again. The row is gone |
| `POST /lookup` | Anonymous | `{Token}` → the server's name, who invited you, the username it suggests, and the libraries. `404` for a token nobody minted — **which now includes a deleted one**; `410` with a sentence for one that is spent |
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
| `token_hash` | SHA-256 of the token, `UNIQUE`. The form that outlives redemption, and what `lookup` and `accept` match on |
| `token` | The token itself, while the invite is unredeemed, so `GET /{id}/link` can serve the link again. Cleared on redemption and gone with the row. §4 |
| `label` | The username the invited account arrives with, or empty. **Shown to somebody else** — it stopped being a private note in Part 9, and the landing page pre-fills it |
| `libraries` | JSON array of collection-folder GUIDs. **Empty for an administrator invite**, which grants all of them by role |
| `is_administrator` | Whether it creates an administrator. `NOT NULL DEFAULT 0`, so every row minted before the column existed still creates a viewer. §3b |
| `created_by`, `created_by_name` | Who minted it. The name is **copied**, not looked up: a rename should not retroactively change who somebody believes invited them |
| `created_at` | |
| `expires_at` | `InviteGate.NeverExpires` for everything minted now; a real date on older rows, which still expire |
| `redeemed_at`, `redeemed_user`, `redeemed_user_name` | The account it created, or null |
| `revoked_at` | Set only on rows written before Part 9, when deleting was a soft revoke. Still refused |

Rows are **kept** after an invite is spent, and **deleted outright** when somebody deletes one — not
marked. That was safe to change only because the record of who has access moved: the Sharing screen
reads People from the accounts on this server, so a spent invite is no longer the only trace of the
person it created. Deleting the invite does not touch the account.

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
  existed. A **deleted** invite lands here too, and there is no way for it not to: the row is gone,
  so there is nothing left to say anything more specific with.
* **410** — it *was* one and cannot be used: somebody has already redeemed it, or it is an older
  row that has expired or been withdrawn. The node's own sentence, which already ends in what to do
  next.

## 10. Acceptance

`tools/e2e-invite.ps1` is the harness: server A mints an invite for one library out of two, a cold
client opens the link, creates an account, signs in, sees **only** the library the invite named, and
plays a film that lives on **server B**. That last hop is the point.

**An invite that grants `Movies` grants the group's films, not only this server's.** That follows
from removing the shared/not-shared split: a peer's copy of a title is now another version of an
item in the node's *own* `Movies`, and Jellyfin has no sub-library access control to express
anything narrower. An inviter can still withhold a whole library — the harness proves that, and it
is the assertion the feature turns on — but "my own films but not my friends'" stopped being
expressible. That is the intended reading of "there is no such thing as shared versus not shared":
a title is a title, whoever holds it.

`InviteGateTests` covers the decision itself: live, unknown, spent, expired, withdrawn, the order
they are reported in, and the two halves of the no-expiry change — that a null date means never
rather than the epoch, and that a row minted with a real one still runs out. There is no HTTP harness in that suite by design (`SetupGate` says why),
which is exactly the reason the decision is a pure static and the controller only calls it.

---

## 11. Signing in with a server of your own

The other half of the same invite. Dan: *"during the invite flow offer the option to sign in with
their own server or create an account — signing in with their own server will re-use their same
login on this new server AND submit a request to link their server to this one."*

So `/join` offers two doors. **Create account** is §9 and §10, unchanged. **I already run
StingStream** is this section.

**It is only on `/join`.** It was on the main login screen too, and it had to be while the account
it created had a password nobody knew — signing in with your own server was then the only way back
in, so it needed a permanent door. §11c removed the reason and the door went with it. Dan: *"remove
the 'Sign in with my own server' option on the main login screen — this is only an option when
accepting an invitation."* `/login` is no longer a return target for the handoff either; `/join` is
the only one.

### What proves who they are

An iroh node id **is** an Ed25519 public key. So a node can sign a statement and any other node can
check it against the id the statement names, with no enrolment, no key exchange and nothing stored
on either side beforehand:

```
assertion = Sign_homeNodeKey( DOMAIN || { iss, sub, name, server, aud, nonce, iat, exp } )
```

| Field | Why it is in there |
|---|---|
| `aud` | The target's node id. **The one that matters.** Without it, signing in to somebody's server would hand that server a token that signs you in to every server you can reach |
| `nonce` | Issued by the target, single-use *there*. Only the audience knows what it has spent, so freshness is the audience's to enforce — `IdentityChallenges` holds them, in memory, `Take` removing as it reads |
| `exp` | Five minutes, the window `PasskeyCeremonies` already uses |

`vouch.rs` signs and verifies; `IdentityService` decides. Verification lives in Rust because .NET
has no built-in Ed25519 and Core already delegates every mesh concern over loopback — two
implementations of one signature rule is the thing worth avoiding.

**Their server has to be up to sign in *with it*.** Dan: *"lets just make it so that your server has
to be up to sign in with it to another server."* That is not enforced anywhere; it falls out,
because nobody but their node can produce the signature. It is also why there is no key material on
any device.

It has to be up **once**, though, not every time — §11c is what changed that, and it is the reason
the login screen no longer needs a door.

### Two doors, not one credential

An assertion proves identity and grants nothing. Anybody can run StingStream, so a genuine
assertion from a server nobody here has heard of has to arrive **with an invite** the first time —
otherwise every StingStream server in the world would accept every other one's users.
`IdentityGate.DecideSignIn` is that rule; after the first time the `linked_identities` row is what
lets them back in.

**The account gets a password, and it is one this server cannot read.** §11c. It is never blank:
Jellyfin authenticates a password-less account with an empty password, so leaving it blank would
make every linked account signable-into by name alone — a far worse door than the one this avoids.

The name is theirs, qualified only if it is taken: `sam`, else `sam.loft`. **Not `sam@loft`** —
`SetupGate.ValidateUsername` allows letters, digits, dots, underscores and dashes and nothing else,
and a name our own form would refuse is a name nobody could re-type.

### The redirect, and why it is not a cross-origin call

Nothing posts a password across origins. `/join` sends the browser to **their own** server's
`/authorize`, which signs them in on its own origin, names the server that is asking, and sends
them back with the assertion in the fragment. The alternative — their node accepting credentialed
cross-origin auth from anywhere, with the password typed into a page somebody else's machine served
— is the thing this shape exists to avoid. `utils/identity/handoff.ts` owns both fragments;
`/authorize` is exempted in `useProtectedRoute` for both of `/join`'s reasons.

### 11c. The password, which this server never learns

Dan: *"After a user authenticates to another server they can login with that same username/password
combo going forward even if their server is offline as long as they have logged in at least once
before"* — and the constraint that shapes all of it: *"we need to do this without the OTHER server
knowing what that user's password is but it still can validate it."*

Those are only compatible if the password stops being the password before it leaves the device:

```
salt     = 16 random bytes, made once, on /authorize
verifier = base64url( PBKDF2-HMAC-SHA256( password, salt, 100 000, 32 ) )
```

**The verifier is what the account's password here actually is**, and Jellyfin hashes it again with
its own KDF before storing it. The salt is kept on the `linked_identities` row and handed to anybody
who asks how to sign in as that username, because a client that cannot learn it cannot derive the
value — and then nobody could sign in at all. It is not a secret; what it buys is that one server's
verifier is useless on another, and that a stolen one cannot be turned back into a password cheaply.

`utils/identity/verifier.ts` is the derivation, in two implementations that its test pins against
each other: `crypto.subtle` in a browser, `@noble/hashes` under Hermes. A phone and the same
person's browser have to produce the same verifier or one of them cannot sign in.

**Why the password is typed on `/authorize` even when they are already signed in there.** Because it
is an input, not a check. That page used to bounce a signed-out visitor to `/login` — which dropped
the fragment and left the request unfinishable — and it had no reason to ask a signed-in one for
anything. Now it always asks, always authenticates, and derives from what worked: a verifier built
from a password nobody confirmed is a password nobody can reproduce.

**The order at sign-in.** `loginMutation` asks `POST /identity/signin-method` what to send *before*
sending anything. A definite answer settles it; a `404` means a plain Jellyfin and the password goes
as it always did. A timeout does **not** — falling back there would put the plaintext on the wire for
exactly the account that must never send it, so it fails the sign-in instead.

**And there is no second guess.** Jellyfin locks an account after three failed attempts
(`UserManager.cs`, `0 => 3`), so retrying with the plaintext when the derived value is refused would
lock somebody out in two sign-ins. An administrator's reset on the Users screen calls
`POST /identity/password/derivation/clear` instead, which drops the salt and makes the account an
ordinary one — otherwise the client would go on deriving against a salt the new password was never
run through, and the reset would lock the person out rather than let them in.

**Changing it later.** Signing in with their own server again re-derives and re-sets it, so the two
heal by themselves. When it is only this server's copy that is stale, Settings → *The server I run*
has one field that does the same thing with no round trip, since the derivation is client-side.

What follows from all of this: **the official Jellyfin app cannot sign in to a linked account.** It
sends the plaintext, and the plaintext is not what is stored. That is true of any client that is not
this one.

### 11d. What two real nodes found

None of the four below could be seen on one node, and none of them is a type error. They were found
by running the flow between two nodes on different ports with a browser, which is the only shape
that makes the two origins real.

| | |
|---|---|
| **The address probe could never work** | `SignInWithOwnServer` resolved what you typed with `checkJellyfinServer`, which asks `/System/Info/Public`. That is a **cross-origin** request — the page was served by the server being joined — and a node sends CORS headers on exactly one route. The browser blocked it before the other node saw it, so the flow died on "Nothing answered at that address" for every address that was actually right. It uses `/sidedoor/v1/hello` now, which exists for this question (`docs/SIDEDOOR.md` §4) |
| **The invite never came back** | It went out in the `/authorize` fragment and `parseAuthorizeRequest` read it, but `buildReturnUrl` never put it in the answer. So the first sign-in — the only one that needs an invite — always reached `signin` with none, and the person holding a live invite was told to ask for one. It rides back beside the assertion now |
| **A spent nonce, reported as a dead invite** | The return-leg effect depends on `api?.basePath`, and its own success path changes it by pointing the app at this server. The second run presented the same assertion, was refused because the nonce was spent, and replaced a sign-in that had worked with *"This invite cannot be used"* — the account existed. `presented` is a ref set before the first `await`, so it happens once |
| **A session granted and thrown away** | `adoptSession` captured `api?.basePath` and returned **silently** when it was null — which is exactly the state on a cold cross-origin landing, before `setServer` has run. The server granted a session, the token went nowhere, and the screen sat on "Opening your invite…" or bounced to the sign-in form with nothing said. It reads `api ?? apiRef.current`, which is what that ref was added for and what `login` already did |

The last two are the same shape as the bug `wasSignedIn` above it was written for, and worth
remembering as one rule: **on this screen the work is not idempotent** — a nonce is spent and an
invite is redeemed by the first attempt — so nothing here may run twice, and nothing that has
already succeeded may be abandoned because the effect was torn down.

`tools/e2e-invite.ps1` is the harness for the password half. The identity half is two `ui-node.ps1`
nodes on separate ports and data directories, a person invite minted on one, and a browser.

### Asking to link the two servers

Signing in this way also submits a **request**, and a request is all it is: only an administrator
here decides which servers join their group, which is what keeps §3's first row true. Approving
mints an ordinary single-use mesh invite — there is no second kind of link and no new protocol —
and the code goes back to the person who asked, who finishes it on their own server.

A decline is remembered: the upsert refuses to reset a decided row to pending, so asking again
cannot get a different answer by itself. **"By itself" now means something**, because there is a way
back: `DELETE /identity/link-requests/{issuer}` forgets the row, and the *Requests to link* list
draws declined servers with that one control on them. Until there was one, an administrator who
declined by mistake had shut that server out permanently and the screen showed no trace of it. That
was survivable while being invited was the only way to ask; it is not now that §11e makes asking
something anybody does. It deletes rather than re-opens, so the next ask is a fresh question with a
fresh answer.

### 11e. Add server, which is the same request asked from the other end

The flow above only ever begins on the *other* server. You invite the person who runs it, they sign
in here with it, and the ask arrives. That is right for somebody you are introducing to the product
and it is kept unchanged. It was never a flow for two people who both turn up on this page:

* you already run a second server of your own, and there is nobody to invite;
* you are an ordinary member here who runs a server at home and wants to offer it.

Dan: *"if you are already on a server you may either own a 2nd server or you are an end user who
has their own server. In this case clicking Add Server starts the same workflow as invite: Start by
asking for that other server's address and complete the wizard, same as invite."*

So **Settings → Servers → `+ Add server`** is that wizard, and it is deliberately the same one:
type the other server's address, get sent to its `/authorize`, come back with an assertion. The
only differences are where it starts and what it ends in.

```
Server A (you are here)                         Server B (theirs)
──────────────────────────────────────────────────────────────────────────────
+ Add server
  type B's address, probed with
  /sidedoor/v1/hello, https then http
  POST /identity/challenge on A   ->  nonce + A's node id
  navigate to  ───────────────────────────────>  B/authorize#aud&nonce&return&server&link=1
                                                 sign in on B, consent, Ed25519 sign
  back at  <───────────────────────────────────  A/settings/servers?link_to=<B>#assertion=…
  POST /identity/link-requests/start
    administrator here?  approved as it is asked
    member?              pending, as above
  the panel: a link to open on B, and the libraries this link gets
                                                 <- they open or forward the link
                                              B/join -> B/settings/servers/join
                                                 an administrator there accepts
                                                 and picks what B shares back
```

**`POST /identity/link-requests/start` is the new route**, and it is a member route.
`IdentityGate.DecideLinkStart` is its rule, and the difference from `DecideSignIn` is the whole
reason it is a second decision: **no invite**. `DecideSignIn` demands one the first time because a
genuine assertion from a stranger is not permission to have an account here. Nobody is asking for
an account on this path — they already hold one, the session proves it, and all the assertion adds
is which node is being offered. Requiring an invite as well would mean an administrator needed an
invite to their own server in order to add their second one. A node offering *itself* is refused
outright, because approving a link with yourself mints an invite to your own group and lists this
server twice.

**It writes no `linked_identities` row and accepts no verifier.** `/authorize` derives one whatever
it is asked for, and the app drops it on this path. The caller already has a password on this
server, and quietly replacing it with a derivation of their *other* server's password would change
how they sign in here as a side effect of adding a server.

**An administrator's own offer is approved as it is made.** The pending queue exists so that a
member cannot decide what their server links to; putting that question to the person who answers it
is not a safeguard, it is a second click. A member's offer waits, exactly as §11's does.

**Consent is still required at both ends, and the second one is structural.** Only an administrator
on B can redeem the code: the Accept screen refuses anybody else and `POST /mesh/groups/join` is
`RequiresElevation`. That is why the answer is a link rather than a button — the person who added
the server may not be the person who can accept it, so they send it on.

#### The link, rather than a code to paste

Dan: *"after they enter their server url they should get a URL they can visit to link it (they
either share that link or open it right away - make sure its clickable, authenticate and complete
the link)"*.

It is `https://<their-server>/join#<code>` — `buildInviteLink`, the same shape `sharing::invite_link`
builds, with the code in the fragment for the reason every credential here is. The code has not
changed; what is new is that this flow knows the address to wrap it in, because somebody typed it.
`link_requests.issuer_address` is why it survives to an administrator who never saw it.

Two things had to be fixed for *"authenticate and complete the link"* to be true rather than
aspirational, and both were found by opening the link in a signed-out browser:

| | |
|---|---|
| **The code did not survive signing in** | `/join` stashes a mesh code in a module variable and replaces to `/settings/servers/join`, which is inside `(auth)` — so a signed-out visitor was bounced to `/login`, and after signing in `useProtectedRoute` sent them to Home. The code was still in memory and nothing would ever navigate to the one screen that reads it. The guard now prefers the Accept screen while `hasPendingInvite()` is true. |
| **A member at the far end hit a bare refusal** | `/settings/servers/join` was wrapped in `RequiresAdmin`, so somebody who had been deliberately sent a link got "you do not have permission" and no next step. The gate moved inside `JoinGroupScreen`, which has the code and can hand the link back to forward. |
| **The fragment stayed in the address bar** | `clearFragment()` ran in the return-leg effect and was undone a tick later: the router parses the URL at mount and writes its own back, hash and all. So a spent assertion, and the salt and verifier `/authorize` returns whatever it is asked for, sat in the address bar and the history entry. It is cleared again once the request settles, which is the call that holds. Only visible in a browser. |
| **The panel outlived the job** | An approval is not the end of anything — the code stands until somebody redeems it — so the server goes on reporting one long after the other side has accepted. *Finish linking your server* sat above a list with that very server on it, working. `MyOffer` checks the peer list now. |

#### Who gets handed the code

`IdentityGate.MayHoldTheCode`: an administrator here, or the account the request names. Nobody else,
and the narrowing is load-bearing rather than tidy.

A standing approval can be met again — offering an already-approved server returns its answer, which
is what makes the wizard safe to repeat — and the code is **bearer** while the approval was a
decision about one *server*. Without the rule, a second, ordinary member of that server, anybody who
can get it to vouch for them, could meet the standing approval, be handed the code and redeem it on
a node of their own. That is a link nobody approved. An administrator is exempt because they can
mint another in a tap, so withholding this one buys nothing.

`MyRequest` answers the same question from the other side, and had to learn a second way of asking
it. It found the asker through their `linked_identities` row, which is right for somebody who
arrived from another server and useless for somebody who pressed *Add server* — a local account that
has no such row and never will. It now falls back to `requested_by`. Without that a member could
offer their server, be told it was pending, reload the page and find no trace of it.

#### One link per server

Approving used to put every server into a single group called *Linked servers*, and ask which one
when there was more than one. It now creates a link **named after the asking server**, so that what
this server shares can be chosen per server rather than once for everybody, and so a row on the
Servers page and a link's own page are the same thing. That deleted the question as well as
answering it: with no pool to choose from, *"which of your links should they join?"* has nothing
left to mean, and `ApproveRequestAsync` no longer refuses when there is none or several. An explicit
`GroupId` is still honoured, which is what keeps adding a third server to an existing link possible.

A link it creates and then cannot use — the mint failed, or another administrator won the race to
decide the row — is left again rather than orphaned on the page with nobody in it. Only one it
created: a group the caller named may already hold members.

#### What the panel ends with

The libraries. A link starts closed (`SharedLibraryStore`: a group with no row shares nothing), so
the moment it is made is the one moment its owner is certainly thinking about what to put in it. It
is the same control over the same endpoint as the link's own page, and it stays editable there
afterwards. Each side still picks its own.

| | |
|---|---|
| Mesh | `mesh/crates/stingstream-mesh/src/vouch.rs`, `api.rs` (`/mesh/v1/identity/{assert,verify}`, loopback) |
| Server | `StingStream.Core/Identity/`, `Controllers/IdentityController.cs` |
| App | `app/authorize.tsx`, `components/stingstream/identity/`, `components/stingstream/mesh/AddServer{Sheet,Finish}.tsx`, `lib/stingstream/identity{Api,}.ts`, `utils/identity/{handoff,verifier,resolveServer}.ts` |
| Tests | `vouch.rs`'s own module, `IdentityGateTests.cs`, `utils/identity/{handoff,verifier}.test.ts`, `utils/mesh/serverList.test.ts` |
