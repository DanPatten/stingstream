# Content rating questionnaire

Google Play Console → App content → Content ratings. The questionnaire is IARC's, filled in once and
producing ratings for every territory at once (ESRB, PEGI, USK, ClassInd, ACB, GRAC).

**Answer honestly and conservatively.** A rating obtained by an answer that is technically defensible
but misleading is grounds for removal, and the questionnaire is re-submitted on every app update
anyway, so there is no benefit in being clever once.

---

## Category selection

IARC first asks what kind of app this is. Choose:

> **All other app types** → **Utility, Productivity, Communication, or Other**

**Not "Entertainment" and not "Social".** The distinction matters, because those two branches ask a
different and much longer set of questions about user-generated content and about content the app
provides. StingStream provides no content and hosts no social surface; it is a client for a server
the user runs. The same reasoning puts it in the Video Players & Editors *store* category alongside
VLC and Plex.

---

## The questions

### Violence
| Question | Answer |
|---|---|
| Does the app contain any violence? | **No** |
| Realistic violence? Blood or gore? Violence toward humans or animals? | **No** |

*The app contains no content. What a user's own server holds is not "content in the app" any more
than a file manager contains the files it lists — the same reasoning every media player relies on,
and the reason VLC is rated Everyone.*

### Sexuality
| Question | Answer |
|---|---|
| Does the app contain sexual content or nudity? | **No** |
| Does it contain references to sexual violence? | **No** |

### Language
| Question | Answer |
|---|---|
| Does the app contain profanity or crude humour? | **No** |

### Controlled substances
| Question | Answer |
|---|---|
| Does the app reference alcohol, tobacco or drugs? | **No** |

### Miscellaneous
| Question | Answer | Why |
|---|---|---|
| Does the app contain gambling or simulated gambling? | **No** | |
| Does the app allow users to purchase digital goods? | **No** | Free, GPL-3.0, no IAP, no subscription. |
| Does the app share the user's current physical location with other users? | **No** | No location permission is requested. Other members of a group learn the device's IP address, which is how a peer-to-peer connection is made; that is a network address, not a location, and IARC's question is about deliberate location sharing. |
| Does the app allow users to interact or exchange content with other users? | **Yes** | This is the important one. See below. |
| Does the app allow users to share their personal information with other users? | **No** | Nothing about a person crosses the mesh. Members see node names, which are names for *computers* and are chosen by their owner. |

### The user-interaction follow-ups

Answering **yes** to "interact or exchange content" opens a short branch. Answer it as follows:

| Question | Answer | Why |
|---|---|---|
| Is the interaction between users moderated? | **No** | There is nobody to moderate it. There is no server of ours in the path, and a group is closed. |
| Is the content exchanged between users user-generated? | **Yes** | Members' media libraries are exchanged, and they are whatever the members put there. |
| Can users exchange content with anyone, or only with people they know? | **Only with people they know** | A group is invite-only, there is no directory, no discovery and no way to find a stranger's node. This answer is the accurate one and it is also the one that keeps the rating sensible. |
| Is there a way to report inappropriate content? | **No** | And there is no way to provide one: the project sees nothing and controls nothing. The mitigation is that a group is people who chose each other, and any member can remove any other member immediately. |

---

## Expected outcome

The "unmoderated user interaction, closed groups" combination typically produces:

| Board | Expected |
|---|---|
| ESRB | **Everyone**, with the "Users Interact" interactive element |
| PEGI | **3**, with the "Users Interact" descriptor |
| USK | **0** (or 6) |
| ClassInd | **L** |
| ACB | **G** |
| GRAC | **All** |

Plus the **"Users Interact"** / **"Shares Info"** interactive-elements flags on Google Play itself.

**Set the store's own target audience to 13+ anyway.** The rating boards will say 3+, and that is
correct about the app's content, but an app whose entire purpose is peer-to-peer file sharing inside
a private group should not be presented to Play's Families programme. Selecting 13+ in the *Target
audience and content* section keeps it out of Designed for Families, which is the right outcome and
avoids the additional Families policy obligations (which include things StingStream cannot satisfy,
such as content moderation).

---

## Target audience and content — the separate section

Console asks this separately from the rating, and it is easy to answer inconsistently.

| Question | Answer |
|---|---|
| Target age groups | **18 and over** (or 13–17 and 18+, if a broader reach is wanted) |
| Is your app designed for children? | **No** |
| Could your store listing unintentionally appeal to children? | **No** — no cartoon characters, no bright primary-colour branding, no game-like imagery |
| Do you have ads? | **No** |

---

## When to re-run this

The questionnaire is re-submitted on every release, but the *answers* only change if:

* the app ever provides content of its own (it will not);
* discovery of strangers is added (it will not be — `ARCHITECTURE.md` rules out a public directory);
* in-app purchases are added;
* a location permission is added.

If none of those has happened, re-submit the same answers.
