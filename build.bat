@echo off
echo ==========================================
echo  Disk Cleaner Build Script
echo ==========================================
echo.

:: Check Node.js
where npm >nul 2>nul
if %errorlevel% neq 0 (
    echo [Error] npm not found, please install Node.js!
    pause
    exit /b 1
)

:: Check Rust
where cargo >nul 2>nul
if %errorlevel% neq 0 (
    echo [Error] cargo not found, please install Rust!
    pause
    exit /b 1
)

echo [1/3] Installing Node dependencies...
call npm install

echo.
echo [2/3] Building frontend...
call npm run build

echo.
echo [3/3] Building Tauri Release...
call npm run tauri build

echo.
echo ==========================================
echo  Build completed!
echo  Executable:
echo    %~dp0src-tauri\target\release\disk-cleaner.exe
echo  NSIS installer:
echo    %~dp0src-tauri\target\release\bundle\nsis\
echo ==========================================
echo.
pause
