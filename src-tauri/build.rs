use std::path::Path;

const SERVICE_RESOURCE_FILES: &[&str] = &[
    "resources/clashnova-service.exe",
    "resources/clashnova-service-install.exe",
    "resources/clashnova-service-uninstall.exe",
];

const PLACEHOLDER_BYTES: &[u8] = b"CLASHNOVA_SERVICE_RESOURCE_PLACEHOLDER\n";

fn ensure_service_resource_files() {
    println!("cargo:rerun-if-env-changed=CLASHNOVA_ALLOW_PLACEHOLDER_SERVICE_RESOURCES");

    let allow_placeholder =
        std::env::var_os("CLASHNOVA_ALLOW_PLACEHOLDER_SERVICE_RESOURCES").is_some();

    for relative in SERVICE_RESOURCE_FILES {
        println!("cargo:rerun-if-changed={relative}");
        let path = Path::new(relative);

        if allow_placeholder {
            if !path.exists() {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)
                        .expect("failed to create service resource directory");
                }
                std::fs::write(path, PLACEHOLDER_BYTES)
                    .expect("failed to create service resource placeholder");
            }
            continue;
        }

        let bytes = std::fs::read(path).unwrap_or_else(|_| {
            panic!(
                "service resource `{relative}` is missing; build service helpers and copy them into src-tauri/resources before running the Tauri bundle build"
            )
        });
        if bytes == PLACEHOLDER_BYTES {
            panic!(
                "service resource `{relative}` is still a placeholder; copy the built helper executable into src-tauri/resources before running the Tauri bundle build"
            );
        }
    }
}

fn main() {
    let build_id = std::env::var("GITHUB_SHA")
        .or_else(|_| std::env::var("CLASHNOVA_BUILD_ID"))
        .unwrap_or_else(|_| "dev".to_string());
    println!("cargo:rustc-env=CLASHNOVA_BUILD_ID={build_id}");
    ensure_service_resource_files();

    #[cfg(windows)]
    {
        let target = std::env::var("CARGO_BIN_NAME").unwrap_or_default();
        if target == "clashnova" {
            let mut res = winres::WindowsResource::new();
            res.set_icon("icons/icon.ico");
            if let Err(e) = res.compile() {
                println!("cargo:warning=Failed to compile Windows resources: {}", e);
            }
        }
    }

    tauri_build::build()
}
