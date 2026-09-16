use std::os::unix::process::ExitStatusExt;
use std::process::{Command, exit};

fn launch_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    // <root>/crates/pi-vida/target/release/pi-vida -> <root>
    let root = exe.parent()?.ancestors().nth(4)?;
    let launch = root.join("libexec/pi-vida-launch");
    launch.is_file().then_some(launch)
}

fn main() {
    let launch = match launch_path() {
        Some(p) => p,
        None => {
            eprintln!(
                "pi-vida: cannot locate libexec/pi-vida-launch relative to {}",
                std::env::current_exe().unwrap_or_default().display()
            );
            exit(2);
        }
    };
    let status = Command::new(&launch)
        .args(std::env::args_os().skip(1))
        .status()
        .unwrap_or_else(|err| {
            eprintln!("pi-vida: exec {} failed: {err}", launch.display());
            exit(2);
        });
    // Mirror bash: signal deaths exit 128+N so wrappers see the real cause.
    exit(status.code().unwrap_or_else(|| 128 + status.signal().unwrap_or(0)));
}
