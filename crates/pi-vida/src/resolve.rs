use std::path::{Path, PathBuf};

use crate::profile::Profile;

/// Skill identity manifest (schema 1) — mirrors `.dotskills-manifest.json`.
struct Manifest {
    skills: std::collections::BTreeMap<String, ManifestEntry>,
}

#[derive(serde::Deserialize)]
struct ManifestEntry {
    path: String,
}

impl Manifest {
    /// Read + validate (INV-3/INV-7): foreign schema or malformed document
    /// fails closed. Missing file = no entries (legacy installs only).
    fn read(skills_home: &Path) -> Result<Self, String> {
        let file = skills_home.join(".dotskills-manifest.json");
        if !file.is_file() {
            return Ok(Self {
                skills: Default::default(),
            });
        }
        let text = std::fs::read_to_string(&file).map_err(|e| {
            format!("invalid skill identity manifest: {}: {e}", file.display())
        })?;
        #[derive(serde::Deserialize)]
        struct Doc {
            schema_version: serde_json::Value,
            skills: serde_json::Value,
        }
        let doc: Doc = serde_json::from_str(&text).map_err(|e| {
            format!("invalid skill identity manifest: {}: {e}", file.display())
        })?;
        if doc.schema_version != serde_json::Value::Number(1.into())
            || !doc.skills.is_object()
        {
            return Err(format!(
                "invalid skill identity manifest: {}",
                file.display()
            ));
        }
        let skills: std::collections::BTreeMap<String, ManifestEntry> =
            serde_json::from_value(doc.skills).map_err(|e| {
                format!("invalid skill identity manifest: {}: {e}", file.display())
            })?;
        Ok(Self { skills })
    }

    /// Explicit paths for a pack (INV-3). A recorded skill missing SKILL.md,
    /// a bad path, or a duplicate fails closed. No entries -> None so the
    /// caller falls back to the legacy `<home>/<pack>` dir.
    fn pack_paths(&self, skills_home: &Path, pack: &str) -> Result<Option<Vec<PathBuf>>, String> {
        let mut paths: Vec<PathBuf> = vec![];
        for (identity, entry) in &self.skills {
            if !identity.starts_with(&format!("{pack}:")) {
                continue;
            }
            if !is_skill_dir_name(&entry.path) {
                return Err(format!("invalid installed skill path: {identity}"));
            }
            let path = skills_home.join(&entry.path);
            if !path.join("SKILL.md").is_file() {
                return Err(format!(
                    "missing installed skill: {identity} ({})",
                    path.display()
                ));
            }
            // Keep the <home>/<name> shape (parity with the bash launcher's
            // --skill argv); canonicalization would follow the symlink out
            // of the skills home.
            if paths.contains(&path) {
                return Err(format!("duplicate installed skill path: {}", path.display()));
            }
            paths.push(path);
        }
        Ok(if paths.is_empty() {
            None
        } else {
            Some(paths)
        })
    }
}

/// INV-1: a skill dir name matches the bootstrap's SKILL_NAME pattern.
fn is_skill_dir_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Outcome for one allowlist name: its resolved skill dirs (absolute paths),
/// plus whether it was required (mantra/tracker) for fail-closed handling.
#[derive(Debug)]
pub struct Resolved {
    pub missing: Vec<(String, String)>, // (kind, message)
    pub skill_dirs: Vec<PathBuf>,       // canonical dirs, Pi --skill order
}

/// Push a required/optional skill dir, deduping on the canonical path.
/// Missing required dirs either fail (Pi) or land in `missing` as warnings
/// (other hosts).
fn push_dir(
    skill_dirs: &mut Vec<PathBuf>,
    missing: &mut Vec<(String, String)>,
    dir: PathBuf,
    kind: &str,
    name: &str,
    required_missing_fail: bool,
) -> Result<(), String> {
    if !dir.join("SKILL.md").is_file() {
        if required_missing_fail {
            return Err(format!(
                "pi-vida: missing required {kind} {name} ({})",
                dir.display()
            ));
        }
        missing.push((
            kind.to_string(),
            format!(
                "pi-vida: warning: missing {kind} {name} ({})",
                dir.display()
            ),
        ));
        return Ok(());
    }
    // Keep the <home>/<name> shape (parity with the bash launcher); do not
    // canonicalize through symlinks.
    if !skill_dirs.contains(&dir) {
        skill_dirs.push(dir);
    }
    Ok(())
}

/// One resolver, every host (design §3): mantra dirs + pack-resolved paths +
/// tracker dir, deduped, in profile order. `required_missing_fail` is true
/// for Pi (INV-6: missing mantra/tracker is exit 2; missing packs warn) and
/// false for other hosts (warn and continue).
pub fn resolve_skills(
    profile: &Profile,
    skills_home: &Path,
    required_missing_fail: bool,
) -> Result<Resolved, String> {
    let manifest = Manifest::read(skills_home)?;
    let mut skill_dirs: Vec<PathBuf> = vec![];
    let mut missing: Vec<(String, String)> = vec![];
    for name in &profile.mantra {
        push_dir(
            &mut skill_dirs,
            &mut missing,
            skills_home.join(name),
            "mantra",
            name,
            required_missing_fail,
        )?;
    }
    for pack in &profile.packs {
        match manifest.pack_paths(skills_home, pack)? {
            Some(paths) => {
                for p in paths {
                    if !skill_dirs.contains(&p) {
                        skill_dirs.push(p);
                    }
                }
            }
            None => {
                let dir = skills_home.join(pack);
                if dir.join("SKILL.md").is_file() {
                    if !skill_dirs.contains(&dir) {
                        skill_dirs.push(dir);
                    }
                } else {
                    // Missing pack: warn, continue (every host).
                    missing.push((
                        "pack".to_string(),
                        format!(
                            "pi-vida: warning: missing pack {} ({})",
                            pack,
                            dir.display()
                        ),
                    ));
                }
            }
        }
    }
    if let Some(tracker) = &profile.tracker {
        push_dir(
            &mut skill_dirs,
            &mut missing,
            skills_home.join(tracker),
            "tracker",
            tracker,
            required_missing_fail,
        )?;
    }
    Ok(Resolved {
        missing,
        skill_dirs,
    })
}

/// The allowlist for the install step: mantra + packs + tracker names.
pub fn allowlist_names(profile: &Profile) -> Vec<String> {
    let mut names = profile.mantra.clone();
    names.extend(profile.packs.iter().cloned());
    if let Some(t) = &profile.tracker {
        names.push(t.clone());
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(home: &Path, name: &str) {
        std::fs::create_dir_all(home.join(name)).unwrap();
        std::fs::write(home.join(name).join("SKILL.md"), format!("# {name}")).unwrap();
    }

    fn profile(mantra: &[&str], packs: &[&str], tracker: Option<&str>) -> Profile {
        Profile {
            mantra: mantra.iter().map(|s| s.to_string()).collect(),
            packs: packs.iter().map(|s| s.to_string()).collect(),
            tracker: tracker.map(|s| s.to_string()),
        }
    }

    #[test]
    fn manifest_pack_expands_to_member_skills() {
        let home = std::env::temp_dir().join(format!("pv-res-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        write_skill(&home, "build");
        write_skill(&home, "lint");
        std::fs::write(
            home.join(".dotskills-manifest.json"),
            r#"{"schema_version":1,"skills":{"my-pack:build":{"path":"build"},"my-pack:lint":{"path":"lint"}}}"#,
        )
        .unwrap();
        let r = resolve_skills(&profile(&[], &["my-pack"], None), &home, true).unwrap();
        assert_eq!(
            r.skill_dirs,
            vec![home.join("build"), home.join("lint")]
        );
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn legacy_pack_dir_fallback_when_no_manifest_entries() {
        let home = std::env::temp_dir().join(format!("pv-leg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        write_skill(&home, "my-pack");
        let r = resolve_skills(&profile(&[], &["my-pack"], None), &home, true).unwrap();
        assert_eq!(r.skill_dirs, vec![home.join("my-pack")]);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn manifest_skill_missing_skill_md_fails_closed() {
        let home = std::env::temp_dir().join(format!("pv-miss-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            home.join(".dotskills-manifest.json"),
            r#"{"schema_version":1,"skills":{"my-pack:build":{"path":"build"}}}"#,
        )
        .unwrap();
        let err = resolve_skills(&profile(&[], &["my-pack"], None), &home, true).unwrap_err();
        assert!(err.contains("missing installed skill"));
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn malformed_manifest_fails_closed() {
        let home = std::env::temp_dir().join(format!("pv-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join(".dotskills-manifest.json"), "not json{").unwrap();
        let err = resolve_skills(&profile(&[], &["my-pack"], None), &home, true).unwrap_err();
        assert!(err.contains("invalid skill identity manifest"));
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn foreign_manifest_schema_fails_closed() {
        let home = std::env::temp_dir().join(format!("pv-for-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            home.join(".dotskills-manifest.json"),
            r#"{"schema_version":2,"skills":{}}"#,
        )
        .unwrap();
        assert!(resolve_skills(&profile(&[], &["p"], None), &home, true).is_err());
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn pi_missing_mantra_exits_two() {
        let home = std::env::temp_dir().join(format!("pv-mman-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let err = resolve_skills(&profile(&["gone"], &[], None), &home, true).unwrap_err();
        assert!(err.contains("missing required mantra gone"));
        // Non-Pi host: warn instead.
        let r = resolve_skills(&profile(&["gone"], &[], None), &home, false).unwrap();
        assert_eq!(r.skill_dirs, Vec::<PathBuf>::new());
        assert_eq!(r.missing.len(), 1);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn pi_missing_tracker_exits_two_but_missing_pack_warns() {
        let home = std::env::temp_dir().join(format!("pv-mtrk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        write_skill(&home, "i-have-adhd");
        let err = resolve_skills(&profile(&["i-have-adhd"], &[], Some("github-issue")), &home, true)
            .unwrap_err();
        assert!(err.contains("missing required tracker github-issue"));
        let r = resolve_skills(&profile(&["i-have-adhd"], &["nope"], None), &home, true).unwrap();
        assert_eq!(r.skill_dirs, vec![home.join("i-have-adhd")]);
        assert!(r.missing.iter().any(|(k, m)| k == "pack" && m.contains("missing pack nope")));
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn resolver_dedupes_and_orders_mantra_packs_tracker() {
        let home = std::env::temp_dir().join(format!("pv-ded-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        write_skill(&home, "m1");
        write_skill(&home, "pk1");
        write_skill(&home, "shared");
        write_skill(&home, "t1");
        std::fs::write(
            home.join(".dotskills-manifest.json"),
            r#"{"schema_version":1,"skills":{"pk1:shared":{"path":"shared"},"pk1:pk1":{"path":"pk1"}}}"#,
        )
        .unwrap();
        let r = resolve_skills(&profile(&["m1", "shared"], &["pk1"], Some("t1")), &home, true).unwrap();
        // m1 first, then pack members (shared deduped), tracker last.
        assert_eq!(
            r.skill_dirs,
            vec![home.join("m1"), home.join("shared"), home.join("pk1"), home.join("t1")]
        );
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn allowlist_names_cover_mantra_packs_tracker() {
        let p = profile(&["m"], &["p1", "p2"], Some("t"));
        assert_eq!(allowlist_names(&p), vec!["m", "p1", "p2", "t"]);
    }

    #[test]
    fn skill_dir_name_validation() {
        assert!(is_skill_dir_name("ruby-core-skills"));
        assert!(is_skill_dir_name("a.b_c-d"));
        assert!(!is_skill_dir_name(""));
        assert!(!is_skill_dir_name("-x"));
        assert!(!is_skill_dir_name("a b"));
        assert!(!is_skill_dir_name("a/b"));
    }
}
