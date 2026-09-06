# What Dan has to do in Play Console

In order. Steps 1–3 can be done any time; step 4 onwards has a real dependency chain, and the two
places it is easy to lose a day are marked.

Nothing in this list has been done. `docs/APP-RELEASE.md` is the build side; this is the store side.

---

## 1. Before anything else: the two open questions

**Neither is a Play Console step, and both block publishing.**

- [ ] **Trademark clearance for "StingStream".** The plan records that `.com` and `.net` are
      unverified and that no trademark search has been done. A store listing is a public commercial
      use of the name; a conflict found afterwards means renaming an app that people have installed,
      which is the one change Play makes genuinely painful.
- [ ] **Decide whether to register `stingstream.org`.** It was unregistered on 2026-09-04 (PIR
      RDAP). The privacy policy can live on GitHub Pages without it, so this is not blocking, but
      the listing looks unfinished with a `github.io` URL and the domain will not stay free.

## 2. Developer account

- [ ] Create a Google Play developer account: **$25, one-off, non-refundable**.
- [ ] Choose the account type deliberately. A **personal** account now requires identity
      verification and, for accounts created after November 2023, **12 testers for 14 continuous
      days** before production access is granted. An **organisation** account needs a D-U-N-S number
      (free, takes up to 30 days to obtain) and is exempt from the 12-tester requirement.
      **This is the decision that determines whether the first release is two weeks or two months
      away.** For a project with no company behind it, personal plus a closed test with twelve
      willing people is the shorter path — but the twelve have to be real Google accounts that opt
      in and keep the app installed for a fortnight, so start recruiting before the app is ready
      rather than after.
- [ ] Complete identity verification (personal) or D-U-N-S verification (organisation).

## 3. Host the privacy policy

- [ ] Copy `privacy-policy.md` (everything below its horizontal rule) into the repository as a page
      GitHub Pages will serve.
- [ ] Replace `<CONTACT EMAIL>` with a real address. **Play rejects a policy containing a
      placeholder.**
- [ ] Settings → Pages → deploy from `master` / `docs`.
- [ ] Confirm `https://danpatten.github.io/stingstream/privacy` loads for a logged-out browser.
      Console fetches the URL and refuses one that 404s or requires a login.

## 4. Create the app

- [ ] Play Console → Create app.
      - App name: `StingStream`
      - Default language: English (United Kingdom)
      - App or game: **App**
      - Free or paid: **Free** — and note that **this cannot be changed to paid afterwards**.
      - Declarations: developer programme policies, US export laws.
- [ ] **The package name is fixed by the first upload, not by this form.** It is
      `org.stingstream.app` (`docs/APP-RELEASE.md` §1). Once an AAB with that id is uploaded, the
      app entry is bound to it permanently.

## 5. Upload signing

- [ ] **Back up the release keystore first.** It is at
      `E:\Dan\Documents\Repos\.secrets\stingstream-release.keystore` and it exists in exactly one
      place. `docs/APP-RELEASE.md` §2 says what losing it costs: a new keystore means a new
      `applicationId` or a listing from scratch, and every existing install stops receiving updates.
      Two copies, offline, one off-site.
- [ ] Enrol in **Play App Signing** — it is mandatory for new apps. Google holds the app signing
      key; the keystore above becomes the *upload* key, which Google can rotate if it is ever lost.
      That is a real safety net, and it only exists if enrolment happens with the first release.
- [ ] Upload the AAB (not the APK) built per `docs/APP-RELEASE.md`.

## 6. App content declarations

Each is its own section in Console and each blocks the release until it is green.

- [ ] **Privacy policy** — the URL from §3.
- [ ] **App access** — the app needs a StingStream server to do anything, and Google's reviewers do
      not have one. **This is the second place a day gets lost.** Provide instructions in the
      "All functionality is not available without special access" box: either point them at a
      demo node reachable over the side door with a throwaway account, or explain in the notes that
      the app is a client for self-hosted software and give them a public test server address.
      A reviewer faced with a login screen and no credentials rejects the app for "broken
      functionality", and the appeal costs a week.
- [ ] **Ads** — No.
- [ ] **Content rating** — the questionnaire, answered from `content-rating.md`.
- [ ] **Target audience and content** — 18+, not designed for children (see `content-rating.md`).
- [ ] **News app** — No.
- [ ] **COVID-19 contact tracing** — No.
- [ ] **Data safety** — the form, answered from `data-safety.md`. Slow to fill in; every answer is
      already written down.
- [ ] **Government apps** — No.
- [ ] **Financial features** — None.
- [ ] **Health** — No.

## 7. Store listing

- [ ] Paste the text from `store-listing.md`: app name, short description, full description.
- [ ] Category: **Video Players & Editors**. Tags per `store-listing.md`.
- [ ] Contact details: an email address that will be read, and the GitHub URL as the website.
- [ ] Graphics: icon, feature graphic, phone screenshots. Sizes in `store-listing.md`.

## 8. The TV listing — do not skip

Android TV is a **separate listing surface** on the same app, and it has its own required assets and
its own review. An app that is fine on phones is rejected for TV over any of these:

- [ ] `<uses-feature android:name="android.software.leanback" android:required="false" />` and
      `android.hardware.touchscreen` marked `required="false"` in the manifest.
- [ ] A **launcher activity with the `LEANBACK_LAUNCHER` category**. Without it the app installs on
      a TV and cannot be opened.
- [ ] **`android:banner` on the application element**, and a **1280 × 720 PNG banner** uploaded in
      Console. The most commonly missed asset, and the error message does not name it.
- [ ] **At least one 1920 × 1080 landscape TV screenshot.**
- [ ] Declare TV support: Console → the release track → *Advanced settings* → *Form factors* →
      **Android TV**, and submit for the separate TV review.
- [ ] Confirm every screen reachable on TV is operable with a D-pad and has no touch-only control.
      `docs/APP-RELEASE.md` records that management screens are hidden on TV, which is what makes
      this pass; the Group screen's member management (M8b) is hidden there too.

## 9. Release

- [ ] **Internal testing** first: up to 100 testers, available in minutes, no review. Use it to
      confirm the AAB installs, the TV banner appears, and the app reaches a real node.
- [ ] **Closed testing** next, and if the account is personal this is where the **12 testers for 14
      days** requirement is satisfied. It cannot be skipped or backdated.
- [ ] **Production**. First review is typically several days and can be a fortnight.

## 10. Known gaps to disclose or fix first

- **armeabi-v7a is not built.** M5 dropped it because `react-native-reanimated`'s CMake build fails
  for that ABI on Dan's machine. The consequence is that **32-bit Fire TV sticks and older budget
  Android TV boxes cannot install the app** — Play will simply not offer it to them. Either fix the
  build or accept it; either way it is worth a line in the listing, because "not compatible with
  your device" with no explanation is a one-star review.
- **Chromecast has never been tested on a real device.** M5 left a manual checklist. The listing
  claims casting; test it before the claim is public.
- **Push notifications are not configured.** `docs/APP-RELEASE.md` notes the Expo project id still
  belongs to upstream Streamyfin and that push needs Dan's own Firebase project. Nothing in the
  listing promises notifications, so this is not blocking — but do not add the promise until it is
  true.

## 11. After the first release

- [ ] Re-submit the content rating questionnaire on every release (Console requires it; the answers
      do not change — see `content-rating.md`).
- [ ] Update Data Safety **before**, not after, any release that adds a network destination.
- [ ] Watch the Android vitals dashboard for ANRs and crashes. It is the only telemetry that exists,
      because the app itself reports nothing.
