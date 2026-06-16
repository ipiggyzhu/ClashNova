fn main() {
    // Windows 平台：仅为主程序 (clashnova.exe) 嵌入图标
    // 服务安装/卸载程序不需要图标，避免资源冲突
    #[cfg(windows)]
    {
        // 检查是否是主程序构建
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
