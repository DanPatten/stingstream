# Security Policy

## Supported versions

Only the most recent stable release of the StingStream app is guaranteed to include the
latest security patches. **Running older app versions may leave you vulnerable to security
risks.** Always update from the [Releases page](https://github.com/DanPatten/stingstream/releases)
as soon as an update is available.

This policy applies only to the current stable app release. Security flaws in previous app
versions that are no longer present in the latest release **will not** be back-ported or
fixed.

## Other StingStream components

The app is one part of the [StingStream](https://github.com/DanPatten/stingstream) monorepo,
which also ships the node (gateway, mesh, and the bundled server components) and, optionally,
a coordinator. See [../../docs/SECURITY.md](../../docs/SECURITY.md) for the node's own security
model (loopback gates, credential handling); the process below covers how to report an issue in
any of these components.

## Vulnerability triage

Before reporting an issue, please consider:

- **Administrator-level risks**: certain administrative or configuration endpoints may
  inherently carry elevated privileges. Vulnerabilities that **require administrator or root
  access** are classified as low priority. Report those via normal GitHub Issues.
- **Local-only issues**: vulnerabilities exploitable only with physical device access,
  manual file modification, or local debugging (e.g., modifying app files,
  rooting/jailbreaking) are considered low- to medium-priority.
- **Infrastructure reports**: to report issues in the project's website, servers, CI/CD, or
  other infrastructure, tag your report subject with `[StingStream Infrastructure]`.

## Reporting a vulnerability

After confirming your issue is new and relevant, open a private
[GitHub Security Advisory](https://github.com/DanPatten/stingstream/security/advisories) on
the repository (or, if that is unavailable to you, a GitHub issue marked security-sensitive)
with:

1. Subject line: `[StingStream Security] <short summary>`
2. Overview (public-safe): describe what component is affected (app, node, coordinator) and
   the high-level impact. This text may be reused for the published advisory.
3. Details: reproduction steps, code or API snippets, proof-of-concept, and any suggested
   remediation. Detail exactly how to trigger the issue.
4. Your GitHub username, so you can be credited and included in the remediation process.

## Post-disclosure process

StingStream is a small, largely solo-maintained project. **Please be patient**, especially
for complex issues; polite follow-ups after a reasonable interval are welcome.

- Patch releases: for critical vulnerabilities, a point release is issued promptly unless a
  major release is imminent, in which case the fix is deferred to it.
- Advisory publication: after releasing a patched app version, the advisory is published only
  after a reasonable window to let most users upgrade. Third-party disclosures (blog posts,
  advisories) are requested to occur **after** publication.

## Heritage

This app began as a fork of [Streamyfin](https://github.com/streamyfin/streamyfin). Its
security process here is StingStream's own and is not affiliated with, and should not be
reported to, the upstream project.
