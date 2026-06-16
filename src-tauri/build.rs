fn main() {
    // Windows 平台：嵌入应用图标到 exe
    #[cfg(windows)]
    {
        let mut res = winres::WindowsResource::new();
        res.set_icon("icons/icon.ico");
        res.compile().expect("Failed to compile Windows resources");
    }

    tauri_build::build()
}
