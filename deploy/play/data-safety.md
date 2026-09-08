# Data Safety declaration

Google Play Console → App content → Data safety. Every question, the answer, and the reasoning
behind it, because this form is a legal declaration and "I ticked what looked right" is not a
defence if it turns out to be wrong.

The declaration below is **verifiable**: `docs/SECURITY.md` §1 is the threat model it corresponds
to, and the claim "no analytics, no crash reporting, no advertising id" can be checked against the
app's dependency list.

---

## The shape of the answer

Google's form asks two separate questions about every data type:

* **Collected** — does it leave the user's device *to you or to a service you use*?
* **Shared** — does it then go to a third party?

StingStream's whole architecture is that data leaves the device only for **a server the user
installed themselves**, and Google's guidance is explicit that this is not collection:

> *"Data is not 'collected' if your app… transfers it to a server that the user controls."*

That covers the user's own node. It does **not** cover the discovery services or the relays, which
is where this declaration has to be careful rather than confident. Those are dealt with under §3.

---

## 1. Data collection and security — the preamble questions

| Question | Answer | Why |
|---|---|---|
| Does your app collect or share any of the required user data types? | **Yes** | Answering "no" would be simpler and would be wrong: the public relays and the discovery services see a device's IP address, and Google counts that. |
| Is all of the user data collected by your app encrypted in transit? | **Yes** | Everything is. Node-to-node is QUIC with TLS 1.3 and the node's own key as the identity; the relay carries ciphertext it cannot read. The only plain HTTP is a node talking to itself on `127.0.0.1`, which never crosses a network. |
| Do you provide a way for users to request that their data be deleted? | **Yes** | Two ways, neither involving us, because we hold nothing to delete: turn discovery off or leave the group (the device stops publishing and the entries expire on their own), or uninstall (nothing survives, because nothing was ever anywhere else). Documented at the URL in §4. |

---

## 2. Data types — the grid

Google's list, in Google's order. **Every row is "not collected" unless noted.**

### Location
| Type | Collected | Note |
|---|---|---|
| Approximate location | **No** | |
| Precise location | **No** | The app requests no location permission at all. |

### Personal info
| Type | Collected | Note |
|---|---|---|
| Name | **No** | |
| Email address | **No** | There is no account with us. The username on the user's own node never leaves it. |
| User IDs | **No** | See §3 on node ids. |
| Address, Phone number, Race and ethnicity, Political or religious beliefs, Sexual orientation, Other info | **No** | |

### Financial info
All rows **No**. There are no purchases, no subscription and no payment path of any kind.

### Health and fitness
All rows **No**.

### Messages
| Type | Collected | Note |
|---|---|---|
| Emails, SMS or MMS, Other in-app messages | **No** | The app sends no messages. Requests and watch-party invitations go to the user's own node and to the group's nodes, never through us. |

### Photos and videos
| Type | Collected | Note |
|---|---|---|
| Photos | **No** | |
| Videos | **No** | **This is the row most likely to be answered wrongly.** The app plays video *from the user's own server* and can download it to the device. That is not collection: the video never goes anywhere the user did not put it, and it never comes to us. |

### Audio files
All rows **No**.

### Files and docs
| Type | Collected | Note |
|---|---|---|
| Files and docs | **No** | Downloads are written to the app's own storage. Nothing is read from the user's other files. |

### Calendar, Contacts
All rows **No**. No permission is requested for either.

### App activity
| Type | Collected | Note |
|---|---|---|
| App interactions | **No** | No analytics SDK of any kind. |
| In-app search history | **No** | Searches go to the user's own node. |
| Installed apps, Other user-generated content, Other actions | **No** | |

### Web browsing
**No**.

### App info and performance
| Type | Collected | Note |
|---|---|---|
| Crash logs | **No** — read the note | The app *contains* Sentry, inherited from the Streamyfin fork, and **it is disabled in a StingStream release**: M8b removed the DSN (upstream's default pointed at Streamyfin's own Sentry organisation) and made the consent toggle opt-in rather than opt-out, so with nothing configured `Sentry.init` is never called and no event is constructed. A crash is visible to the user and to nobody else. **If a future release sets `EXPO_PUBLIC_SENTRY_DSN`, this row becomes "Yes — collected, and shared, for App functionality and Diagnostics" and must be changed in the same release.** |
| Diagnostics | **No** | |
| Other app performance data | **No** | No performance tracing, no session replay, no screenshots — all three are off in the SDK configuration as well as unreachable without a DSN. |

### Device or other IDs
| Type | Collected | Note |
|---|---|---|
| Device or other IDs | **No** — see §3 | No advertising id, no ANDROID_ID, no IMEI, no installation id reported to anyone. The app generates a **node key** for the mesh, which is a cryptographic identity for the device on the user's own network of devices. It is not derived from any device identifier, it is not linked to a person, and it goes to nodes in the user's own group and to the discovery services that resolve it to an address. |

---

## 3. Data shared — the part that needs care

Three destinations, and only one of them is a third party in any ordinary sense.

### 3.1 The user's own node

Not collection and not sharing, by Google's own definition: it is a server the user installed and
controls. What goes there is everything the app does — the library, playback position, requests,
downloads — and it never leaves it unless the user shares a title with their group.

### 3.2 The discovery services

StingStream runs no server of its own. To let two members' computers find each other, a device
publishes where it can be reached to two third-party services: **n0's DNS discovery** (n0 make the
`iroh` library StingStream uses) and the **mainline DHT**, the public table BitTorrent uses.

What is published is the device's **node id** (a public key generated on the device, not derived
from anything about the person or the hardware) and its **IP addresses**. It is public by design —
anybody holding a node key can resolve it — and it does **not** include the group's identity, any
member's name, any title, or any content.

**Declared as:** *Device or other IDs → shared → for App functionality.* This is the one row where
"not collected" would be a stretch, and the honest declaration costs nothing.

Both services can be turned off in settings, at the cost of only connecting on a local network or to
a computer with a public address.

### 3.3 Public relays

When two nodes cannot reach each other directly, packets travel via a relay — by default the free,
public relays run by number 0 (n0), the authors of the iroh library StingStream uses. A relay sees
the sender's and receiver's node ids and IP addresses and a stream of bytes it cannot decrypt.

**Declared as:** part of the same *Device or other IDs → shared* row. The user can change the relay
map or turn public relays off entirely.

### 3.4 Nobody else

No advertising network, no analytics provider, no content delivery network, no "partners". The app
makes no outbound request to any address the user has not configured, except to the relays above.

**The one thing to keep honest here is Sentry.** It is in the dependency tree, because the app is a
fork of Streamyfin and Streamyfin uses it. In a StingStream build it has no DSN and no default
consent, so it never initialises — which is what makes every "No" above true. That is a *code*
guarantee (`apps/stingstream/utils/sentry.ts`, and four tests that pin it) rather than a promise,
which is the only kind worth putting on a form Google enforces by removal.

---

## 4. Fields Console will ask for

| Field | Value |
|---|---|
| Privacy policy URL | `https://danpatten.github.io/stingstream/privacy` (see `privacy-policy.md`; the page must exist **before** the form can be saved) |
| Data deletion URL | Same page, `#deleting-your-data` anchor |
| Account creation | **No accounts** — select "Users cannot create an account" |
| Data used for account management | n/a |

---

## 5. When this has to be revisited

The declaration above is true of the app as it stands. Any of these changes it, and the form must be
updated **before** the release that contains them:

* **setting `EXPO_PUBLIC_SENTRY_DSN`**, or defaulting `sentryEnabled` back to true — either one
  turns crash reporting on, and both are one line;
* adding any other analytics, however anonymous;
* adding any first-party hosted service the app talks to by default;
* any feature that reads the user's photos, files, contacts or location.

A change here that ships without the form being updated is a policy violation, and Google's
enforcement for a wrong Data Safety declaration is removal rather than a warning.
