mod cli;
mod hosts;
mod profile;
mod resolve;

fn main() {
    std::process::exit(cli::run());
}
