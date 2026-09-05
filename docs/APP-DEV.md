# Developing apps/stingstream (Streamyfin)

Practical setup for the vendored app at `apps/stingstream`: installing it, exporting the web
target, and building/running Android and Android TV. See
[`M2-web-spike.md`](M2-web-spike.md) for how each of these was worked out and what still has rough
edges; this file is just the steps.

---

## Why bun, not yarn or npm

**Install this app with `bun`, and only `bun`.** `package.json` pins `react-native-screens`
deliberately (it is listed in `expo.install.exclude`), and yarn's hoisting does not respect that
pin: a second copy of `react-native-screens` ends up nested under
`node_modules/expo-router/node_modules/`, both copies register the same native view, and the
Android / Android TV app crashes at startup with:

```
Tried to register two views with the same name RNSScreen
```

This is a **runtime** failure on a real device or emulator — `npx expo export --platform android`
succeeds on the broken tree without complaint, so no bundler or CI check catches it short of
actually launching the app. It was found and fixed during the M2 web-target spike
(`M2-web-spike.md` section 8); `rm -rf node_modules && bun install --frozen-lockfile` is what
resolved it, and a partial reinstall over a yarn-built `node_modules` is not enough — the stray
copy survives a `bun install` on top of it. `bun.lock` is the lockfile of record; a `yarn.lock`, if
one ever appears locally, is gitignored.

Two things enforce this beyond documentation:

- `package.json` has `"packageManager": "bun@1.4.1"`. Yarn Classic (1.22) itself refuses to run at
  all against a `packageManager` field it doesn't recognize (`Unsupported package manager
  specification`) — confirmed empirically, no config needed.
- A `preinstall` script (`scripts/require-bun.js`) checks `npm_config_user_agent` and exits
  non-zero unless it starts with `bun/`. This is what actually stops `npm install`, whose
  `packageManager` handling is otherwise silent. Verified against bun 1.4.1, yarn 1.22.22 and npm
  11.6.1: bun installs cleanly (the guard is invisible when it passes), yarn is refused before the
  guard even runs, npm is refused by the guard with a message pointing here.

If you ever need to bypass the guard for a one-off diagnostic install, `--ignore-scripts` skips all
lifecycle scripts including this one — but then you own verifying the resulting tree by hand.

---

## One-time setup

### Install bun

```powershell
npm install -g bun
bun --version   # 1.4.1 used for M2; anything reasonably current should do
```

(The official installer, `powershell -c "irm bun.sh/install.ps1 | iex"`, also works if you'd rather
not go through npm. Either way, only the `bun` binary matters — nothing here depends on how it got
onto the machine.)

### Install dependencies

```powershell
cd apps/stingstream
bun install --frozen-lockfile
```

`--frozen-lockfile` matches what CI does: it fails instead of silently rewriting `bun.lock` if the
lockfile and `package.json` have drifted apart.

### Environment variables (Android / Android TV only; skip for web-only work)

Persist these once (`[Environment]::SetEnvironmentVariable(name, value, "User")`, or your shell
profile) rather than setting them per-session — several tools (Gradle, the Android SDK's
`local.properties` generation) expect them to already be there:

| Variable | Value used for M2 | Why |
| --- | --- | --- |
| `JAVA_HOME` | `E:\Java\jdk-17.0.20.101-hotspot` | JDK 17. `winget install Microsoft.OpenJDK.17` ignores `--location` and installs to `C:\Program Files\...`; the spike copied the JDK to E: after (a JDK is relocatable) to keep it off a nearly-full C: drive. |
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` | `E:\Android\sdk` | Android SDK (command-line tools + platforms + build-tools; AGP auto-fetches the NDK). |
| `ANDROID_AVD_HOME` | `E:\Android\avd` | Emulator images. `avdmanager` defaults to `C:\Users\<you>\.android\avd` otherwise, and a single AVD's userdata image grows to gigabytes. |
| `GRADLE_USER_HOME` | `E:\Dan\Documents\Repos\.gradle` | Gradle's dependency/build cache, kept off C: for the same reason. |

Two gotchas that cost real time during the spike:

- **`android/local.properties` needs forward slashes**: `sdk.dir=E:/Android/sdk`. Java
  `.properties` files treat `\` as an escape character, so `sdk.dir=E:\Android\sdk` silently
  becomes `E:Androidsdk` and Gradle dies with *"The filename, directory name, or volume label
  syntax is incorrect"* out of `SdkLocator.validateSdkPath`. `expo prebuild` generates this file;
  check it if a from-scratch build fails immediately.
- **SDK license acceptance needs real stdin.** From a bash shell,
  `yes | sdkmanager.bat --licenses` works; piping a string into it from PowerShell does not.

---

## Web

```powershell
cd apps/stingstream
bun install --frozen-lockfile
bun run build:web   # thin wrapper around: npx expo export --platform web
```

Output lands in `dist/` (gitignored; `output: "single"` in `app.json`, so it's one big SPA bundle,
not statically rendered routes — see `M2-web-spike.md` section 7 for why). Serve it with any static
file server to try it in a browser; there is no dev-server step required to validate an export. See
`docs/UI.md` for how the M2 screens are organized and how this bundle is served by a node's gateway.

For iterative work, `npx expo start --web` runs Metro's own dev server instead of a static export.

---

## Android TV

```powershell
cd apps/stingstream
bun install --frozen-lockfile

# Optional, and only needed for the mesh: builds the Rust light node into the Expo module.
# Skipping it is fine — the module still compiles (its uniffi bindings are committed), Gradle
# prints a warning, and the app runs with the mesh reporting available:false, exactly as on web.
# A *release* build fails without it. See docs/APP-MESH.md.
powershell -File scripts/build-mesh-android.ps1

# Regenerate the native android/ project for the TV variant (android/ is gitignored, matching
# upstream). Equivalent to the "prebuild:tv" package.json script.
$env:EXPO_TV = "1"
npx expo prebuild --platform android --clean

cd android
./gradlew assembleDebug --no-daemon
```

**Windows: keep `GRADLE_USER_HOME` shallow.** `react-native-screens`'s CMake step stats a header
inside the Gradle transform cache that, from `E:\Dan\Documents\Repos\.gradle`, comes to 261
characters — one over `MAX_PATH` — and ninja fails with *"Filename longer than 260 characters"*.
A junction fixes it without re-downloading anything:

```powershell
cmd /c mklink /J E:\g E:\Dan\Documents\Repos\.gradle   # once, no admin needed
$env:GRADLE_USER_HOME = "E:/g"
```

If a build has already failed this way, delete the stale CMake configurations too — **both**
`node_modules/react-native-screens/android/.cxx` and `apps/stingstream/android/app/.cxx`. CMake
bakes the absolute prefab path into its ninja files, so the old one survives the environment
change until each configuration is regenerated, and missing the second one looks exactly like the
fix not working.

A debug build takes on the order of 30 minutes cold and produces
`android/app/build/outputs/apk/debug/app-debug.apk` (~300 MB across three ABIs plus the
MPV/ExoPlayer native libs). Install and run it:

```powershell
adb install android/app/build/outputs/apk/debug/app-debug.apk

# The debug build embeds expo-dev-client, so it lands on DevLauncherActivity rather than the app
# itself. Start Metro for the TV bundle and point the launcher at it:
$env:EXPO_TV = "1"
npx expo start --dev-client
adb reverse tcp:8081 tcp:8081
adb shell am start -a android.intent.action.VIEW `
  -d "streamyfin://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"
```

Drive it over ADB without a physical remote: `adb shell input keyevent <code>` — `20` = DPAD_DOWN,
`19` = DPAD_UP, `23` = DPAD_CENTER, `4` = BACK.

Regular (phone/tablet) Android is the same shape without `EXPO_TV=1` — `bun run prebuild` /
`bun run android` per the existing `package.json` scripts.

### Emulator note

Only `system-images;android-36;android-tv;x86_64` and up ship an `x86_64` Android TV image;
`android-34`'s TV image is `x86` / `arm64-v8a` only. Since the APK carries an `x86_64` slice, pair
it with an API 36+ TV image (device profile `tv_1080p` was used for M2), not the API 34 that older
guidance suggests.

---

## Debugging a blank page (web) or a startup crash (native)

Two different failure classes need two different techniques — see `M2-web-spike.md` sections 1 and
8 for the background:

- **Web, blank page with no bundler error**: the export succeeded but a module threw at *import*
  time (a `requireNativeModule`/`requireNativeView` call at module scope, not inside a
  `Platform.OS` guard). Minified stacks are useless here — export with `--no-minify --output-dir
  dist-dbg`, serve it, and read the real stack out of the browser console; the offending call is
  right there.
- **Native, crash at startup after an install**: check for a duplicate `react-native-screens`
  first (`node_modules/expo-router/node_modules/react-native-screens` existing at all is the tell).
  `rm -rf node_modules && bun install --frozen-lockfile` — see "Why bun, not yarn or npm" above.

---

## Gradle wrapper pinned to 8.14.3 (M5)

`plugins/withGradleWrapperVersion.ts` rewrites `android/gradle/wrapper/gradle-wrapper.properties`
after every `expo prebuild` to Gradle **8.14.3**, overriding whatever `expo prebuild` copied in
from `@react-native/gradle-plugin`'s own wrapper file. Do not "fix" this by deleting the plugin or
regenerating the wrapper — read the rest of this section first, because the default is broken on
this exact dependency set, not merely different.

**The failure signature, so nobody re-diagnoses this from scratch.** As of this fork's locked
dependencies (`bun.lock` — unchanged since M2, so this is not a dependency bump), both
`@react-native/gradle-plugin` and `react-native-reanimated` independently bundle a wrapper pinned
to Gradle **9.3.1** — genuinely, not a stray/corrupted download; it is what upstream ships for
these exact package versions, confirmed by two unrelated packages agreeing. But Gradle 9.3.1
cannot evaluate this project's settings scripts at all. A completely bare `expo prebuild --clean` +
`gradlew help` — no StingStream release config, no signing, no minification, confirmed on a plain
`assembleDebug` too — fails compiling `node_modules/@react-native/gradle-plugin/settings.gradle.kts`
(an `includeBuild()`-ed composite build) with roughly 128 "Unresolved reference" errors for
essentially *every* Gradle/Kotlin-DSL symbol in that file — `plugins`, `id`, `mavenCentral`,
`google`, all of it — which is a much stranger failure than an error about the one plugin
(`org.gradle.toolchains.foojay-resolver-convention`) it happens to be declaring. Removing that one
plugin request gets past that file, but immediately hits a second failure one level up, resolving
`com.facebook.react.settings` in the app's own `android/settings.gradle`:

```
java.lang.NoSuchMethodError: 'void Settings_gradle.<init>(org.gradle.kotlin.dsl.support.KotlinScriptHost,
org.gradle.plugin.use.PluginDependenciesSpec, org.gradle.api.initialization.Settings)'
```

— Gradle's *own* generated glue class for a Groovy settings script with a `plugins{}` block, not
project code. None of the usual suspects fixed either failure: clearing Gradle's
`kotlin-dsl`/`groovy-dsl`/`generated-gradle-jars` caches and the project-local `android/.gradle`,
stripping the machine's old bundled Java 8 off `PATH` so nothing could resolve it ahead of JDK 17,
forcing `-Dfile.encoding=UTF-8`, running with and without the Gradle daemon, and bumping the
included build's own Kotlin Gradle Plugin version from 2.1.20 to Gradle 9.3.1's embedded 2.2.21 (to
rule out an ABI mismatch) — every one of those left the identical failure. Confirmed network
connectivity and artifact existence too (the plugin's exact version resolves fine over plain
HTTPS), so it is not a resolution failure in the ordinary sense either.

Pinning the wrapper to Gradle **8.14.3** — paired with AGP 8.12.0, which the included build's own
version catalog already declares — gets past both failures immediately, with the *original,
unpatched* `foojay-resolver-convention` plugin request: `gradlew help` configures every project
correctly and starts executing tasks, confirmed with a clean `BUILD SUCCESSFUL`. Whatever changed
in Gradle 9.x's settings-level plugin resolution for a composite build with a Groovy `plugins{}`
block, this exact dependency combination trips it, and 8.14.3 does not. A `bun patch` removing the
`foojay-resolver-convention` line was tried as part of isolating the first failure and is
deliberately **not** kept — once the wrapper is pinned, the original line needs no changes at all,
so keeping a patch around would only be extra surface with no benefit.

If a future dependency bump moves `@react-native/gradle-plugin`/`react-native-reanimated` off
Gradle 9.3.1 (or fixes whatever this is), re-test with `withGradleWrapperVersion.ts` disabled
before assuming the pin is still needed — this is a workaround for a specific broken combination,
not a permanent policy pin.
