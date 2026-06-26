@echo off
chcp 65001 >nul
echo ==========================================
echo  磁盘清理工具 (Disk Cleaner) 一键构建脚本
echo ==========================================
echo.

:: 检查 Node.js 环境
where npm >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 npm 环境，请先安装 Node.js!
    pause
    exit /b 1
)

:: 检查 Rust 环境
where cargo >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Rust (cargo) 环境，请先安装 Rust (Rustup) 环境!
    pause
    exit /b 1
)

echo [1/3] 正在检查/安装 Node 模块依赖...
call npm install

echo.
echo [2/3] 正在构建前端资源...
call npm run build

echo.
echo [3/3] 正在构建 Windows 桌面端程序 (Tauri Release)...
call npm run tauri build

echo.
echo ==========================================
echo  构建已完成！
echo  生成的可执行文件:
echo    d:\jin_huaquan\Program\Rust\Sourcecode\disk-cleaner\src-tauri\target\release\app.exe
echo  NSIS 安装包文件位于:
echo    d:\jin_huaquan\Program\Rust\Sourcecode\disk-cleaner\src-tauri\target\release\bundle\nsis\
echo ==========================================
echo.
pause
