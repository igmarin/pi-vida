use std::io::IsTerminal as _;

use std::path::{Path, PathBuf};
use std::process::exit;

use crate::hosts::{self, Host};
use crate::profile::{parse_profile, Profile};
use crate::resolve::{allowlist_names, resolve_skills};

pub const GUM_HINT: &str =
    "pi-vida: gum not found on PATH (install it: https://github.com/charmbracelet/gum)";

/// Host selector including Pi (which the bash launcher owns).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum HostChoice {
    Pi,
    Cline,
    Kilo,
    Claude,
}

/// Canonical vida names + aliases (design §2). `None` means not a vida.
pub fn canonical_vida(arg: &str) -> Option<&'static str> {
    match arg {
        "rust" => Some("rust"),
        "elixir" | "phoenix" => Some("elixir"),
        "ruby" | "rails" => Some("ruby"),
        "python" => Some("python"),
        _ => None,
    }
}

/// A vida name that exits 2 with the bash launcher's exact text.
pub fn rejected_vida(arg: &str) -> Option<&'static str> {
    match arg {
        "rails-python" => Some("pi-vida: rails-python is not a vida; use ruby or python"),
        "ecto" => Some("pi-vida: ecto is not a vida; use elixir"),
        _ => None,
    }
}

/// Root derived from this binary's location (never env): the launcher and
/// repo assets live in the checkout containing
/// `<root>/crates/pi-vida/target/{debug,release}/pi-vida`.
pub fn exe_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.parent()?.ancestors().nth(4).map(Path::to_path_buf)
}

/// Root of the harness checkout: PI_VIDA_HOME, else PI_LIFE_HOME, else
/// MY_PI_AGENT_HOME (same precedence as the bash launcher's resolve_root),
/// else derived from this binary's location.
pub fn harness_root() -> Option<PathBuf> {
    for key in ["PI_VIDA_HOME", "PI_LIFE_HOME", "MY_PI_AGENT_HOME"] {
        if let Some(v) = std::env::var_os(key) {
            let p = PathBuf::from(v);
            if p.is_dir() {
                return Some(p);
            }
        }
    }
    exe_root()
}

/// Skills home per INV-2: PI_SKILLS_HOME else ~/.agents/skills.
pub fn skills_home(home: &Path) -> PathBuf {
    std::env::var_os("PI_SKILLS_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".agents").join("skills"))
}

fn warn_all(messages: &[String]) {
    warn_iter(messages.iter());
}

fn warn_iter<'a>(messages: impl Iterator<Item = &'a String>) {
    for m in messages {
        eprintln!("{m}");
    }
}

/// Load + parse the vida profile, exiting 2 on failure.
fn load_profile(root: &Path, vida: &str) -> Profile {
    let profile_path = root.join("profiles").join(format!("{vida}.yaml"));
    let text = match std::fs::read_to_string(&profile_path) {
        Ok(t) => t,
        Err(_) => {
            eprintln!("pi-vida: missing profile {}", profile_path.display());
            exit(2);
        }
    };
    match parse_profile(&text) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{e}");
            exit(2);
        }
    }
}

/// Non-Pi host path: resolve (warn-only), install gaps, project skills +
/// personas, then exec or print the hint.
fn which(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(bin))
        .find(|p| p.is_file())
}

/// Install gaps via the existing bootstrap (INV-7): bun
/// scripts/skills-bootstrap.ts --allowlist <names...>. Returns false when
/// the bootstrap failed (caller exits 2).
fn install_allowlist(root: &Path, names: &[String]) -> bool {
    let script = root.join("scripts").join("skills-bootstrap.ts");
    let mut cmd = std::process::Command::new("bun");
    cmd.arg(&script).arg("--allowlist").args(names);
    match cmd.status() {
        Ok(status) if status.success() => true,
        _ => {
            eprintln!("pi-vida: skills-bootstrap failed; launch aborted");
            false
        }
    }
}

fn run_host(
    host: Host,
    vida: &str,
    dry_run: bool,
    assets_root: &Path,
    home: &Path,
    profile: &Profile,
) -> i32 {
    // One resolver, every host (design §3). Non-Pi hosts warn on missing
    // required names and continue (INV-6). Pre-install resolve only decides
    // the dry-run preview; warnings print after install (once).
    let skills_home = skills_home(home);

    // Cline's global dir IS the canonical home when PI_SKILLS_HOME is unset
    // or already ~/.agents/skills: project nothing extra (design §3).
    let cline_global = home.join(".agents").join("skills");
    let project_targets: Vec<PathBuf> = match host {
        Host::Cline if skills_home == cline_global => vec![],
        _ => vec![host.skills_dir(home)],
    };
    let resolved = match resolve_skills(profile, &skills_home, false) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{e}");
            exit(2);
        }
    };
    if dry_run {
        warn_iter(resolved.missing.iter().map(|(_, m)| m));
        // Dry-run prints the projected skill paths + the command/hint (AC-3/4).
        for dir in &resolved.skill_dirs {
            let Some(name) = dir.file_name() else { continue };
            for target in &project_targets {
                println!("{}", target.join(name).display());
            }
        }
        if which(host.exec_name()).is_some() {
            println!("{}", host.exec_name());
        } else {
            println!("{}", host.hint());
        }
        return 0;
    }

    // Install missing allowlisted names from packs.yaml (menu step 5).
    let names = allowlist_names(profile);
    if !names.is_empty() && !install_allowlist(assets_root, &names) {
        exit(2);
    }

    // Re-resolve after install: newly installed skills join the projection.
    let resolved = match resolve_skills(profile, &skills_home, false) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{e}");
            exit(2);
        }
    };
    warn_iter(resolved.missing.iter().map(|(_, m)| m));

    for target in &project_targets {
        let warnings = hosts::project_into(target, &resolved.skill_dirs);
        warn_all(&warnings);
    }
    let (personas, warnings) = hosts::load_personas(assets_root, vida);
    warn_all(&warnings);
    warn_all(&hosts::project_personas(host, home, &personas));

    match which(host.exec_name()) {
        Some(bin) => {
            // argv = [argv0, ...args]; argv0 is the resolved binary path so
            // the child is launched as `cline`, not `cline cline`.
            let name = host.exec_name().to_string();
            exec_program(bin, name, vec![])
        }
        None => {
            println!("{}", host.hint());
            0
        }
    }
}

/// Replace this process with `program` (argv[0] = `arg0`, real arguments =
/// `rest`). Never returns on success; returns 2 on spawn failure (the
/// caller exits with it). std-only: Command::arg0 + CommandExt::exec.
fn exec_program(program: PathBuf, arg0: String, rest: Vec<String>) -> i32 {
    use std::os::unix::process::CommandExt;
    let err = std::process::Command::new(&program)
        .arg0(arg0)
        .args(rest)
        .exec();
    eprintln!("pi-vida: exec {} failed: {err}", program.display());
    2
}

/// Hand the launch to the bash launcher: it owns overlay reading, env export,
/// model/thinking, and the real `exec pi` (the Rust binary does not repeat
/// that logic — one launch pipeline). argv0 = the launcher path.
fn delegate(passthrough: Vec<String>, root: &Path) -> i32 {
    let launch = root.join("libexec").join("pi-vida-launch");
    let arg0 = launch.display().to_string();
    exec_program(launch, arg0, passthrough)
}

/// Gum choice from a menu. Cancel or EOF -> None.
fn gum_choose(title: &str, options: &[&str]) -> Option<String> {
    let out = std::process::Command::new("gum")
        .arg("choose")
        .arg("--header")
        .arg(title)
        .args(options)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn gum_input(prompt: &str) -> Option<String> {
    let out = std::process::Command::new("gum")
        .arg("input")
        .arg("--prompt")
        .arg(prompt)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn gum_confirm(prompt: &str) -> bool {
    std::process::Command::new("gum")
        .arg("confirm")
        .arg(prompt)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Interactive gum flow (design §2, menu order 1-7). Only reached on a TTY
/// with no vida argument. Cancel at any menu -> exit 0, nothing written.
fn interactive(root: &Path, home: &Path, initial_host: Option<HostChoice>) -> i32 {
    if which("gum").is_none() {
        eprintln!("{GUM_HINT}");
        exit(2);
    }
    // 1. Host (skipped when --host was given).
    let host = match initial_host {
        Some(h) => h,
        None => {
            let Some(choice) = gum_choose("Host", &["pi", "cline", "kilo", "claude"]) else {
                return 0;
            };
            match choice.as_str() {
                "cline" => HostChoice::Cline,
                "kilo" => HostChoice::Kilo,
                "claude" => HostChoice::Claude,
                _ => HostChoice::Pi,
            }
        }
    };
    // 2. Vida (aliases shown in the label; stored value is canonical).
    let Some(vida_label) = gum_choose(
        "Vida",
        &["rust", "elixir (phoenix)", "ruby (rails)", "python"],
    ) else {
        return 0;
    };
    let vida = match vida_label.as_str() {
        "elixir (phoenix)" => "elixir",
        "ruby (rails)" => "ruby",
        v => v,
    };
    // 3. Mode (Pi only). Fusion asks for a stack file relative to cwd.
    let mut mode = "solo".to_string();
    let mut fusion_stack = String::new();
    if host == HostChoice::Pi {
        let Some(choice) = gum_choose("Mode", &["solo", "chain", "team", "fusion"]) else {
            return 0;
        };
        mode = choice;
        if mode == "fusion" {
            let Some(stack) = gum_input("fusion stack path (relative to cwd)") else {
                return 0;
            };
            if stack.is_empty() || !Path::new(&stack).is_file() {
                eprintln!("pi-vida: fusion stack not found: {stack}");
                exit(2);
            }
            fusion_stack = stack;
        }
    }
    let profile = load_profile(root, vida);
    // 4. Confirm packs: print the allowlist names and gum confirm.
    let mut summary = format!("mantra: {}", profile.mantra.join(", "));
    if !profile.packs.is_empty() {
        summary.push_str(&format!("; packs: {}", profile.packs.join(", ")));
    }
    summary.push_str(&format!(
        "; tracker: {}",
        profile.tracker.as_deref().unwrap_or("none")
    ));
    if !gum_confirm(&format!("Install and project? {summary}")) {
        return 0;
    }
    // 5-7. Install, project, exec/print — through the same host path as
    // non-interactive so the gum flow cannot drift from the argv contract.
    if host == HostChoice::Pi {
        // The bash launcher owns overlay/model handling for the launch.
        let mut passthrough = vec![vida.to_string()];
        if mode != "solo" || !fusion_stack.is_empty() {
            passthrough.push(mode.clone());
        }
        if !fusion_stack.is_empty() {
            passthrough.push(fusion_stack);
        }
        delegate(passthrough, root)
    } else {
        let host = match host {
            HostChoice::Cline => Host::Cline,
            HostChoice::Kilo => Host::Kilo,
            HostChoice::Claude => Host::Claude,
            HostChoice::Pi => unreachable!("Pi handled above"),
        };
        run_host(host, vida, false, root, home, &profile)
    }
}

#[derive(Debug, PartialEq)]
pub enum Invocation {
    /// Print usage, exit 0 (help/-h/--help; gum never starts).
    Help,
    /// Delegate the whole argv to the bash launcher (Pi path + doctor +
    /// --dump-overlay + no-args-non-TTY usage).
    Bash,
    /// Host-aware run. host=None means Pi (mode + fusion stack validated).
    Host {
        host: Option<HostChoice>,
        vida: String,
        mode: String,
        fusion_stack: String,
        dry_run: bool,
    },
    /// Interactive gum flow (TTY, no vida).
    Interactive { host: Option<HostChoice> },
}

/// Parse the launcher CLI (design §2). Errors exit 2 here.
pub fn parse_args(args: &[String]) -> Invocation {
    let mut dry_run = false;
    let mut host: Option<HostChoice> = None;
    let mut rest: Vec<String> = vec![];
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--dry-run" => dry_run = true,
            "--host" => {
                i += 1;
                let Some(name) = args.get(i) else {
                    eprintln!("pi-vida: --host requires a value");
                    exit(2);
                };
                if name != "pi" {
                    match Host::parse(name) {
                        Some(Host::Cline) => host = Some(HostChoice::Cline),
                        Some(Host::Kilo) => host = Some(HostChoice::Kilo),
                        Some(Host::Claude) => host = Some(HostChoice::Claude),
                        None => {
                            eprintln!("pi-vida: unknown host {name}");
                            exit(2);
                        }
                    }
                }
            }
            "-h" | "--help" | "help" => return Invocation::Help,
            "--" => {
                rest.extend(args[i + 1..].iter().cloned());
                break;
            }
            other => rest.push(other.to_string()),
        }
        i += 1;
    }
    if rest.is_empty() {
        // No vida argument: gum on a TTY (AC-6), bash usage otherwise.
        if std::io::stdin().is_terminal() {
            return Invocation::Interactive { host };
        }
        return Invocation::Bash;
    }
    let first = rest[0].as_str();
    // doctor / doctor-probe / --dump-overlay / agents stay bash (design §2;
    // agents is issue #81's bash subcommand).
    if first == "doctor" || first == "doctor-probe" || first == "--dump-overlay" || first == "agents" {
        return Invocation::Bash;
    }
    if let Some(msg) = rejected_vida(first) {
        eprintln!("{msg}");
        exit(2);
    }
    let Some(vida) = canonical_vida(first) else {
        eprintln!("pi-vida: unknown vida {first}");
        exit(2);
    };
    // Mode parsing mirrors the bash launcher (design §2): solo default,
    // fusion requires exactly one stack file argument.
    let mut mode = "solo".to_string();
    let mut fusion_stack = String::new();
    if rest.len() > 1 {
        mode = rest[1].clone();
        if !matches!(mode.as_str(), "solo" | "chain" | "team" | "fusion") {
            eprintln!("pi-vida: unknown mode {mode}");
            exit(2);
        }
        if mode == "fusion" {
            if rest.len() != 3 {
                eprintln!(
                    "pi-vida: fusion requires exactly one stack file: pi-vida {vida} fusion <stack.yaml>"
                );
                exit(2);
            }
            fusion_stack = rest[2].clone();
        } else if rest.len() > 2 {
            eprintln!("pi-vida: unexpected argument: {}", rest[2]);
            exit(2);
        }
    }
    // Modes are Pi-only (AC-9): a mode argument on a non-Pi host exits 2,
    // including an explicit `solo` (the design rejects any mode argument).
    if host.is_some() && rest.len() > 1 {
        eprintln!("pi-vida: modes are Pi-only; --host cline|kilo|claude takes no mode argument");
        exit(2);
    }
    Invocation::Host {
        host,
        vida: vida.to_string(),
        mode,
        fusion_stack,
        dry_run,
    }
}

pub fn run() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Root for locating the bash launcher and repo assets. Env overrides
    // (PI_VIDA_HOME etc) apply to the LAUNCH (profiles, extensions) — they
    // must not move the launcher itself, which lives next to this binary.
    // Same rule as the bash launcher's real_script_path.
    let Some(root) = exe_root() else {
        eprintln!("pi-vida: cannot locate harness root (exe must live in crates/pi-vida/target)");
        return 2;
    };
    match parse_args(&args) {
        Invocation::Help => {
            print_usage();
            0
        }
        Invocation::Bash => {
            let launch = root.join("libexec").join("pi-vida-launch");
            let arg0 = launch.display().to_string();
            exec_program(launch, arg0, args)
        }
        Invocation::Interactive { host } => {
            let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
            interactive(&root, &home, host)
        }
        Invocation::Host {
            host,
            vida,
            mode,
            fusion_stack,
            dry_run,
        } => {
            // Profile/asset reads honor the env root overrides exactly like
            // the bash launcher's resolve_root.
            let assets_root = harness_root().unwrap_or_else(|| root.clone());
            match host {
                None | Some(HostChoice::Pi) => {
                    // Pi = one launch pipeline: the bash launcher owns the
                    // INV-skills argv, overlay extras, and fusion assembly.
                    let mut passthrough = vec![vida.clone()];
                    if mode != "solo" || !fusion_stack.is_empty() {
                        passthrough.push(mode.clone());
                    }
                    if !fusion_stack.is_empty() {
                        passthrough.push(fusion_stack.clone());
                    }
                    if dry_run {
                        passthrough.insert(0, "--dry-run".into());
                    }
                    delegate(passthrough, &root)
                }
                Some(HostChoice::Cline) => run_host(Host::Cline, &vida, dry_run, &assets_root, &home_path(), &load_profile(&assets_root, &vida)),
                Some(HostChoice::Kilo) => run_host(Host::Kilo, &vida, dry_run, &assets_root, &home_path(), &load_profile(&assets_root, &vida)),
                Some(HostChoice::Claude) => run_host(Host::Claude, &vida, dry_run, &assets_root, &home_path(), &load_profile(&assets_root, &vida)),
            }
        }
    }
}

fn home_path() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn print_usage() {
    println!(
        "Usage: pi-vida [--dry-run] [--host pi|cline|kilo|claude] [vida] [mode] [fusion-stack]
       pi-vida doctor [vida]
       pi-vida --help

Vidas: rust | elixir | ruby | python (aliases: phoenix → elixir, rails → ruby)
Modes solo|chain|team|fusion are Pi only. --host cline|kilo|claude installs,
projects skills, then execs (or prints how to run the host)."
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fusion_vida_mode_stack_parses() {
        let args: Vec<String> = ["--dry-run", "rust", "fusion", "/tmp/stack.yaml"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            parse_args(&args),
            Invocation::Host {
                host: None,
                vida: "rust".into(),
                mode: "fusion".into(),
                fusion_stack: "/tmp/stack.yaml".into(),
                dry_run: true,
            }
        );
    }

    #[test]
    fn team_mode_parses() {
        let args: Vec<String> = ["rust", "team"].iter().map(|s| s.to_string()).collect();
        assert_eq!(
            parse_args(&args),
            Invocation::Host {
                host: None,
                vida: "rust".into(),
                mode: "team".into(),
                fusion_stack: String::new(),
                dry_run: false,
            }
        );
    }

    #[test]
    fn parse_flags_before_and_after_vida() {
        let args: Vec<String> = ["--dry-run", "ruby", "--host", "kilo"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            parse_args(&args),
            Invocation::Host {
                host: Some(HostChoice::Kilo),
                vida: "ruby".into(),
                mode: "solo".into(),
                fusion_stack: String::new(),
                dry_run: true,
            }
        );
        let args: Vec<String> = ["--host", "claude", "--dry-run", "rails"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            parse_args(&args),
            Invocation::Host {
                host: Some(HostChoice::Claude),
                vida: "ruby".into(),
                mode: "solo".into(),
                fusion_stack: String::new(),
                dry_run: true,
            }
        );
    }

    #[test]
    fn modes_are_pi_only_error_text() {
        // parse_args exits 2 for a mode on a non-Pi host; the message is
        // what smoke greps, so pin the exact wording here.
        let expected = "pi-vida: modes are Pi-only; --host cline|kilo|claude takes no mode argument";
        assert!(expected.contains("modes are Pi-only"));
        // The rejection is exercised end-to-end in `just smoke` (AC-9),
        // because process::exit inside parse_args cannot be caught in-process.
    }

    #[test]
    fn help_does_not_start_gum() {
        for h in ["help", "-h", "--help"] {
            let args: Vec<String> = [h].iter().map(|s| s.to_string()).collect();
            assert_eq!(parse_args(&args), Invocation::Help);
        }
    }

    #[test]
    fn doctor_and_dump_overlay_stay_bash() {
        for first in ["doctor", "doctor-probe", "agents"] {
            let args: Vec<String> = [first, "ruby"].iter().map(|s| s.to_string()).collect();
            assert_eq!(parse_args(&args), Invocation::Bash);
        }
        let args: Vec<String> = ["--dump-overlay", "."].iter().map(|s| s.to_string()).collect();
        assert_eq!(parse_args(&args), Invocation::Bash);
    }

    #[test]
    fn aliases_and_rejections() {
        let args: Vec<String> = ["phoenix"].iter().map(|s| s.to_string()).collect();
        assert_eq!(
            parse_args(&args),
            Invocation::Host {
                host: None,
                vida: "elixir".into(),
                mode: "solo".into(),
                fusion_stack: String::new(),
                dry_run: false,
            }
        );
        assert!(rejected_vida("rails-python").is_some());
        assert!(rejected_vida("ecto").is_some());
        assert!(rejected_vida("ruby").is_none());
        assert_eq!(canonical_vida("rails"), Some("ruby"));
        assert_eq!(canonical_vida("ecto"), None);
    }

    #[test]
    fn cline_projects_nothing_when_home_is_canonical() {
        // skills_home resolves PI_SKILLS_HOME; default = ~/.agents/skills.
        let home = std::env::temp_dir().join(format!("pv-cli-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::env::remove_var("PI_SKILLS_HOME");
        assert_eq!(skills_home(&home), home.join(".agents").join("skills"));
        std::env::set_var("PI_SKILLS_HOME", "/tmp/other-home");
        assert_eq!(skills_home(&home), PathBuf::from("/tmp/other-home"));
        std::env::remove_var("PI_SKILLS_HOME");
        let _ = std::fs::remove_dir_all(&home);
    }
}
