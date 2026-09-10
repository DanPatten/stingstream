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

/// `meta` keys for the tunnel this node should be running, if any.
///
/// **Desired state, not observed state.** These four say what the owner asked for; whether it is
/// actually up is the supervisor's business, reported back over `PUT /settings/sidedoor` and held
/// in memory. Storing "connected" would mean a node that died mid-tunnel came back claiming a
/// tunnel that is not running.
///
/// Deliberately absent: the Cloudflare API token. It is used once, to create the tunnel and its
/// DNS record, and then discarded — it grants DNS edit on somebody's zone, and `meta` is a plain
/// table in `mesh.db`. [`TunnelToken`] is where it lives for the seconds it exists.
pub const TUNNEL_KIND_KEY: &str = "tunnel.kind";
pub const TUNNEL_HOSTNAME_KEY: &str = "tunnel.hostname";
pub const TUNNEL_ID_KEY: &str = "tunnel.id";
pub const TUNNEL_NAME_KEY: &str = "tunnel.name";

/// Which kind of tunnel the owner asked for.
///
/// One kind, and a `None`. There was briefly a second — Cloudflare's account-free `quick` tunnel,
/// which is handed a fresh `*.trycloudflare.com` name on every start. Dan cut it on sight: *"they
/// either configure a domain manually OR via cloudflare"*. It was right to cut. An address that
/// changes every restart cannot be sent to anybody, cannot carry a passkey, and made every screen
/// that touched it explain a caveat — while the page's whole job is to end up with one address that
/// keeps working.
///
/// The variant stays parseable so a node that ran one downgrades quietly rather than refusing to
/// start; it reads as `None`, which stops the tunnel.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TunnelKind {
    #[default]
    None,
    Named,
}

impl TunnelKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Named => "named",
        }
    }

    /// Anything unrecognised is `None`, which is also what an absent key reads as.
    ///
    /// A downgrade has to be survivable: a node that once ran a kind of tunnel a later build
    /// removed must come up with no tunnel rather than refusing to start. `quick` is exactly that
    /// case now.
    pub fn parse(raw: &str) -> Self {
        match raw.trim() {
            "named" => Self::Named,
            _ => Self::None,
        }
    }
}

/// The tunnel this node should be running, as stored.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TunnelSettings {
    pub kind: TunnelKind,
    /// The name this tunnel answers on.
    pub hostname: Option<String>,
    /// Cloudflare's id for a `Named` tunnel, so it can be deleted again.
    pub id: Option<String>,
    /// What the tunnel is called in the Cloudflare dashboard.
    pub name: Option<String>,
}

/// Turn a hostname somebody typed into the bare name a DNS record can be made for.
///
/// [`normalize_public_address`] is the wrong tool here even though it looks like the right one: it
/// returns an *origin* (`https://media.example.com`), and a CNAME's name is a hostname. Its
/// refusals are the ones that matter, though, and they are re-run here through it — so an IP
/// address, a single label and a `http://` prefix are rejected with the same words in both places.
pub fn normalize_tunnel_hostname(input: &str) -> Result<String> {
    let origin = normalize_public_address(input)?
        .ok_or_else(|| anyhow::anyhow!("a tunnel needs a hostname"))?;
    let url: url::Url = origin.parse()?;
    let host = url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("that address has no hostname"))?;

    // A loopback address cannot be routed from Cloudflare, so the exemption
    // `normalize_public_address` makes for `localhost` must not survive into here.
    if host == "localhost" || host == "127.0.0.1" || host.starts_with('[') {
        bail!("a tunnel needs a domain Cloudflare can create a record for, not a local address");
    }
    Ok(host.to_string())
}

/// A tunnel name Cloudflare will accept, derived from the hostname.
///
/// Cloudflare shows this in the dashboard beside tunnels made by hand, so it says what it is and
/// which machine it belongs to. Dots are not allowed in a tunnel name.
pub fn tunnel_name_for(hostname: &str) -> String {
    format!("stingstream-{}", hostname.replace('.', "-"))
}



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

/// How far the supervisor got with the tunnel it was asked for.
///
/// Four states rather than a boolean, for the reason [`crate::sidedoor`] splits `off` from
/// `no_certificate`: "nothing was asked for", "it is coming up" and "it is broken" send somebody
/// to three different places, and a page that collapses them sends them to the wrong one.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TunnelState {
    #[default]
    Off,
    Starting,
    Connected,
    Error,
}

impl TunnelState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Starting => "starting",
            Self::Connected => "connected",
            Self::Error => "error",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw.trim() {
            "starting" => Self::Starting,
            "connected" => Self::Connected,
            "error" => Self::Error,
            _ => Self::Off,
        }
    }
}

/// What the supervisor reports about the tunnel, and what the Domains page reads back.
///
/// Held in memory rather than in `meta` because it is a fact about a running process. A node that
/// is restarted has no tunnel until the supervisor starts one and says so, and persisting
/// `Connected` would make the page confidently wrong for the first minute of every boot.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TunnelReport {
    pub state: TunnelState,
    /// The name it came up on.
    pub hostname: Option<String>,
    /// Why it is starting or broken, in words fit to put on screen.
    pub detail: Option<String>,
    /// Whether `cloudflared` exists on this machine at all.
    pub binary_present: bool,
}

/// The single-use Cloudflare API token, in memory, between the request that set it and the
/// reconcile that spends it.
///
/// This is the one piece of the design that is a deliberate inconvenience. The token grants
/// `Zone:DNS:Edit` on somebody's real domain, and the alternatives were both worse: writing it to
/// `meta` puts a live credential in a plain SQLite table that every backup copies, and asking
/// Cloudflare to mint a scoped-down one needs a token to start with. So it lives here, is taken by
/// the first reconcile that needs it, and is gone.
///
/// The cost is honest and small: if the node is restarted in the seconds between pressing the
/// button and the tunnel being created, the token is lost and the page asks for it again.
#[derive(Debug, Default)]
pub struct TunnelToken(std::sync::Mutex<Option<String>>);

impl TunnelToken {
    pub fn set(&self, token: String) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(token);
    }

    /// Read it and clear it in one move, so it cannot be spent twice.
    pub fn take(&self) -> Option<String> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    pub fn clear(&self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// What the supervisor last observed about this node's own front door.
///
/// The supervisor owns the gateway, the certificate store and the port mapper, so it is the only
/// part of a node that can answer any of this — and it already pushes here on a timer for the LAN
/// URLs. The rest rides along on the same call rather than opening a second channel.
///
/// Read back by the Domains page over an *authenticated* endpoint. The same facts are in
/// `/healthz`, but that is redacted for off-machine callers because it carries child ports and the
/// data directory, so a browser reaching this server through the very tunnel the page set up would
/// see a hollowed-out version of the page that set it up.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SideDoorObservation {
    /// Plain-HTTP URLs this node answers on inside the house.
    pub lan_urls: Vec<String>,
    /// `off`, `no_certificate` or `ready` — the supervisor's own word, passed through unchanged.
    pub https: String,
    pub certificate_names: Vec<String>,
    pub certificate_expires: Option<String>,
    /// This node's address as the world sees it, when the port mapper could learn one.
    ///
    /// `None` behind carrier-grade NAT, which is itself the answer to why somebody's port
    /// forwarding never worked — so its absence is information, not a missing value.
    pub public_ip: Option<String>,
}

/// The live half of the Domains page: what the supervisor last said, and the token it has not yet
/// spent.
///
/// All of it in memory, and all of it deliberately so. The observation is about a running gateway
/// and the report is about a running process; a node that has just started has neither, and
/// persisting either would make the page confidently wrong for the first minute of every boot.
#[derive(Debug, Default)]
pub struct DomainsState {
    observation: std::sync::Mutex<SideDoorObservation>,
    report: std::sync::Mutex<TunnelReport>,
    /// The single-use Cloudflare API token. See [`TunnelToken`].
    pub token: TunnelToken,
}

impl DomainsState {
    pub fn observation(&self) -> SideDoorObservation {
        self.observation
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn set_observation(&self, next: SideDoorObservation) {
        *self.observation.lock().unwrap_or_else(|e| e.into_inner()) = next;
    }

    pub fn report(&self) -> TunnelReport {
        self.report.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn set_report(&self, next: TunnelReport) {
        *self.report.lock().unwrap_or_else(|e| e.into_inner()) = next;
    }
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

    /// A CNAME's name is a hostname, not an origin -- the difference this function exists for.
    #[test]
    fn a_tunnel_hostname_is_bare() {
        assert_eq!(
            normalize_tunnel_hostname("media.example.com").unwrap(),
            "media.example.com"
        );
        assert_eq!(
            normalize_tunnel_hostname(" https://media.example.com/ ").unwrap(),
            "media.example.com"
        );
    }

    /// The address field's refusals are re-run here, so the same mistake is refused in the same
    /// words wherever somebody makes it.
    #[test]
    fn a_hostname_cloudflare_cannot_route_is_refused() {
        for bad in ["", "   ", "nas", "203.0.113.9", "http://media.example.com"] {
            assert!(
                normalize_tunnel_hostname(bad).is_err(),
                "{bad} should not be accepted as a tunnel hostname"
            );
        }
    }

    /// Loopback is fine for the *address* setting, because a browser treats it as secure. It is
    /// nonsense for a tunnel, and the exemption must not leak through.
    #[test]
    fn loopback_is_not_a_tunnel_hostname() {
        for local in ["http://localhost:8790", "http://127.0.0.1:8790"] {
            assert!(
                normalize_tunnel_hostname(local).is_err(),
                "{local} should not be accepted as a tunnel hostname"
            );
        }
    }

    #[test]
    fn a_tunnel_name_has_no_dots_in_it() {
        // Cloudflare refuses them, and the name is what the dashboard shows beside tunnels made
        // by hand -- so it also has to say which machine it belongs to.
        let name = tunnel_name_for("media.example.com");
        assert!(!name.contains('.'), "{name}");
        assert_eq!(name, "stingstream-media-example-com");
    }

    /// Both directions, and both fall back to the quietest value. A node that once ran a kind or
    /// reached a state a later build removed has to come up, not refuse to.
    #[test]
    fn tunnel_words_round_trip_and_unknown_ones_are_quiet() {
        for kind in [TunnelKind::None, TunnelKind::Named] {
            assert_eq!(TunnelKind::parse(kind.as_str()), kind);
        }
        assert_eq!(TunnelKind::parse("wireguard"), TunnelKind::None);
        assert_eq!(TunnelKind::parse(""), TunnelKind::None);
        // The kind this build dropped. A node that ran one has the word in its `meta` table, and
        // reading it as "no tunnel" is what stops the process instead of refusing to boot.
        assert_eq!(TunnelKind::parse("quick"), TunnelKind::None);

        for state in [
            TunnelState::Off,
            TunnelState::Starting,
            TunnelState::Connected,
            TunnelState::Error,
        ] {
            assert_eq!(TunnelState::parse(state.as_str()), state);
        }
        assert_eq!(TunnelState::parse("degraded"), TunnelState::Off);
    }

    /// The token is spendable exactly once. Taking it twice is how a retry would resurrect a
    /// credential the first attempt was supposed to have consumed.
    #[test]
    fn the_api_token_can_only_be_spent_once() {
        let token = TunnelToken::default();
        assert_eq!(token.take(), None);

        token.set("cf-token".into());
        assert_eq!(token.take(), Some("cf-token".into()));
        assert_eq!(token.take(), None);

        token.set("another".into());
        token.clear();
        assert_eq!(token.take(), None);
    }

    #[test]
    fn the_code_rides_in_the_fragment_so_no_server_logs_it() {
        let link = invite_link(Some("https://media.example.com"), "CODE").unwrap();
        let (path, fragment) = link.split_once('#').expect("a link carries a fragment");
        assert!(path.ends_with("/join"), "{path}");
        assert_eq!(fragment, "CODE");
    }
}
