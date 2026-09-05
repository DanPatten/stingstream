import * as fs from "node:fs";
import * as path from "node:path";
import { type ConfigPlugin, withDangerousMod } from "expo/config-plugins";

/**
 * Pins the generated `android/`'s Gradle wrapper to a known-working version, overriding whatever
 * `expo prebuild` copied from `@react-native/gradle-plugin`'s own wrapper file.
 *
 * ## Why this exists
 *
 * As of this fork's locked dependencies (`bun.lock`, unchanged since M2), both
 * `@react-native/gradle-plugin` and `react-native-reanimated` independently bundle a wrapper
 * pinned to Gradle **9.3.1** — genuinely, not by accident; it is what upstream ships for these
 * exact package versions. But 9.3.1 cannot evaluate *this* project's settings scripts at all: a
 * bare `expo prebuild --clean` + `gradlew help` (no release config, no signing, nothing
 * StingStream-specific — confirmed on a plain `assembleDebug` too) fails compiling
 * `node_modules/@react-native/gradle-plugin/settings.gradle.kts` (an `includeBuild()`-ed composite
 * build) with ~128 "Unresolved reference" errors for essentially every Gradle/Kotlin-DSL symbol in
 * that file — `plugins`, `id`, `mavenCentral`, `google`, everything — not an error about the one
 * plugin (`org.gradle.toolchains.foojay-resolver-convention`) it happens to be declaring. Getting
 * past that (by removing that one plugin request — see `patches/`) only reaches a second failure
 * one level up, resolving `com.facebook.react.settings` in the app's own `android/settings.gradle`:
 * `java.lang.NoSuchMethodError: 'void Settings_gradle.<init>(org.gradle.kotlin.dsl.support.
 * KotlinScriptHost, org.gradle.plugin.use.PluginDependenciesSpec, org.gradle.api.initialization.
 * Settings)'` — Gradle's *own* generated glue class for a Groovy settings script with a `plugins{}`
 * block, not project code.
 *
 * None of the usual suspects fixed either failure: clearing Gradle's `kotlin-dsl`/`groovy-dsl`/
 * `generated-gradle-jars` caches and the project-local `android/.gradle`, stripping the machine's
 * old bundled Java 8 off `PATH` so nothing could resolve it ahead of JDK 17, forcing
 * `-Dfile.encoding=UTF-8`, running with and without the Gradle daemon, and bumping the included
 * build's own Kotlin Gradle Plugin version from 2.1.20 to Gradle 9.3.1's embedded 2.2.21 (to rule
 * out an ABI mismatch) — every one of those left the identical failure. Pinning the wrapper to
 * Gradle **8.14.3** (paired with AGP 8.12.0, which the included build's own version catalog
 * already declares) gets past both failures immediately: `gradlew help` configures every project
 * correctly and starts executing tasks. Whatever changed in Gradle 9.x's settings-level plugin
 * resolution for a composite build with a Groovy `plugins{}` block, this exact dependency
 * combination trips it, and 8.14.3 does not.
 *
 * `patches/@react-native+gradle-plugin+0.86.0.patch` (bun's native patch mechanism, the same one
 * this repo already uses for `react-native-udp` — see `docs/CONTRIBUTING.md`) is **not** kept:
 * once the wrapper is pinned to 8.14.3, the original `foojay-resolver-convention` plugin request
 * resolves and applies with no error at all, so removing it bought nothing beyond diagnosing the
 * 9.3.1 issue — see `docs/APP-DEV.md`, "Gradle wrapper pinned to 8.14.3" for the full writeup and
 * the exact failure signature, so nobody has to re-diagnose this from scratch.
 */
const PINNED_GRADLE_VERSION = "8.14.3";

const withGradleWrapperVersion: ConfigPlugin = (config) => {
  return withDangerousMod(config, [
    "android",
    (config) => {
      const propsPath = path.join(
        config.modRequest.platformProjectRoot,
        "gradle",
        "wrapper",
        "gradle-wrapper.properties",
      );
      if (!fs.existsSync(propsPath)) return config;

      const contents = fs.readFileSync(propsPath, "utf8");
      const pinned = contents.replace(
        /distributionUrl=.*$/m,
        `distributionUrl=https\\://services.gradle.org/distributions/gradle-${PINNED_GRADLE_VERSION}-bin.zip`,
      );
      if (pinned !== contents) {
        fs.writeFileSync(propsPath, pinned);
      }
      return config;
    },
  ]);
};

export default withGradleWrapperVersion;
