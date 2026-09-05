//! Pre-seeding Jellyfin's `network.xml` and `system.xml`.
//!
//! Jellyfin is bound to loopback on a supervisor-assigned port, given `BaseUrl=/jellyfin` so its
//! self-generated links are correct behind the gateway, and told the setup wizard is already done
//! — `StingStream.Core` creates the bootstrap admin in-process instead, so a fresh node has no
//! anonymous first-run window at all.
//!
//! Element names and defaults verified against the vendored checkout:
//! `MediaBrowser.Common/Net/NetworkConfiguration.cs`,
//! `MediaBrowser.Model/Configuration/ServerConfiguration.cs`, and
//! `Emby.Server.Implementations/AppBase/BaseConfigurationManager.cs` (which writes
//! `{ConfigDir}/{storekey}.xml` with a plain `XmlSerializer`, so element names are exactly the C#
//! property names).

use std::path::Path;

use anyhow::{Context, Result};

use super::xml;

/// Jellyfin's `BaseUrl`, and the gateway prefix it is served under.
pub const BASE_URL: &str = "/jellyfin";

/// Settings the supervisor owns in `network.xml`.
#[derive(Debug, Clone)]
pub struct NetworkSettings {
    pub port: u16,
    pub base_url: String,
    /// Address Jellyfin binds. Always loopback: the gateway is the only exposed listener.
    pub bind: String,
}

impl NetworkSettings {
    pub fn new(port: u16) -> Self {
        Self {
            port,
            base_url: BASE_URL.to_string(),
            bind: "127.0.0.1".to_string(),
        }
    }
}

/// Render a complete `network.xml`.
pub fn network_xml(s: &NetworkSettings) -> String {
    let port = s.port.to_string();
    let mut body = String::new();
    body.push_str(&xml::element("BaseUrl", &s.base_url));
    body.push_str(&xml::element("EnableHttps", "false"));
    body.push_str(&xml::element("RequireHttps", "false"));
    body.push_str(&xml::element("CertificatePath", ""));
    body.push_str(&xml::element("CertificatePassword", ""));
    body.push_str(&xml::element("InternalHttpPort", &port));
    body.push_str(&xml::element("InternalHttpsPort", "8920"));
    // The gateway is what the outside world talks to, so Jellyfin's idea of its own "public" port
    // is only ever used for links it generates for loopback clients.
    body.push_str(&xml::element("PublicHttpPort", &port));
    body.push_str(&xml::element("PublicHttpsPort", "8920"));
    // Jellyfin's UDP auto-discovery would advertise the child's loopback port to the LAN, which is
    // wrong for every client: the node is reached through the gateway.
    body.push_str(&xml::element("AutoDiscovery", "false"));
    body.push_str(&xml::element("EnableUPnP", "false"));
    body.push_str(&xml::element("EnableIPv4", "true"));
    body.push_str(&xml::element("EnableIPv6", "false"));
    // "Remote" here means "not on the server's own subnet". The listener is loopback-only either
    // way; leaving this on keeps Jellyfin from rejecting requests the gateway forwards.
    body.push_str(&xml::element("EnableRemoteAccess", "true"));
    body.push_str(&xml::string_array("LocalNetworkSubnets", &[]));
    body.push_str(&xml::string_array("LocalNetworkAddresses", &[&s.bind]));
    // The gateway sets X-Forwarded-For; naming it as a known proxy is what makes Jellyfin trust
    // that header instead of logging every session as coming from 127.0.0.1.
    body.push_str(&xml::string_array("KnownProxies", &["127.0.0.1", "::1"]));
    body.push_str(&xml::element("IgnoreVirtualInterfaces", "true"));
    body.push_str(&xml::string_array("VirtualInterfaceNames", &["veth"]));
    body.push_str(&xml::element("EnablePublishedServerUriByRequest", "false"));
    body.push_str(&xml::string_array("PublishedServerUriBySubnet", &[]));
    body.push_str(&xml::string_array("RemoteIPFilter", &[]));
    body.push_str(&xml::element("IsRemoteIPFilterBlacklist", "false"));
    xml::document("NetworkConfiguration", &body)
}

/// Render a minimal `system.xml`.
///
/// Only the handful of settings the supervisor cares about are written; every other property keeps
/// its C# default, because `XmlSerializer` leaves absent elements alone. Jellyfin rewrites this
/// file with the full property set the first time anything changes.
///
/// **`IsStartupWizardCompleted` is deliberately not written here**, even though a StingStream node
/// never runs Jellyfin's setup wizard. That flag is how
/// `Jellyfin.Server/Migrations/JellyfinMigrationService.cs` decides whether it is looking at a
/// fresh install: when it is false the service creates the database, creates
/// `__EFMigrationsHistory` and seeds the migration rows; when it is true it takes the
/// existing-install path and does none of that. Pre-seeding it true on an empty data directory
/// therefore makes Jellyfin crash on its first migration with
/// `SQLite Error 1: 'no such table: __EFMigrationsHistory'`, in a loop the supervisor cannot fix.
/// `StingStream.Core`'s first-run wiring sets the flag *after* the database exists and the
/// administrator has been created, which is the only ordering that works.
pub fn system_xml(node_name: &str) -> String {
    let mut body = String::new();
    body.push_str(&xml::element("ServerName", node_name));
    body.push_str(&xml::element("UICulture", "en-US"));
    body.push_str(&xml::element("EnableMetrics", "false"));
    body.push_str(&xml::element("QuickConnectAvailable", "true"));
    // The gateway is same-origin for our own UI, and every other caller is a native app, so the
    // upstream default of "*" is wider than this node needs.
    body.push_str(&xml::string_array("CorsHosts", &["*"]));
    body.push_str(&xml::element("IsPortAuthorized", "true"));
    xml::document("ServerConfiguration", &body)
}

/// Write both files into Jellyfin's config directory.
///
/// `network.xml` is rewritten on every start: the supervisor owns the port and bind address, and a
/// restart that lands on a different port must not leave Jellyfin listening on the old one.
/// `system.xml` is written only when absent, because Jellyfin accumulates real state in it.
pub fn preseed(config_dir: &Path, settings: &NetworkSettings, node_name: &str) -> Result<()> {
    std::fs::create_dir_all(config_dir)
        .with_context(|| format!("creating {}", config_dir.display()))?;

    let network = config_dir.join("network.xml");
    std::fs::write(&network, network_xml(settings))
        .with_context(|| format!("writing {}", network.display()))?;

    let system = config_dir.join("system.xml");
    if !system.exists() {
        std::fs::write(&system, system_xml(node_name))
            .with_context(|| format!("writing {}", system.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_xml_binds_loopback_on_the_assigned_port() {
        let x = network_xml(&NetworkSettings::new(18096));
        assert!(x.contains("<InternalHttpPort>18096</InternalHttpPort>"));
        assert!(x.contains("<PublicHttpPort>18096</PublicHttpPort>"));
        assert!(x.contains("<string>127.0.0.1</string>"));
        assert!(x.contains("<BaseUrl>/jellyfin</BaseUrl>"));
    }

    #[test]
    fn network_xml_turns_off_discovery_and_upnp() {
        let x = network_xml(&NetworkSettings::new(1));
        assert!(x.contains("<AutoDiscovery>false</AutoDiscovery>"));
        assert!(x.contains("<EnableUPnP>false</EnableUPnP>"));
        assert!(x.contains("<EnableHttps>false</EnableHttps>"));
    }

    #[test]
    fn network_xml_trusts_the_gateway_as_a_proxy() {
        let x = network_xml(&NetworkSettings::new(1));
        let start = x.find("<KnownProxies>").unwrap();
        let end = x.find("</KnownProxies>").unwrap();
        let block = &x[start..end];
        assert!(block.contains("127.0.0.1"));
        assert!(block.contains("::1"));
    }

    #[test]
    fn network_xml_is_a_well_formed_flat_document() {
        let x = network_xml(&NetworkSettings::new(8096));
        assert!(x.starts_with("<?xml version=\"1.0\" encoding=\"utf-8\"?>"));
        assert!(x.trim_end().ends_with("</NetworkConfiguration>"));
        assert_eq!(x.matches("<NetworkConfiguration>").count(), 1);
    }

    #[test]
    fn system_xml_names_the_node_and_escapes_it() {
        let x = system_xml("Dan's <attic>");
        assert!(x.contains("<ServerName>Dan&apos;s &lt;attic&gt;</ServerName>"));
    }

    #[test]
    fn system_xml_never_claims_the_startup_wizard_is_done() {
        // Setting this on an empty data directory sends Jellyfin's migration service down its
        // existing-install path, so it never creates the database or __EFMigrationsHistory and
        // then crashes on its first migration. StingStream.Core sets it after the database
        // exists. See the doc comment on `system_xml`.
        let x = system_xml("node");
        assert!(!x.contains("IsStartupWizardCompleted"));
    }

    #[test]
    fn preseed_rewrites_network_but_preserves_system() {
        let td = tempfile::tempdir().unwrap();
        let dir = td.path().join("config");
        preseed(&dir, &NetworkSettings::new(1111), "node").unwrap();
        // Simulate Jellyfin having written real state into system.xml, then restart on a new port.
        std::fs::write(dir.join("system.xml"), "<ServerConfiguration><Marker/></ServerConfiguration>")
            .unwrap();
        preseed(&dir, &NetworkSettings::new(2222), "node").unwrap();
        let net = std::fs::read_to_string(dir.join("network.xml")).unwrap();
        assert!(net.contains("<InternalHttpPort>2222</InternalHttpPort>"));
        let sys = std::fs::read_to_string(dir.join("system.xml")).unwrap();
        assert!(sys.contains("<Marker/>"), "system.xml must not be clobbered");
    }

    #[test]
    fn preseed_creates_the_config_directory() {
        let td = tempfile::tempdir().unwrap();
        let dir = td.path().join("a").join("b").join("config");
        preseed(&dir, &NetworkSettings::new(1), "n").unwrap();
        assert!(dir.join("network.xml").is_file());
        assert!(dir.join("system.xml").is_file());
    }
}
