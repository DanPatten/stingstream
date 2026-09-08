//! Where people reach *this* node, and the invite links built from it.
//!
//! Two settings, both stored per node in the `meta` table (`db.rs`), both optional:
//!
//! - **`sharing.public_address`** — a domain the owner has pointed at this node. It exists so an
//!   invite can be a link somebody clicks instead of a code somebody retypes.
//!   the shipped address so a new node has one without anybody being asked, and only a default: the
//!   value is copied onto the group at creation and the group is the authority from then on, which
//!   is what makes it possible to change one group's coordinator without disturbing another's.
//!
//! **Why the public address belongs to the node and not to the group.** In a group where one member
//! has `media.example.com` and another has no domain at all, a link the first mints has to point at
//! the first's server and a link the second mints cannot. One value per group would route the
//! second member's invitees through the first member's machine, which then has to be up for an
//! invite that has nothing to do with it to work. So it is one value per node — which also means no
//! new column, no gossip record, no last-writer-wins stamp and no change to the invite wire format.

use anyhow::{Result, bail};

/// `meta` key for the domain this node is reachable at.
pub const PUBLIC_ADDRESS_KEY: &str = "sharing.public_address";



/// Both settings, as the API hands them out and takes them back.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SharingSettings {
    /// Origin only (`https://media.example.com`), never a path — see [`normalize_public_address`].
    pub public_address: Option<String>,
}

/// Turn what somebody typed into the origin an invite link can be built from.
///
/// Accepts a bare hostname and assumes `https`, the same courtesy the app's own field extends
/// (`utils/mesh/coordinator.ts`), and returns `Ok(None)` for an empty value because clearing the
/// setting is a normal thing to do rather than an error.
///
/// Three refusals, each of which would otherwise produce a link that looks right and does not work:
///
/// - **A bare IP address.** A residential address rotates, so the link goes stale; no public
///   certificate authority will issue for one; and behind carrier-grade NAT there is no inbound
///   address to put in a link in the first place. A domain is the requirement, not a static IP —
///   dynamic DNS or an outbound tunnel both satisfy it.
/// - **Plain `http`, except on loopback.** The app it opens is a browser app: outside a secure
///   context `crypto.randomUUID` and secure storage are simply absent, which is the crash this
///   fork already hit once on LAN origins. Loopback is exempt because browsers treat it as secure
///   and somebody developing against their own machine needs it.
/// - **A single-label host** (`nas`, `localhost` aside). Nothing outside the local network can
///   resolve it, so the link only works for people who did not need it.
pub fn normalize_public_address(input: &str) -> Result<Option<String>> {
    let raw = input.trim();
    if raw.is_empty() {
        return Ok(None);
    }

    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let url: url::Url = with_scheme
        .parse()
        .map_err(|e| anyhow::anyhow!("that is not an address: {e}"))?;

    let Some(host) = url.host_str() else {
        bail!("that address has no hostname");
    };
    let loopback = host == "localhost" || host == "127.0.0.1" || host == "[::1]";

    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        "http" => bail!(
            "use https: a browser opening an http address has no secure storage, so signing in there fails"
        ),
        other => bail!("{other} is not a web address"),
    }

    // `url` keeps IPv6 in brackets, so the bracket test is the IPv6 test.
    let is_ip = host.parse::<std::net::IpAddr>().is_ok() || host.starts_with('[');
    if is_ip && !loopback {
        bail!(
            "an invite link needs a domain, not an IP address: home addresses change, and browsers refuse a certificate for one"
        );
    }
    if !host.contains('.') && !loopback {
        bail!("{host} is not a domain anyone outside your network can look up");
    }

    // An origin, not a URL: everything appended to it is an absolute path, and a trailing slash
    // would show up in the middle of a link as `https://host//join`.
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    Ok(Some(format!("{}://{host}{port}", url.scheme())))
}

/// The link an invite should be handed out as, or `None` when this node has no address to build
/// one from.
///
/// **This node's own address, or nothing.** It used to fall back to the group's coordinator, which
/// worked but meant the coordinator's `/join` page read the code out of the fragment in the
/// visitor's browser in order to redirect — a real exposure, recorded in `docs/SECURITY.md`. With
/// the coordinator gone (Part 5) the fallback goes with it, and the honest answer for a node that
/// has set no address is `None`: the caller shows the bare code, which is exactly what happens for
/// somebody who has configured nothing.
pub fn invite_link(public_address: Option<&str>, code: &str) -> Option<String> {
    let host = match public_address {
        Some(a) if !a.is_empty() => a.trim_end_matches('/').to_string(),
        _ => return None,
    };
    // The code rides in the fragment, which a browser never puts on the wire. Without that it would
    // sit in the access log of every server and proxy the link passed through, and the code carries
    // the group secret.
    Some(format!("{host}/join#{code}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_domain_becomes_an_https_origin() {
        assert_eq!(
            normalize_public_address("media.example.com").unwrap(),
            Some("https://media.example.com".into())
        );
        assert_eq!(
            normalize_public_address("  https://media.example.com/  ").unwrap(),
            Some("https://media.example.com".into())
        );
        assert_eq!(
            normalize_public_address("https://media.example.com:8790").unwrap(),
            Some("https://media.example.com:8790".into())
        );
    }

    #[test]
    fn clearing_the_setting_is_not_an_error() {
        assert_eq!(normalize_public_address("").unwrap(), None);
        assert_eq!(normalize_public_address("   ").unwrap(), None);
    }

    /// The three refusals, each standing in for a link that would look fine and fail later.
    #[test]
    fn an_address_a_link_cannot_be_built_from_is_refused() {
        for bad in [
            "203.0.113.9",
            "http://203.0.113.9",
            "https://203.0.113.9",
            "[2001:db8::1]",
            "http://media.example.com",
            "nas",
            "ftp://media.example.com",
        ] {
            assert!(
                normalize_public_address(bad).is_err(),
                "{bad} should not be accepted as a public address"
            );
        }
    }

    #[test]
    fn loopback_is_allowed_because_a_browser_treats_it_as_secure() {
        assert_eq!(
            normalize_public_address("http://localhost:8790").unwrap(),
            Some("http://localhost:8790".into())
        );
        assert_eq!(
            normalize_public_address("http://127.0.0.1:8790").unwrap(),
            Some("http://127.0.0.1:8790".into())
        );
    }

    /// A node with no address of its own has no link to give, and says so rather than inventing
    /// one. There used to be a fallback to the group's coordinator; it is gone with the
    /// coordinator, and `None` means the caller shows the bare code.
    #[test]
    fn a_link_needs_this_nodes_own_address() {
        assert_eq!(
            invite_link(Some("https://media.example.com"), "CODE"),
            Some("https://media.example.com/join#CODE".into())
        );
        assert_eq!(invite_link(None, "CODE"), None);
        assert_eq!(invite_link(Some(""), "CODE"), None);
    }

    /// A stored address may or may not carry a trailing slash; appending `/join` to one that does
    /// gives `https://host//join`, which is a different path.
    #[test]
    fn a_link_never_doubles_the_slash() {
        let link = invite_link(Some("https://media.example.com/"), "CODE").unwrap();
        assert!(!link.contains("//join"), "{link}");
        assert_eq!(link, "https://media.example.com/join#CODE");
    }

    #[test]
    fn the_code_rides_in_the_fragment_so_no_server_logs_it() {
        let link = invite_link(Some("https://media.example.com"), "CODE").unwrap();
        let (path, fragment) = link.split_once('#').expect("a link carries a fragment");
        assert!(path.ends_with("/join"), "{path}");
        assert_eq!(fragment, "CODE");
    }
}
