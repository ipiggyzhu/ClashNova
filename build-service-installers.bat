@echo off
REM 构建服务安装/卸载程序并复制到 binaries 目录

echo 构建服务安装程序...
cargo build --release --bin clashnova-service-install
if %errorlevel% neq 0 exit /b %errorlevel%

echo 构建服务卸载程序...
cargo build --release --bin clashnova-service-uninstall
if %errorlevel% neq 0 exit /b %errorlevel%

echo 创建 binaries 目录...
if not exist "src-tauri\binaries" mkdir "src-tauri\binaries"

echo 复制二进制文件...
copy /Y "target\release\clashnova-service-install.exe" "src-tauri\binaries\" >nul
copy /Y "target\release\clashnova-service-uninstall.exe" "src-tauri\binaries\" >nul

echo 完成！
