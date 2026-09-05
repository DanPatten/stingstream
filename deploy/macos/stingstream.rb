# Homebrew formula TEMPLATE for StingStream.
#
# UNSIGNED AND UNVERIFIED. This machine has no Mac and cannot build, run or codesign anything
# here -- tools/package-node.sh can produce the osx-x64/osx-arm64 tarball layout (cross-compiled
# from Linux or Windows; see deploy/node/LAYOUT.md's cross-RID note), and this formula is written
# against that layout, but nobody has run the result on macOS. Gatekeeper will refuse to run an
# unsigned, unnotarized binary downloaded from the internet without the user explicitly bypassing
# it (`xattr -d com.apple.quarantine` or "Open Anyway" in System Settings) until Dan has an Apple
# Developer ID to sign and notarize with -- see docs/INSTALL.md "macOS" for exactly what is and
# is not done today.
#
# Once real releases and checksums exist (.github/workflows/release.yml's SHA256SUMS), replace the
# url/sha256 placeholders below, and this becomes installable via a personal tap:
#   brew tap danpatten/stingstream https://github.com/DanPatten/stingstream
#   brew install --formula deploy/macos/stingstream.rb
# or, once accepted upstream, `brew install stingstream` from homebrew-core (which has its own,
# stricter bar -- see https://docs.brew.sh/Acceptable-Formulae -- signing/notarization is very
# likely required before that submission would be accepted, not just recommended).

class Stingstream < Formula
  desc "Jellyfin + Radarr + Sonarr + NZBGet + a peer mesh, behind one login"
  homepage "https://github.com/DanPatten/stingstream"
  license "GPL-3.0-or-later"
  version "0.0.0" # PLACEHOLDER -- set by the release process; see docs/RELEASING.md

  on_macos do
    on_arm do
      url "https://github.com/DanPatten/stingstream/releases/download/v0.0.0/StingStream-0.0.0-osx-arm64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000" # PLACEHOLDER
    end
    on_intel do
      url "https://github.com/DanPatten/stingstream/releases/download/v0.0.0/StingStream-0.0.0-osx-x64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000" # PLACEHOLDER
    end
  end

  def install
    # The tarball is deploy/node/LAYOUT.md's tree as-is (bin/, web/, LICENSE, NOTICE.md, VERSION).
    # libexec, not bin, because bin/ here holds a whole install tree (Jellyfin, Radarr, Sonarr,
    # ffmpeg, nzbget alongside the supervisor itself), not one standalone executable -- exactly
    # the case Homebrew's own formula cookbook calls out libexec for.
    libexec.install Dir["*"]
    # --install-root explicit, same reasoning as every other launcher in this milestone (see
    # deploy/node/LAYOUT.md): a `brew services`-launched process should never depend on the
    # binary's own argv[0]-relative fallback.
    (bin/"stingstream").write_env_script libexec/"bin/stingstream",
      STINGSTREAM_INSTALL_ROOT: libexec.to_s
  end

  # `brew services start stingstream` runs this under launchd, logging to Homebrew's own
  # var/log -- the macOS equivalent of the systemd unit / Windows service in the other installers.
  # var/stingstream is Homebrew's per-formula persistent data path, not libexec, so an upgrade
  # (which replaces libexec entirely) never touches it.
  service do
    run [opt_bin/"stingstream", "--install-root", opt_libexec, "--data-dir", var/"stingstream"]
    keep_alive true
    log_path var/"log/stingstream.log"
    error_log_path var/"log/stingstream.log"
    working_dir var/"stingstream"
  end

  test do
    # No `brew test` can start the full node (five processes, a first-run wizard, a real port) --
    # this only proves the binary launches and reports its own version, which is what `brew test`
    # is for. See docs/INSTALL.md for the acknowledged gap: nothing beyond this has run on macOS.
    assert_match version.to_s, shell_output("#{bin}/stingstream --version")
  end
end
