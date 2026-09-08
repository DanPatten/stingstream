//! The brand mark, as an image the gateway can splice into a page before the app exists.
//!
//! **The artwork is generated; this file is not.** `bun scripts/brand/generate.ts` writes
//! `mark.png.base64` next to this module and `include_str!` pulls it in at compile time, so it is
//! still a single constant in the binary. That replaces the arrangement this file used to describe:
//! a copy of the mark's SVG path data pasted in by hand, which had to be re-pasted every time the
//! generator ran and which nothing checked. The mark is now a render -- overlapping translucent
//! ribbons with a gradient falloff -- and there is no path that draws it.
//!
//! It is inlined rather than fetched because it is on the first-paint path: a splash that arrives
//! in a second round trip has already lost the race it exists to win. The test below pins the
//! properties that would actually break -- or open -- a page, and `docs/APP-RELEASE.md` §3
//! "Branding" records where the artwork comes from. (The comment this replaced pointed at
//! `docs/RUNNING.md`, which has never mentioned the mark.)

/// The mark as a 144x144 PNG (2x the 72px it is drawn at), base64, with no `data:` prefix and no
/// trailing newline: it goes straight into a `src` attribute.
pub const MARK_PNG_BASE64: &str = include_str!("mark.png.base64");

#[cfg(test)]
mod tests {
    use super::*;

    /// This string goes straight into a `src="data:image/png;base64,..."` attribute in a page the
    /// gateway writes, so the two things worth pinning are that it is a PNG at all and that it
    /// cannot end the attribute. The base64 alphabet check covers the second on its own: a string
    /// that is only `A-Za-z0-9+/=` contains no quote, no `<`, and no whitespace.
    #[test]
    fn the_mark_is_a_png_that_cannot_escape_its_attribute() {
        // "iVBORw0KGgo" is the 8-byte PNG signature (89 50 4E 47 0D 0A 1A 0A) in base64.
        assert!(
            MARK_PNG_BASE64.starts_with("iVBORw0KGgo"),
            "that is not a PNG"
        );
        assert!(
            MARK_PNG_BASE64
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'='),
            "a data: URI payload is base64 and nothing else"
        );
        // Big enough to be the generated mark rather than a placeholder left behind, and small
        // enough that inlining it on every first paint is still the right trade (it is ~30 KB).
        assert!(
            MARK_PNG_BASE64.len() > 10_000,
            "that is not the generated mark"
        );
        assert!(
            MARK_PNG_BASE64.len() < 60_000,
            "too big to inline on the first-paint path"
        );
    }
}
