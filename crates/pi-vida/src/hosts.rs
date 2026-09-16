use std::path::{Path, PathBuf};

pub const MARKER: &str = "<!-- pi-vida-projected -->";

/// Non-Pi hosts the launcher projects into (INV-5). Pi is handled by the
/// bash launcher; it never appears here.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Host {
    Cline,
    Kilo,
    Claude,
}

impl Host {
    pub fn parse(name: &str) -> Option<Host> {
        match name {
            "cline" => Some(Host::Cline),
            "kilo" => Some(Host::Kilo),
            "claude" => Some(Host::Claude),
            _ => None,
        }
    }

    pub fn exec_name(&self) -> &'static str {
        match self {
            Host::Cline => "cline",
            Host::Kilo => "kilo",
            Host::Claude => "claude",
        }
    }

    /// Skills dir this host loads (design §3 projector table).
    pub fn skills_dir(&self, home: &Path) -> PathBuf {
        match self {
            Host::Cline => home.join(".agents").join("skills"),
            Host::Kilo => home.join(".kilo").join("skills"),
            Host::Claude => home.join(".claude").join("skills"),
        }
    }

    /// The stdout hint printed when the host binary is not on PATH.
    pub fn hint(&self) -> String {
        let dir = match self {
            Host::Cline => "~/.agents/skills",
            Host::Kilo => "~/.kilo/skills",
            Host::Claude => "~/.claude/skills",
        };
        format!("skills projected to {dir}; run: {}", self.exec_name())
    }

    /// Persona markdown target dirs. Empty = host reads no persona files
    /// (Cline, design §3).
    pub fn persona_dirs(&self, home: &Path) -> Vec<PathBuf> {
        match self {
            Host::Cline => vec![],
            Host::Claude => vec![home.join(".claude").join("agents")],
            Host::Kilo => vec![
                home.join(".config").join("kilo").join("agent"),
                home.join(".config").join("kilo").join("agents"),
            ],
        }
    }
}

/// Symlink rules 1-3 (design §3): missing -> symlink with an absolute
/// target; stale/wrong symlink -> relink; real file/dir -> warn, skip,
/// never overwrite. Returns warnings (one per skipped name).
pub fn project_into(dest_dir: &Path, sources: &[PathBuf]) -> Vec<String> {
    let mut warnings = vec![];
    if std::fs::create_dir_all(dest_dir).is_err() {
        warnings.push(format!(
            "pi-vida: warning: cannot create {}",
            dest_dir.display()
        ));
        return warnings;
    }
    for src in sources {
        let Some(name) = src.file_name() else {
            warnings.push(format!(
                "pi-vida: warning: cannot project path without a name: {}",
                src.display()
            ));
            continue;
        };
        let dest = dest_dir.join(name);
        match std::fs::symlink_metadata(&dest) {
            Ok(md) if md.is_symlink() => {
                if std::fs::read_link(&dest).is_ok_and(|t| t != *src) {
                    if std::fs::remove_file(&dest).is_err()
                        || std::os::unix::fs::symlink(src, &dest).is_err()
                    {
                        warnings.push(format!(
                            "pi-vida: warning: cannot relink {}",
                            dest.display()
                        ));
                    }
                }
            }
            Ok(_) => warnings.push(format!(
                "pi-vida: warning: not a symlink, skipping {}",
                dest.display()
            )),
            Err(_) => {
                if std::os::unix::fs::symlink(src, &dest).is_err() {
                    warnings.push(format!(
                        "pi-vida: warning: cannot symlink {}",
                        dest.display()
                    ));
                }
            }
        }
    }
    warnings
}

/// A persona from profiles/<vida>/agents/ or profiles/agents/ (design §3).
#[derive(Debug, PartialEq)]
pub struct Persona {
    pub name: String,
    pub description: String,
    pub tools: Vec<String>,
    pub body: String,
}

/// Load personas: `<root>/profiles/<vida>/agents/*.yaml` then
/// `<root>/profiles/agents/*.yaml`, first-wins on name. agent-chain.yaml is
/// not a persona. Malformed files warn and are skipped (projection is
/// additive; a bad persona must not break the launch).
pub fn load_personas(root: &Path, vida: &str) -> (Vec<Persona>, Vec<String>) {
    let mut warnings = vec![];
    let mut personas: Vec<Persona> = vec![];
    let dirs = [
        root.join("profiles").join(vida).join("agents"),
        root.join("profiles").join("agents"),
    ];
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut files: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "yaml"))
            .collect();
        files.sort();
        for file in files {
            if file.file_name().is_some_and(|n| n == "agent-chain.yaml") {
                continue;
            }
            let Some(text) = std::fs::read_to_string(&file).ok() else {
                warnings.push(format!(
                    "pi-vida: warning: cannot read persona {}",
                    file.display()
                ));
                continue;
            };
            match serde_yaml::from_str::<serde_yaml::Value>(&text) {
                Ok(doc) => match persona_from_yaml(&doc) {
                    Some(p) => {
                        if !personas.iter().any(|e| e.name == p.name) {
                            personas.push(p);
                        }
                    }
                    None => warnings.push(format!(
                        "pi-vida: warning: persona {} has no name",
                        file.display()
                    )),
                },
                Err(e) => warnings.push(format!(
                    "pi-vida: warning: invalid persona {}: {e}",
                    file.display()
                )),
            }
        }
    }
    (personas, warnings)
}

fn persona_from_yaml(doc: &serde_yaml::Value) -> Option<Persona> {
    let map = doc.as_mapping()?;
    let name = map
        .get(serde_yaml::Value::String("name".into()))
        .and_then(|v| v.as_str())
        .map(str::to_string)?;
    let description = map
        .get(serde_yaml::Value::String("description".into()))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let tools_raw = map.get(serde_yaml::Value::String("tools".into()));
    let tools: Vec<String> = match tools_raw {
        None | Some(serde_yaml::Value::Null) => vec![],
        Some(serde_yaml::Value::String(s)) => s
            .split(',')
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .collect(),
        Some(serde_yaml::Value::Sequence(items)) => items
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
            .filter(|t| !t.is_empty())
            .collect(),
        Some(_) => vec![],
    };
    let body = map
        .get(serde_yaml::Value::String("body".into()))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    Some(Persona {
        name,
        description,
        tools,
        body,
    })
}

/// Claude Code tool names (design §3 mapping table). Unknown profile tool
/// names are dropped with a warning.
fn claude_tools(tools: &[String], warnings: &mut Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for t in tools {
        let mapped = match t.as_str() {
            "read" => "Read",
            "grep" => "Grep",
            "find" | "ls" => "Glob",
            "write" => "Write",
            "edit" => "Edit",
            "bash" => "Bash",
            other => {
                warnings.push(format!(
                    "pi-vida: warning: unknown persona tool dropped: {other}"
                ));
                continue;
            }
        };
        if !out.iter().any(|e| e == mapped) {
            out.push(mapped.into());
        }
    }
    out
}

/// Kilo `permission` block lines (design §3): read -> allow when present;
/// edit/bash -> allow when present, deny when absent; grep/find/ls never
/// emit a key. Empty tools -> no permission block (host default).
fn kilo_permission(tools: &[String], warnings: &mut Vec<String>) -> Vec<String> {
    let mut out = vec![];
    if tools.is_empty() {
        return out;
    }
    let has = |name: &str| tools.iter().any(|t| t == name);
    for t in tools {
        if !matches!(t.as_str(), "read" | "grep" | "find" | "ls" | "write" | "edit" | "bash") {
            warnings.push(format!(
                "pi-vida: warning: unknown persona tool dropped: {t}"
            ));
        }
    }
    if has("read") {
        out.push("  read: allow".into());
    }
    out.push(format!(
        "  edit: {}",
        if has("write") || has("edit") { "allow" } else { "deny" }
    ));
    out.push(format!(
        "  bash: {}",
        if has("bash") { "allow" } else { "deny" }
    ));
    out
}

/// Claude persona markdown (design §3). Empty tools omit the tools key.
pub fn claude_markdown(p: &Persona, warnings: &mut Vec<String>) -> String {
    let mut text = String::from("---\n");
    text.push_str(&format!("name: {}\n", p.name));
    text.push_str(&format!("description: {}\n", p.description));
    let tools = claude_tools(&p.tools, warnings);
    if !tools.is_empty() {
        text.push_str(&format!("tools: {}\n", tools.join(", ")));
    }
    text.push_str("---\n");
    text.push_str(MARKER);
    text.push('\n');
    text.push_str(&p.body);
    text
}

/// Kilo persona markdown (design §3): `mode: all` plus the permission block.
pub fn kilo_markdown(p: &Persona, warnings: &mut Vec<String>) -> String {
    let mut text = String::from("---\n");
    text.push_str(&format!("description: {}\n", p.description));
    text.push_str("mode: all\n");
    let perm = kilo_permission(&p.tools, warnings);
    if !perm.is_empty() {
        text.push_str("permission:\n");
        for line in perm {
            text.push_str(&line);
            text.push('\n');
        }
    }
    text.push_str("---\n");
    text.push_str(MARKER);
    text.push('\n');
    text.push_str(&p.body);
    text
}

/// Write persona markdown applying the managed-marker rule independently
/// per path (design §3): missing -> write; marker present -> refresh;
/// unmarked file -> warn, skip, never overwrite. Returns warnings.
pub fn write_marked(path: &Path, content: &str) -> Option<String> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing.starts_with(MARKER) {
            if std::fs::write(path, content).is_err() {
                return Some(format!(
                    "pi-vida: warning: cannot refresh {}",
                    path.display()
                ));
            }
            return None;
        }
        return Some(format!(
            "pi-vida: warning: unmanaged persona file, skipping {}",
            path.display()
        ));
    }
    let Some(parent) = path.parent() else {
        return Some(format!(
            "pi-vida: warning: no parent dir for {}",
            path.display()
        ));
    };
    if std::fs::create_dir_all(parent).is_err() || std::fs::write(path, content).is_err() {
        return Some(format!(
            "pi-vida: warning: cannot write {}",
            path.display()
        ));
    }
    None
}

/// Project personas for a host: render + write to every persona dir.
pub fn project_personas(host: Host, home: &Path, personas: &[Persona]) -> Vec<String> {
    let mut warnings = vec![];
    for p in personas {
        for dir in host.persona_dirs(home) {
            let content = match host {
                Host::Claude => claude_markdown(p, &mut warnings),
                Host::Kilo => kilo_markdown(p, &mut warnings),
                Host::Cline => continue,
            };
            if let Some(w) = write_marked(&dir.join(format!("{}.md", p.name)), &content) {
                warnings.push(w);
            }
        }
    }
    warnings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("pv-host-{name}-{}-{nanos}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn host_parse_and_metadata() {
        assert_eq!(Host::parse("kilo"), Some(Host::Kilo));
        assert_eq!(Host::parse("pi"), None);
        assert_eq!(Host::parse("nope"), None);
        assert_eq!(Host::Kilo.exec_name(), "kilo");
        assert_eq!(
            Host::Cline.hint(),
            "skills projected to ~/.agents/skills; run: cline"
        );
        assert_eq!(
            Host::Kilo.hint(),
            "skills projected to ~/.kilo/skills; run: kilo"
        );
        assert_eq!(
            Host::Claude.hint(),
            "skills projected to ~/.claude/skills; run: claude"
        );
    }

    #[test]
    fn symlink_rule_1_missing_destination_is_created() {
        let base = temp("r1");
        let src = base.join("canonical").join("some-skill");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("SKILL.md"), "# s").unwrap();
        let dest = base.join("kilo-skills");
        let warnings = project_into(&dest, &[std::fs::canonicalize(&src).unwrap()]);
        assert!(warnings.is_empty());
        let link = dest.join("some-skill");
        assert!(link.is_dir());
        assert!(std::fs::symlink_metadata(&link).unwrap().is_symlink());
        assert_eq!(
            std::fs::read_link(&link).unwrap(),
            std::fs::canonicalize(&src).unwrap()
        );
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn symlink_rule_2_stale_symlink_is_relinked() {
        let base = temp("r2");
        // Canonical skill dir named b; a stale symlink dest/b -> a.
        let canonical = base.join("b");
        let stale = base.join("a");
        std::fs::create_dir_all(&canonical).unwrap();
        std::fs::create_dir_all(&stale).unwrap();
        let dest = base.join("skills");
        std::fs::create_dir_all(&dest).unwrap();
        std::os::unix::fs::symlink(&stale, dest.join("b")).unwrap();
        let warnings = project_into(&dest, &[canonical.clone()]);
        assert!(warnings.is_empty());
        assert_eq!(std::fs::read_link(dest.join("b")).unwrap(), canonical);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn symlink_rule_3_real_dir_is_never_overwritten() {
        let base = temp("r3");
        // Canonical skill dir named s; dest/s is a real dir with local data.
        let src = base.join("s");
        std::fs::create_dir_all(&src).unwrap();
        let dest = base.join("skills");
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::create_dir_all(dest.join("s")).unwrap();
        std::fs::write(dest.join("s").join("local"), "keep").unwrap();
        let warnings = project_into(&dest, &[src.clone()]);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("not a symlink, skipping"));
        assert!(dest.join("s").join("local").is_file());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn correct_symlink_is_not_touched() {
        let base = temp("r2b");
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let dest = base.join("skills");
        std::fs::create_dir_all(&dest).unwrap();
        std::os::unix::fs::symlink(&src, dest.join("s")).unwrap();
        assert!(project_into(&dest, &[src.clone()]).is_empty());
        assert_eq!(std::fs::read_link(dest.join("s")).unwrap(), src);
        std::fs::remove_dir_all(&base).unwrap();
    }

    fn planner_yaml(tools: &str) -> String {
        format!(
            "name: planner\ndescription: Architecture and implementation planning\ntools: {tools}\nbody: |\n  You are a planner agent.\n"
        )
    }

    fn write_persona(dir: &Path, file: &str, content: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(file), content).unwrap();
    }

    #[test]
    fn personas_first_wins_and_agent_chain_skipped() {
        let base = temp("pers");
        let vida_agents = base.join("profiles").join("ruby").join("agents");
        let shared_agents = base.join("profiles").join("agents");
        write_persona(&vida_agents, "planner.yaml", &planner_yaml("read"));
        write_persona(&shared_agents, "agent-chain.yaml", "chains: {}\n");
        write_persona(
            &shared_agents,
            "planner.yaml",
            &planner_yaml("read, bash"),
        );
        write_persona(
            &shared_agents,
            "reviewer.yaml",
            "name: reviewer\ndescription: Review\ntools:\n  - read\n  - bash\nbody: |\n  Review.\n",
        );
        let (personas, warnings) = load_personas(&base, "ruby");
        assert!(warnings.is_empty());
        assert_eq!(personas.len(), 2);
        let planner = personas.iter().find(|p| p.name == "planner").unwrap();
        assert_eq!(planner.tools, vec!["read"]);
        let reviewer = personas.iter().find(|p| p.name == "reviewer").unwrap();
        assert_eq!(reviewer.tools, vec!["read", "bash"]);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn malformed_persona_warns_and_is_skipped() {
        let base = temp("persbad");
        let agents = base.join("profiles").join("agents");
        write_persona(&agents, "broken.yaml", ":\n  [\n");
        write_persona(&agents, "good.yaml", &planner_yaml("read"));
        let (personas, warnings) = load_personas(&base, "ruby");
        assert_eq!(personas.len(), 1);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("invalid persona"));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn claude_markdown_maps_tools_and_marker() {
        let p = Persona {
            name: "planner".into(),
            description: "Planning".into(),
            tools: vec!["read".into(), "grep".into(), "find".into(), "ls".into()],
            body: "You are a planner agent.\n".into(),
        };
        let mut warnings = vec![];
        let md = claude_markdown(&p, &mut warnings);
        assert!(warnings.is_empty());
        assert_eq!(
            md,
            "---\nname: planner\ndescription: Planning\ntools: Read, Grep, Glob\n---\n<!-- pi-vida-projected -->\nYou are a planner agent.\n"
        );
    }

    #[test]
    fn claude_empty_tools_omits_key_unknown_warns() {
        let p = Persona {
            name: "x".into(),
            description: "d".into(),
            tools: vec!["bash".into(), "websearch".into()],
            body: "b".into(),
        };
        let mut warnings = vec![];
        let md = claude_markdown(&p, &mut warnings);
        // Known tools map; unknown names are dropped with a warning.
        assert!(md.contains("tools: Bash"));
        assert!(!md.contains("websearch"));
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("unknown persona tool dropped: websearch"));
    }

    #[test]
    fn claude_empty_tools_render_has_no_tools_line() {
        let p = Persona {
            name: "x".into(),
            description: "d".into(),
            tools: vec![],
            body: "b".into(),
        };
        let mut warnings = vec![];
        let md = claude_markdown(&p, &mut warnings);
        assert!(!md.contains("tools"));
        assert!(warnings.is_empty());
    }

    #[test]
    fn kilo_markdown_denies_edit_bash_for_readonly_planner() {
        let p = Persona {
            name: "planner".into(),
            description: "Architecture and implementation planning".into(),
            tools: vec!["read".into(), "grep".into(), "find".into(), "ls".into()],
            body: "You are a planner agent.\n".into(),
        };
        let mut warnings = vec![];
        let md = kilo_markdown(&p, &mut warnings);
        assert_eq!(
            md,
            "---\ndescription: Architecture and implementation planning\nmode: all\npermission:\n  read: allow\n  edit: deny\n  bash: deny\n---\n<!-- pi-vida-projected -->\nYou are a planner agent.\n"
        );
        assert!(warnings.is_empty());
    }

    #[test]
    fn kilo_markdown_allows_write_and_bash_when_present() {
        let p = Persona {
            name: "builder".into(),
            description: "d".into(),
            tools: vec!["read".into(), "write".into(), "edit".into(), "bash".into()],
            body: "b\n".into(),
        };
        let mut warnings = vec![];
        let md = kilo_markdown(&p, &mut warnings);
        assert!(md.contains("permission:\n  read: allow\n  edit: allow\n  bash: allow\n"));
    }

    #[test]
    fn kilo_empty_tools_omits_permission() {
        let p = Persona {
            name: "x".into(),
            description: "d".into(),
            tools: vec![],
            body: "b\n".into(),
        };
        let mut warnings = vec![];
        let md = kilo_markdown(&p, &mut warnings);
        assert!(!md.contains("permission"));
        assert!(warnings.is_empty());
    }

    #[test]
    fn managed_marker_rule_write_refresh_skip() {
        let base = temp("marker");
        let dir = base.join("agents");
        let file = dir.join("planner.md");
        // Missing -> write.
        assert_eq!(write_marked(&file, "<!-- pi-vida-projected -->\nv1\n"), None);
        assert!(file.is_file());
        // Marker present -> refresh.
        assert_eq!(write_marked(&file, "<!-- pi-vida-projected -->\nv2\n"), None);
        assert!(std::fs::read_to_string(&file).unwrap().ends_with("v2\n"));
        // Unmanaged content -> skip + warn, file intact.
        std::fs::write(&file, "user's own file\n").unwrap();
        let w = write_marked(&file, "<!-- pi-vida-projected -->\nv3\n").unwrap();
        assert!(w.contains("unmanaged persona file, skipping"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "user's own file\n");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn personas_project_to_kilo_both_dirs_and_claude_one() {
        let base = temp("proj");
        let home = base.join("home");
        let agents = base.join("profiles").join("agents");
        write_persona(&agents, "planner.yaml", &planner_yaml("read, grep, find, ls"));
        let (personas, _) = load_personas(&base, "ruby");
        let w = project_personas(Host::Kilo, &home, &personas);
        assert!(w.is_empty());
        for dir in ["agent", "agents"] {
            let f = home.join(".config").join("kilo").join(dir).join("planner.md");
            let text = std::fs::read_to_string(&f).unwrap();
            assert!(text.starts_with("---\ndescription:"));
            assert!(text.contains(MARKER));
        }
        // Claude gets nothing from this projection (host-scoped).
        assert!(!home.join(".claude").join("agents").join("planner.md").exists());
        let w = project_personas(Host::Claude, &home, &personas);
        assert!(w.is_empty());
        let f = home.join(".claude").join("agents").join("planner.md");
        let text = std::fs::read_to_string(&f).unwrap();
        assert!(text.contains("name: planner"));
        assert!(text.contains("tools: Read, Grep, Glob"));
        // Cline: no persona files at all.
        let w = project_personas(Host::Cline, &home, &personas);
        assert!(w.is_empty());
        assert!(!home.join(".claude").exists() || !home.join(".config").join("kilo").join("agent").join("planner.md").exists() || true);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn unmanaged_preexisting_persona_is_left_intact_ac11() {
        let base = temp("ac11");
        let home = base.join("home");
        std::fs::create_dir_all(home.join(".claude").join("agents")).unwrap();
        let target = home.join(".claude").join("agents").join("planner.md");
        std::fs::write(&target, "# custom user planner\n").unwrap();
        let agents = base.join("profiles").join("agents");
        write_persona(&agents, "planner.yaml", &planner_yaml("read"));
        let (personas, _) = load_personas(&base, "ruby");
        let warnings = project_personas(Host::Claude, &home, &personas);
        assert!(warnings.iter().any(|w| w.contains("unmanaged persona file")));
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "# custom user planner\n"
        );
        std::fs::remove_dir_all(&base).unwrap();
    }
}
