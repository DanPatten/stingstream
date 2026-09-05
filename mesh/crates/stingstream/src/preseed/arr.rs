//! Pre-seeding Radarr's and Sonarr's `config.xml`.
//!
//! Both descend from NzbDrone and share one configuration model, so one renderer serves both with
//! a small [`ArrKind`] difference for the defaults NzbDrone itself would pick.
//!
//! Verified against `server/radarr/src/NzbDrone.Core/Configuration/ConfigFileProvider.cs` and the
//! Sonarr v5 equivalent:
//!
//! * The root element is `Config` and every child element name is the exact PascalCase key the
//!   provider looks up. Values are trimmed; enum parsing is case-insensitive.
//! * `DeleteOldValues()` runs on start-up and **removes any element that is not a public property
//!   of `ConfigFileProvider`**, so nothing custom may be written here.
//! * `AuthenticationEnabled` must be *absent*: when present and true it forces
//!   `AuthenticationMethod` to `Forms` and rewrites the file.
//! * `AuthenticationMethod=External` registers NzbDrone's `NoAuthenticationHandler` — the same
//!   handler as `None` — which is the documented "a reverse proxy is doing the auth" mode. That is
//!   exactly StingStream's shape: the gateway is the only door, and the children are on loopback.

use std::path::Path;

use anyhow::{Context, Result};

use super::xml;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArrKind {
    Radarr,
    Sonarr,
}

impl ArrKind {
    pub fn name(self) -> &'static str {
        match self {
            ArrKind::Radarr => "radarr",
            ArrKind::Sonarr => "sonarr",
        }
    }
    /// NzbDrone's own `InstanceName` default, kept so the child's logs and its API's
    /// `X-Application-Version`-adjacent metadata read normally.
    pub fn instance_name(self) -> &'static str {
        match self {
            ArrKind::Radarr => "Radarr",
            ArrKind::Sonarr => "Sonarr",
        }
    }
    /// Upstream's default branch name, which the updater reports. Radarr's is `master`, Sonarr
    /// v5's is `main`.
    pub fn branch(self) -> &'static str {
        match self {
            ArrKind::Radarr => "master",
            ArrKind::Sonarr => "main",
        }
    }
    pub fn default_port(self) -> u16 {
        match self {
            ArrKind::Radarr => 7878,
            ArrKind::Sonarr => 8989,
        }
    }
    /// The gateway prefix and the child's own `UrlBase`.
    pub fn url_base(self) -> &'static str {
        match self {
            ArrKind::Radarr => "/radarr",
            ArrKind::Sonarr => "/sonarr",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ArrSettings {
    pub kind: ArrKind,
    pub port: u16,
    pub api_key: String,
    pub url_base: String,
    pub bind_address: String,
    pub log_level: String,
}

impl ArrSettings {
    pub fn new(kind: ArrKind, port: u16, api_key: &str) -> Self {
        Self {
            kind,
            port,
            api_key: api_key.to_string(),
            url_base: kind.url_base().to_string(),
            bind_address: "127.0.0.1".to_string(),
            log_level: "info".to_string(),
        }
    }
}

/// Elements the supervisor owns. Anything not listed here is left to NzbDrone's own defaults, and
/// on a restart only these are rewritten so a child's own additions survive.
fn owned_elements(s: &ArrSettings) -> Vec<(&'static str, String)> {
    vec![
        ("BindAddress", s.bind_address.clone()),
        ("Port", s.port.to_string()),
        ("SslPort", "9898".to_string()),
        ("EnableSsl", "False".to_string()),
        ("UrlBase", s.url_base.clone()),
        ("ApiKey", s.api_key.clone()),
        // The gateway is the reverse proxy NzbDrone means by "External": it terminates every
        // request and the child is loopback-only.
        ("AuthenticationMethod", "External".to_string()),
        ("AuthenticationRequired", "DisabledForLocalAddresses".to_string()),
        // A supervised child must never try to open a browser.
        ("LaunchBrowser", "False".to_string()),
        ("AnalyticsEnabled", "False".to_string()),
        // StingStream ships and updates the whole node; a child updating itself out from under
        // the supervisor would replace binaries the supervisor is holding open.
        ("UpdateMechanism", "External".to_string()),
        ("UpdateAutomatically", "False".to_string()),
        ("LogLevel", s.log_level.clone()),
        ("Branch", s.kind.branch().to_string()),
        ("InstanceName", s.kind.instance_name().to_string()),
    ]
}

/// Render a complete `config.xml`.
pub fn config_xml(s: &ArrSettings) -> String {
    let mut body = String::new();
    for (name, value) in owned_elements(s) {
        body.push_str(&xml::element(name, &value));
    }
    // NzbDrone writes `standalone="yes"`; matching it avoids a pointless rewrite on first read.
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\" standalone=\"yes\"?>\n<Config>\n{body}</Config>\n"
    )
}

/// Update only the supervisor-owned elements of an existing `config.xml`.
pub fn patch_config_xml(existing: &str, s: &ArrSettings) -> String {
    let mut doc = existing.to_string();
    for (name, value) in owned_elements(s) {
        doc = xml::set_element(&doc, name, &value);
    }
    // A stale `AuthenticationEnabled` would force AuthenticationMethod back to Forms on the next
    // read, locking the gateway out of a child it is supposed to own.
    doc = remove_element(&doc, "AuthenticationEnabled");
    doc
}

/// Delete a top-level element, including its whole line if it is alone on one.
fn remove_element(doc: &str, name: &str) -> String {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let Some(start) = doc.find(&open) else {
        // Also handle the self-closing form.
        for sc in [format!("<{name} />"), format!("<{name}/>")] {
            if let Some(i) = doc.find(&sc) {
                return trim_line(doc, i, i + sc.len());
            }
        }
        return doc.to_string();
    };
    let Some(end_rel) = doc[start..].find(&close) else {
        return doc.to_string();
    };
    trim_line(doc, start, start + end_rel + close.len())
}

/// Cut `[start, end)` out of `doc`, taking the surrounding blank line with it when the element was
/// the only thing on its line.
fn trim_line(doc: &str, start: usize, end: usize) -> String {
    let line_start = doc[..start].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let only_whitespace_before = doc[line_start..start].trim().is_empty();
    let line_end = doc[end..].find('\n').map(|i| end + i + 1).unwrap_or(doc.len());
    let only_whitespace_after = doc[end..line_end].trim().is_empty();
    if only_whitespace_before && only_whitespace_after {
        format!("{}{}", &doc[..line_start], &doc[line_end..])
    } else {
        format!("{}{}", &doc[..start], &doc[end..])
    }
}

/// Write `config.xml`, creating it or patching the elements we own.
pub fn preseed(data_dir: &Path, s: &ArrSettings) -> Result<()> {
    std::fs::create_dir_all(data_dir)
        .with_context(|| format!("creating {}", data_dir.display()))?;
    let path = data_dir.join("config.xml");
    let contents = match std::fs::read_to_string(&path) {
        Ok(existing) if existing.contains("<Config") => patch_config_xml(&existing, s),
        // A missing, empty or unparseable file is replaced: NzbDrone itself throws
        // `InvalidConfigFileException` on anything that is not exactly one `Config` element, so
        // preserving a broken file helps nobody.
        _ => config_xml(s),
    };
    std::fs::write(&path, contents).with_context(|| format!("writing {}", path.display()))?;
    crate::paths::restrict_to_owner(&path)?;
    Ok(())
}

/// Command-line arguments for `Radarr.Console.exe` / `Sonarr.Console.exe`.
///
/// `StartupContext` trims leading `/`, `-` and `--` and lowercases the key, so `-data=` is one of
/// several equivalent spellings; it is the one upstream's own service wrappers use.
pub fn command_args(data_dir: &Path) -> Vec<String> {
    vec![
        "-nobrowser".to_string(),
        format!("-data={}", data_dir.display()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn radarr() -> ArrSettings {
        ArrSettings::new(ArrKind::Radarr, 17878, "0123456789abcdef0123456789abcdef")
    }

    #[test]
    fn config_xml_carries_the_supervisors_choices() {
        let x = config_xml(&radarr());
        assert!(x.contains("<Port>17878</Port>"));
        assert!(x.contains("<BindAddress>127.0.0.1</BindAddress>"));
        assert!(x.contains("<UrlBase>/radarr</UrlBase>"));
        assert!(x.contains("<ApiKey>0123456789abcdef0123456789abcdef</ApiKey>"));
        assert!(x.contains("<InstanceName>Radarr</InstanceName>"));
        assert!(x.contains("<Branch>master</Branch>"));
    }

    #[test]
    fn config_xml_disables_auth_for_the_gateway_and_never_writes_the_legacy_flag() {
        let x = config_xml(&radarr());
        assert!(x.contains("<AuthenticationMethod>External</AuthenticationMethod>"));
        assert!(x.contains("<AuthenticationRequired>DisabledForLocalAddresses</AuthenticationRequired>"));
        assert!(
            !x.contains("AuthenticationEnabled"),
            "the legacy flag forces Forms auth and must never be written"
        );
    }

    #[test]
    fn config_xml_stops_the_child_updating_or_launching_a_browser() {
        let x = config_xml(&radarr());
        assert!(x.contains("<LaunchBrowser>False</LaunchBrowser>"));
        assert!(x.contains("<UpdateAutomatically>False</UpdateAutomatically>"));
        assert!(x.contains("<UpdateMechanism>External</UpdateMechanism>"));
        assert!(x.contains("<AnalyticsEnabled>False</AnalyticsEnabled>"));
    }

    #[test]
    fn sonarr_gets_its_own_defaults() {
        let x = config_xml(&ArrSettings::new(ArrKind::Sonarr, 18989, "k"));
        assert!(x.contains("<Port>18989</Port>"));
        assert!(x.contains("<UrlBase>/sonarr</UrlBase>"));
        assert!(x.contains("<InstanceName>Sonarr</InstanceName>"));
        assert!(x.contains("<Branch>main</Branch>"));
    }

    #[test]
    fn config_xml_is_a_single_config_document_with_a_declaration() {
        let x = config_xml(&radarr());
        assert!(x.starts_with("<?xml version=\"1.0\" encoding=\"utf-8\" standalone=\"yes\"?>"));
        assert_eq!(x.matches("<Config>").count(), 1);
        assert_eq!(x.matches("</Config>").count(), 1);
    }

    #[test]
    fn patching_rewrites_owned_elements_and_keeps_the_childs_own() {
        let existing = "<?xml version=\"1.0\"?>\n<Config>\n  <Port>7878</Port>\n  \
                        <ApiKey>old</ApiKey>\n  <Theme>dark</Theme>\n</Config>\n";
        let out = patch_config_xml(existing, &radarr());
        assert!(out.contains("<Port>17878</Port>"));
        assert!(out.contains("<ApiKey>0123456789abcdef0123456789abcdef</ApiKey>"));
        assert!(out.contains("<Theme>dark</Theme>"), "the child's own setting must survive");
        assert!(out.contains("<UrlBase>/radarr</UrlBase>"), "missing elements are inserted");
    }

    #[test]
    fn patching_removes_a_stale_authentication_enabled_flag() {
        let existing = "<Config>\n  <AuthenticationEnabled>True</AuthenticationEnabled>\n  \
                        <Port>1</Port>\n</Config>\n";
        let out = patch_config_xml(existing, &radarr());
        assert!(!out.contains("AuthenticationEnabled"), "{out}");
        assert!(out.contains("<Port>17878</Port>"));
    }

    #[test]
    fn patching_is_idempotent() {
        let once = config_xml(&radarr());
        assert_eq!(patch_config_xml(&once, &radarr()), once);
    }

    #[test]
    fn preseed_creates_then_patches() {
        let td = tempfile::tempdir().unwrap();
        let dir = td.path().join("radarr");
        preseed(&dir, &radarr()).unwrap();
        let path = dir.join("config.xml");
        assert!(path.is_file());

        // The child adds a setting of its own, then we restart on a different port.
        let mut doc = std::fs::read_to_string(&path).unwrap();
        doc = xml::set_element(&doc, "Theme", "dark");
        std::fs::write(&path, doc).unwrap();

        let mut moved = radarr();
        moved.port = 27878;
        preseed(&dir, &moved).unwrap();
        let doc = std::fs::read_to_string(&path).unwrap();
        assert!(doc.contains("<Port>27878</Port>"));
        assert!(doc.contains("<Theme>dark</Theme>"));
    }

    #[test]
    fn preseed_replaces_a_corrupt_config_rather_than_patching_it() {
        let td = tempfile::tempdir().unwrap();
        let dir = td.path().join("sonarr");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.xml"), "").unwrap();
        preseed(&dir, &ArrSettings::new(ArrKind::Sonarr, 1, "k")).unwrap();
        let doc = std::fs::read_to_string(dir.join("config.xml")).unwrap();
        assert!(doc.contains("<Config>"));
        assert!(doc.contains("<Port>1</Port>"));
    }

    #[test]
    fn command_args_match_nzbdrones_startup_parser() {
        let args = command_args(Path::new("/data/radarr"));
        assert_eq!(args[0], "-nobrowser");
        assert!(args[1].starts_with("-data="));
        assert!(args[1].ends_with("radarr"));
    }

    #[test]
    fn remove_element_takes_the_whole_line_when_it_owns_one() {
        let doc = "<Config>\n  <A>1</A>\n  <B>2</B>\n</Config>\n";
        assert_eq!(remove_element(doc, "A"), "<Config>\n  <B>2</B>\n</Config>\n");
    }

    #[test]
    fn remove_element_handles_inline_and_self_closing_forms() {
        assert_eq!(remove_element("<C><A>1</A><B>2</B></C>", "A"), "<C><B>2</B></C>");
        assert_eq!(remove_element("<C><A /><B>2</B></C>", "A"), "<C><B>2</B></C>");
    }

    #[test]
    fn remove_element_is_a_no_op_when_absent() {
        assert_eq!(remove_element("<C><B>2</B></C>", "A"), "<C><B>2</B></C>");
    }
}
