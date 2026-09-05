import { type ConfigPlugin, withAppBuildGradle } from "expo/config-plugins";

/**
 * Release signing for local Gradle builds (M5, `docs/APP-RELEASE.md`).
 *
 * `android/` is gitignored and regenerated wholesale by `expo prebuild --clean`
 * (`docs/CONTRIBUTING.md` §3), so a signing config cannot live as a hand-edited line in
 * `android/app/build.gradle` — it has to be injected by a plugin, every time, the same way every
 * other Android customization in this app is (see the rest of `plugins/`).
 *
 * The injected Groovy reads the keystore's location and passwords from a **properties file whose
 * path is named by an environment variable**, `STINGSTREAM_KEYSTORE_PROPERTIES` — not from
 * anything committed to this repo, and not from anything this plugin's own TypeScript reads at
 * `expo prebuild` time either. Two reasons that split matters:
 *
 * 1. The keystore and its passwords must never be *in* the repo (a lost keystore means a new app
 *    identity on Play — see `docs/APP-RELEASE.md`), so nothing here can read them and no path to
 *    them can be hard-coded for one machine.
 * 2. Checking the environment variable in **Groovy, at Gradle configuration time**, rather than in
 *    this plugin at prebuild time, means the same generated `android/` project signs correctly
 *    whether or not the variable happens to be set for a *particular* Gradle invocation — a CI
 *    build that runs `assembleRelease` with no keystore configured still succeeds, producing a
 *    genuinely **unsigned** release APK/AAB (not debug-signed — see the note below), which is
 *    exactly what `.github/workflows/app.yml`'s unsigned-release job needs, without a second
 *    prebuild.
 *
 * `scripts/build-release.ps1` is what actually sets the environment variable for a real signed
 * build; see `docs/APP-RELEASE.md` for generating the keystore and the properties file it reads.
 */
const withReleaseSigning: ConfigPlugin = (config) => {
  return withAppBuildGradle(config, (config) => {
    const contents = config.modResults.contents;
    if (contents.includes("StingStream release signing")) return config;

    // Reopening `android { }` after the template's own block is valid Gradle — each invocation
    // just configures the already-created `android` extension — and it means this never has to
    // locate and edit the template's own signingConfigs/buildTypes blocks by text-matching,
    // which would be fragile across Expo/AGP template changes. `buildTypes.release` in the
    // upstream template defaults to `signingConfig signingConfigs.debug` so a bare
    // `assembleRelease` "just works" locally; the assignment below deliberately overrides that
    // rather than leaving it, because a debug-signed release build is not what "unsigned" (CI) or
    // a real signing config (a developer's own keystore) should silently fall back to.
    const injected = `
// --- StingStream release signing (apps/stingstream/plugins/withReleaseSigning.ts) ---
def stingstreamKeystorePropsPath = System.getenv("STINGSTREAM_KEYSTORE_PROPERTIES")
if (stingstreamKeystorePropsPath) {
    def stingstreamKeystorePropsFile = new File(stingstreamKeystorePropsPath)
    if (stingstreamKeystorePropsFile.exists()) {
        def stingstreamKeystoreProps = new Properties()
        stingstreamKeystorePropsFile.withInputStream { stingstreamKeystoreProps.load(it) }
        android {
            signingConfigs {
                release {
                    storeFile file(stingstreamKeystoreProps['storeFile'])
                    storePassword stingstreamKeystoreProps['storePassword']
                    keyAlias stingstreamKeystoreProps['keyAlias']
                    keyPassword stingstreamKeystoreProps['keyPassword']
                }
            }
            buildTypes {
                release {
                    signingConfig signingConfigs.release
                }
            }
        }
        logger.lifecycle("StingStream: release build signed with " + stingstreamKeystoreProps['storeFile'])
    } else {
        logger.warn("StingStream: STINGSTREAM_KEYSTORE_PROPERTIES=" + stingstreamKeystorePropsPath +
            " does not exist. Release build will be UNSIGNED. See docs/APP-RELEASE.md.")
        android {
            buildTypes {
                release {
                    signingConfig null
                }
            }
        }
    }
} else {
    logger.warn("StingStream: STINGSTREAM_KEYSTORE_PROPERTIES is not set. Release build will be " +
        "UNSIGNED (expected in CI; see docs/APP-RELEASE.md to sign locally).")
    android {
        buildTypes {
            release {
                signingConfig null
            }
        }
    }
}
`;

    config.modResults.contents = `${contents}\n${injected}`;
    return config;
  });
};

export default withReleaseSigning;
