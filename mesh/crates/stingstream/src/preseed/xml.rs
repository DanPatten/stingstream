//! A deliberately tiny XML helper for the flat, single-level configuration documents that Radarr,
//! Sonarr and Jellyfin write.
//!
//! Both `config.xml` (`<Config><Port>7878</Port>…</Config>`) and `network.xml`
//! (`<NetworkConfiguration><InternalHttpPort>8096</InternalHttpPort>…</NetworkConfiguration>`) are
//! flat documents of scalar elements, written by .NET's `XmlSerializer` or by NzbDrone's
//! `XDocument`. Pulling in a full XML stack to set six scalars in a document we also generate
//! would be more machinery than the job needs, and the *editing* path exists only so that a
//! restart can correct a port without discarding whatever the child has since written into the
//! same file.
//!
//! The functions here are therefore intentionally narrow: they operate on top-level elements of a
//! flat document only, and they escape everything they write.

/// Escape text for an XML text node.
pub fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

/// One `<Name>value</Name>` line, indented by two spaces.
pub fn element(name: &str, value: &str) -> String {
    format!("  <{name}>{}</{name}>\n", escape(value))
}

/// A `<Name><string>a</string><string>b</string></Name>` block, the shape .NET's `XmlSerializer`
/// produces for a `string[]` property.
pub fn string_array(name: &str, values: &[&str]) -> String {
    if values.is_empty() {
        return format!("  <{name} />\n");
    }
    let mut out = format!("  <{name}>\n");
    for v in values {
        out.push_str(&format!("    <string>{}</string>\n", escape(v)));
    }
    out.push_str(&format!("  </{name}>\n"));
    out
}

/// Wrap elements in a declaration plus root element.
pub fn document(root: &str, body: &str) -> String {
    format!("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<{root}>\n{body}</{root}>\n")
}

/// Replace the text of a top-level `<name>` element, or insert the element before the closing root
/// tag if it is absent.
///
/// Returns the new document. Comments and unrelated elements are preserved, which is the point:
/// a child may have written its own settings into the same file since we last saw it.
pub fn set_element(doc: &str, name: &str, value: &str) -> String {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let escaped = escape(value);

    if let Some(start) = doc.find(&open) {
        if let Some(end_rel) = doc[start..].find(&close) {
            let inner_start = start + open.len();
            let inner_end = start + end_rel;
            if inner_end >= inner_start {
                let mut out = String::with_capacity(doc.len() + escaped.len());
                out.push_str(&doc[..inner_start]);
                out.push_str(&escaped);
                out.push_str(&doc[inner_end..]);
                return out;
            }
        }
    }
    // Self-closing form, `<Name />`.
    let self_closing_variants = [format!("<{name} />"), format!("<{name}/>")];
    for sc in &self_closing_variants {
        if let Some(start) = doc.find(sc.as_str()) {
            let mut out = String::with_capacity(doc.len() + escaped.len());
            out.push_str(&doc[..start]);
            out.push_str(&format!("<{name}>{escaped}</{name}>"));
            out.push_str(&doc[start + sc.len()..]);
            return out;
        }
    }

    // Absent: insert before the last closing tag in the document, which for these flat files is
    // always the root's.
    match doc.rfind("</") {
        Some(idx) => {
            let mut out = String::with_capacity(doc.len() + escaped.len() + name.len() * 2 + 8);
            out.push_str(&doc[..idx]);
            out.push_str(&format!("  <{name}>{escaped}</{name}>\n"));
            out.push_str(&doc[idx..]);
            out
        }
        None => format!("{doc}\n<{name}>{escaped}</{name}>"),
    }
}

/// Read the text of a top-level `<name>` element, unescaped only for the five predefined entities.
pub fn get_element(doc: &str, name: &str) -> Option<String> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = doc.find(&open)? + open.len();
    let end_rel = doc[start..].find(&close)?;
    let raw = &doc[start..start + end_rel];
    Some(
        raw.replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            // `&amp;` must be last so `&amp;lt;` does not decode twice.
            .replace("&amp;", "&"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_covers_the_five_predefined_entities() {
        assert_eq!(escape("a&b<c>d\"e'f"), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
    }

    #[test]
    fn set_element_replaces_existing_text() {
        let doc = "<Config>\n  <Port>7878</Port>\n  <UrlBase></UrlBase>\n</Config>\n";
        let out = set_element(doc, "Port", "9999");
        assert!(out.contains("<Port>9999</Port>"));
        assert!(out.contains("<UrlBase></UrlBase>"), "other elements survive");
    }

    #[test]
    fn set_element_fills_an_empty_element() {
        let doc = "<Config>\n  <UrlBase></UrlBase>\n</Config>\n";
        assert!(set_element(doc, "UrlBase", "/radarr").contains("<UrlBase>/radarr</UrlBase>"));
    }

    #[test]
    fn set_element_handles_a_self_closing_element() {
        for doc in [
            "<Config>\n  <UrlBase />\n</Config>\n",
            "<Config>\n  <UrlBase/>\n</Config>\n",
        ] {
            let out = set_element(doc, "UrlBase", "/radarr");
            assert!(out.contains("<UrlBase>/radarr</UrlBase>"), "{out}");
            assert!(!out.contains("<UrlBase /"), "{out}");
        }
    }

    #[test]
    fn set_element_inserts_a_missing_element_before_the_root_close() {
        let doc = "<Config>\n  <Port>7878</Port>\n</Config>\n";
        let out = set_element(doc, "ApiKey", "abc");
        assert!(out.contains("<ApiKey>abc</ApiKey>"));
        assert!(out.trim_end().ends_with("</Config>"));
        assert!(out.find("<ApiKey>").unwrap() < out.find("</Config>").unwrap());
    }

    #[test]
    fn set_element_escapes_the_value_it_writes() {
        let doc = "<Config>\n  <InstanceName>x</InstanceName>\n</Config>\n";
        let out = set_element(doc, "InstanceName", "Dan & <friends>");
        assert!(out.contains("<InstanceName>Dan &amp; &lt;friends&gt;</InstanceName>"));
    }

    #[test]
    fn set_element_is_idempotent() {
        let doc = "<Config>\n  <Port>1</Port>\n</Config>\n";
        let once = set_element(doc, "Port", "2");
        assert_eq!(once, set_element(&once, "Port", "2"));
    }

    #[test]
    fn get_element_round_trips_with_set_element() {
        let doc = document("Config", &element("Port", "7878"));
        assert_eq!(get_element(&doc, "Port").as_deref(), Some("7878"));
        let doc = set_element(&doc, "Port", "8080");
        assert_eq!(get_element(&doc, "Port").as_deref(), Some("8080"));
    }

    #[test]
    fn get_element_unescapes_without_double_decoding() {
        let doc = document("Config", &element("Name", "a &amp; b"));
        // element() escaped "a &amp; b" into "a &amp;amp; b", so the round trip yields the input.
        assert_eq!(get_element(&doc, "Name").as_deref(), Some("a &amp; b"));
    }

    #[test]
    fn get_element_returns_none_for_an_absent_element() {
        assert!(get_element("<Config></Config>", "Port").is_none());
    }

    #[test]
    fn string_array_matches_the_dotnet_xmlserializer_shape() {
        assert_eq!(
            string_array("LocalNetworkAddresses", &["127.0.0.1"]),
            "  <LocalNetworkAddresses>\n    <string>127.0.0.1</string>\n  </LocalNetworkAddresses>\n"
        );
        assert_eq!(string_array("KnownProxies", &[]), "  <KnownProxies />\n");
    }

    #[test]
    fn document_wraps_with_a_declaration() {
        let d = document("Config", &element("Port", "1"));
        assert!(d.starts_with("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<Config>\n"));
        assert!(d.ends_with("</Config>\n"));
    }
}
