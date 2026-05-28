//! Logical path on the device.
//!
//! MTP has no path namespace — objects live in a handle tree. We carry
//! slash-delimited paths at the API boundary and resolve them to handle chains
//! lazily on each call. Roots and leading slashes are normalized away.

#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct TPath {
    segments: Vec<String>,
}

impl TPath {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn parse(s: &str) -> Self {
        Self {
            segments: s
                .split('/')
                .filter(|seg| !seg.is_empty())
                .map(String::from)
                .collect(),
        }
    }

    pub fn segments(&self) -> &[String] {
        &self.segments
    }

    pub fn name(&self) -> Option<&str> {
        self.segments.last().map(String::as_str)
    }

    pub fn parent(&self) -> Option<TPath> {
        if self.segments.is_empty() {
            None
        } else {
            Some(TPath {
                segments: self.segments[..self.segments.len() - 1].to_vec(),
            })
        }
    }

    pub fn join(&self, name: &str) -> TPath {
        let mut segments = self.segments.clone();
        segments.push(name.to_string());
        TPath { segments }
    }

    pub fn is_empty(&self) -> bool {
        self.segments.is_empty()
    }
}

impl std::fmt::Display for TPath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.segments.join("/"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_drops_empty_segments() {
        let p = TPath::parse("/Documents//Books/foo.epub/");
        assert_eq!(p.segments(), &["Documents", "Books", "foo.epub"]);
    }

    #[test]
    fn parent_and_name() {
        let p = TPath::parse("Documents/Books/foo.epub");
        assert_eq!(p.name(), Some("foo.epub"));
        assert_eq!(format!("{}", p.parent().unwrap()), "Documents/Books");
    }

    #[test]
    fn empty_round_trip() {
        let empty = TPath::new();
        assert!(empty.is_empty());
        assert_eq!(empty.parent(), None);
        assert_eq!(empty.name(), None);
    }
}
