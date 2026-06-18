#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[path = "../service_host.rs"]
mod service_host;

fn main() {
    service_host::run_dispatcher();
}
