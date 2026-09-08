# Accounts

A StingStream account is how you sign in on any device without typing a server address, and how
somebody shares a library with you. This document is the reference for the service, the two rules
that shape it, and how to run one.

Read `MESH.md` for how servers talk to each other and `SECURITY.md` for the authorization tables.

---

## 1. What it holds

Four tables, and nothing else:

| | |
|---|---|
| `accounts` | username, argon2 hash. **No email, no name, nothing else about a person.** |
| `passkeys` | credential id, public key, counter — see §7 |
| `servers` | which node id belongs to which account, and how to reach it |
| `shares` | server → libraries → the account they are shared with |

No media, no metadata, no library contents, and **no watch history**: progress stays on the server
holding the file, where Jellyfin already keeps it. The most sensitive thing in the database is a
password hash, and the only personal data is a username somebody chose.

It never proxies a byte. A client signs in, is handed a signed token, and goes straight to the
servers named in it.

---

## 2. Signing in, and what happens when this service is down

**Accounts are optional, and one form covers both.** Somebody typing a username and a password at a
server does not know — and should not have to know — whether their credentials live centrally or on
that machine. So there is one form, and the sign-in is tried in order:

1. **A server with no account never calls anywhere.** An unclaimed node signs people in exactly as
   it always did. No dependency added, no round trip spent finding that out.
2. **The service is unreachable → sign in on the server instead**, and say so on screen. This is the
   case the fallback exists for: a central account service whose downtime stopped people watching
   their own films would be indefensible in a self-hosted product. It is also what Plex does.
3. **The service says no → still try the server.** Not everybody with a login has an account; local
   users exist and always will, and their password failing centrally is expected rather than an
   error worth showing.

A refusal at the end reports the **local** one, because that is the answer the person can act on:
they are typing a password at a server in front of them.

`GET /accounts/v1/public` on a node is the one anonymous account route, and it exists for this: the
login screen asks, before anybody types, whether this server has an account and which service it is
on. It deliberately does **not** say whose account — that is the sharing address, and not something
a passer-by gets for free.

## 3. The two rules

### Sign-up happens on a server you own

There is no registration form. Creating an account is `POST /accounts/v1/register`, **signed by a
node key**, made from Settings → Account on a machine already running StingStream. So the population
who can hold an account is exactly the population who installed it, and a service on the public
internet is never an open sign-up page.

A server may vouch for **one** account. Otherwise one install is an unlimited supply of them.

The same signature is the only way to reset a password. With no email there is no reset link, so
proving you own an account means proving you control a machine it already owns.

Somebody with no server of their own gets an account when they are shared with, through an invite
that creates it.

### This service signs; servers verify

A token is Ed25519-signed here. A node fetches the public key once — when it is claimed — caches it
beside its own node key, and from then on **verifies a token without calling anybody**.

That asymmetry is the whole reason a self-hosted product can have a central account service at all:

* the service being down costs **new devices and new shares**
* it never costs **playback**, or signing in on a device that already has a session

`stingstream-token` is its own crate for this reason: every StingStream server verifies a token, and
a node cannot take a dependency on the account service to do it.

---

## 4. The token

```
base64url(payload) . base64url(Ed25519 signature)
```

A JWT in spirit, without the header. There is one algorithm and one key, so a header would carry
only fields whose purpose is to be attacked — `alg: none` and RS256-to-HS256 confusion are a decade
of the same bug. A verifier that only ever does one thing cannot be talked into doing another.

```jsonc
{
  "sub": "…",            // account id
  "username": "dan",
  "servers": ["…"],      // node ids this token may be presented to
  "iat": 1757000000,
  "exp": 1757043200      // twelve hours
}
```

`servers` is enforced by the **node**: one that does not name it refuses the token. Revoking a share
takes effect when the token expires, because the next one will not mention that server.

Deliberately not a capability list. A node decides what an account may *see* from its own share
records, so it stays the authority on its own library even if this service is lying.

---

## 5. Routes

| Route | Who |
|---|---|
| `GET /healthz` | anyone |
| `GET /accounts/v1/jwks` | anyone, CORS `*` — the key nodes cache |
| `POST /accounts/v1/register` | a server, signed by its node key |
| `POST /accounts/v1/reset` | a server that already owns the account, signed |
| `POST /accounts/v1/claim` | a server, signed, **and** the account's password |
| `POST /accounts/v1/login` | anyone with a username and password |
| `GET /accounts/v1/me` | a token holder |
| `PUT`/`DELETE /accounts/v1/shares` | a token holder, for a server they own |

`claim` needs both halves. A signature alone would let somebody attach a machine they control to
somebody else's account — and an attached machine can reset that account's password.

A failed sign-in gives the same answer whether the username is unknown or the password is wrong.
Telling those apart would turn the endpoint into a way to enumerate usernames, and a username here
is the **sharing address**.

---

## 6. Usernames

A username is not just a login: with no email, `@alice` is the only way to name somebody, so it is
globally unique, public, and read off a screen and typed at somebody else.

Letters, digits, `-` and `_`; three to thirty-two characters; no leading or trailing separator;
compared case-folded and trimmed. Narrow on purpose — allowing Unicode brings homoglyphs (`аlice`
with a Cyrillic а), invisible characters and several spellings of one name, and each of those is a
way to be shared with by mistake. ASCII is the one alphabet where "looks identical" and "is
identical" agree.

---

## 7. Passkeys — optional, in two ways

Passkeys are a second way in, and with no email on an account a genuinely important one: a password
is the only other credential, and the only recovery is a server you own. Somebody with a passkey on
their phone has a way back that does not depend on remembering anything.

They are optional twice over, and both are ordinary states rather than failures:

**The `passkeys` Cargo feature may be off.** `webauthn-rs` is the only real server-side option and
it reaches OpenSSL through `webauthn-rs-core` — a C dependency in a workspace that is otherwise
entirely rustls, and one that does not build on a stock Windows toolchain, from the system or
vendored. So the default build is OpenSSL-free, which keeps development and CI's three platforms
working, and `deploy/accounts/Dockerfile` builds the deployed Linux image with `--features passkeys`.

**The origin may not be set.** A passkey is bound to a relying-party id for its whole life, so
without one the service runs with passkeys off rather than guessing.

Either way `GET /accounts/v1/passkeys` says so — always routed, feature or not, because a client
asking "can I use a passkey here?" deserves an answer rather than a 404 it cannot tell from an older
service. The four ceremony routes answer `501` with a sentence. **A password always works**, so
nothing is ever locked out by this.

### The domain problem

The relying-party id is the origin's host, and this service runs on a Railway hostname today. Dan
chose that with the trade in front of him: **every passkey registered before a real domain exists
stops working the moment one appears** — silently, with "this passkey isn't for this site" as the
only symptom. The password still works, so nobody is locked out, and everybody re-registers once.

### Where the challenge lives

In the service process, for sixty seconds, keyed by a ceremony id the browser carries between the
two halves. Handing the state to the browser and taking it back would mean trusting the client with
the challenge it is meant to be answering. A ceremony that outlives a redeploy fails and is retried.

### The counter, and where it has to live

A signature counter only ever goes up, which is how a **cloned authenticator** is noticed: a second
device holding a copy reports a number the real one has already passed.

The subtlety is *where* the number is kept. `webauthn-rs` checks an assertion against the counter
**inside the stored credential** it was handed — so writing the number into a column beside the
credential protects nothing, because the credential reloaded on the next sign-in still carries its
registration-time value and a clone sails past. After a successful sign-in the passkey is therefore
updated (`Passkey::update_credential`) and **stored again**; `sign_count` is a readable mirror of
what is inside it, not the check.

Most passkeys are synchronised and have no counter at all, so the library usually reports that
nothing changed and nothing is written. A failed write logs and lets the sign-in through: locking
somebody out of an account over a database write is a worse failure than a missed counter.

## 8. Running one

One binary, one SQLite file, one signing key, all on a mounted volume.

```
stingstream-accounts \
  --data-dir /data \
  --origin https://accounts.example.org
```

| Variable | |
|---|---|
| `PORT` | Railway sets it; defaults to 8080 |
| `STINGSTREAM_ACCOUNTS_DATA` | where `accounts.db` and `signing.key` live |
| `STINGSTREAM_ACCOUNTS_ORIGIN` | the public origin — **the passkey relying-party id** |

### SQLite, not Postgres

The plan said Postgres and this is SQLite. The mesh already stores state this way, so the patterns
and the in-memory test helper exist and a test opens a database rather than needing a server.
Against that, Postgres would bring point-in-time recovery.

The trade is defensible because **this database is not the only copy of anything that matters**: a
server knows which account owns it, a share is materialised into the sharer's own mesh, and playback
never asks this service anything. Losing it costs sign-in on new devices and the ability to change
shares — bad, recoverable, and not the same as losing a library. Back the volume up if that is not
good enough; moving to Postgres is confined to `db.rs`.

### Losing the signing key

Signs everybody out, everywhere, at once: every node caches the public half and refuses tokens
signed by a new one until it re-fetches. Nothing else breaks — accounts, servers and shares are all
in the database. A bad afternoon, not a disaster, which is why it is a file beside the database
rather than something more elaborate.

A node **refuses a signing key that tries to change**. A key silently rotating under a node is
indistinguishable from somebody pointing it at a service they run, and the consequence would be a
stranger's tokens being honoured. Rotation is deliberate: delete `accounts-signing.key` on the node.
