fn main() {
    let build_id = std::env::var("GITHUB_SHA")
        .or_else(|_| std::env::var("CLASHNOVA_BUILD_ID"))
        .unwrap_or_else(|_| "dev".to_string());
    println!("cargo:rustc-env=CLASHNOVA_BUILD_ID={build_id}");
}
