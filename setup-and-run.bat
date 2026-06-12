@echo off
setlocal EnableDelayedExpansion
title xvid - setup ^& run
cd /d "%~dp0"

echo.
echo  ============================================
echo   xvid - dependency check ^& launch
echo  ============================================
echo.

:: ---------------------------------------------------------------
:: 0) winget is required for any installs
:: ---------------------------------------------------------------
where winget >nul 2>&1
if errorlevel 1 (
    set "WINGET_OK=0"
) else (
    set "WINGET_OK=1"
)

set "NEED_PATH_REFRESH=0"

:: ---------------------------------------------------------------
:: 1) Node.js
:: ---------------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
    echo  [MISSING] Node.js
    call :require_winget || goto :fail
    echo  [INSTALL] Node.js LTS via winget...
    winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    if errorlevel 1 ( echo  [ERROR] Node.js install failed. & goto :fail )
    set "NEED_PATH_REFRESH=1"
) else (
    for /f "delims=" %%v in ('node --version') do echo  [OK] Node.js %%v
)

:: ---------------------------------------------------------------
:: 2) yt-dlp
:: ---------------------------------------------------------------
where yt-dlp >nul 2>&1
if errorlevel 1 (
    echo  [MISSING] yt-dlp
    call :require_winget || goto :fail
    echo  [INSTALL] yt-dlp via winget...
    winget install -e --id yt-dlp.yt-dlp --accept-package-agreements --accept-source-agreements
    if errorlevel 1 ( echo  [ERROR] yt-dlp install failed. & goto :fail )
    set "NEED_PATH_REFRESH=1"
) else (
    for /f "delims=" %%v in ('yt-dlp --version') do echo  [OK] yt-dlp %%v
)

:: ---------------------------------------------------------------
:: 3) ffmpeg
:: ---------------------------------------------------------------
where ffmpeg >nul 2>&1
if errorlevel 1 (
    echo  [MISSING] ffmpeg
    call :require_winget || goto :fail
    echo  [INSTALL] ffmpeg via winget...
    winget install -e --id Gyan.FFmpeg --accept-package-agreements --accept-source-agreements
    if errorlevel 1 ( echo  [ERROR] ffmpeg install failed. & goto :fail )
    set "NEED_PATH_REFRESH=1"
) else (
    echo  [OK] ffmpeg
)

:: ---------------------------------------------------------------
:: 4) Refresh PATH in this session if anything was installed
::    (winget edits the registry; the current cmd session doesn't
::     see it until restarted, so re-read PATH from the registry)
:: ---------------------------------------------------------------
if "!NEED_PATH_REFRESH!"=="1" (
    echo.
    echo  [INFO] Refreshing PATH for this session...
    for /f "skip=2 tokens=2,*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SYS_PATH=%%b"
    for /f "skip=2 tokens=2,*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USR_PATH=%%b"
    set "PATH=!SYS_PATH!;!USR_PATH!"

    :: verify everything is now reachable
    where node >nul 2>&1 || goto :restart_needed
    where yt-dlp >nul 2>&1 || goto :restart_needed
    where ffmpeg >nul 2>&1 || goto :restart_needed
)

:: ---------------------------------------------------------------
:: 5) npm dependencies
:: ---------------------------------------------------------------
if not exist "node_modules\" (
    echo.
    echo  [INSTALL] npm packages...
    call npm install --no-audit --no-fund
    if errorlevel 1 ( echo  [ERROR] npm install failed. & goto :fail )
) else (
    echo  [OK] node_modules present
)

:: ---------------------------------------------------------------
:: 6) Launch
:: ---------------------------------------------------------------
echo.
echo  [RUN] starting server on http://localhost:3000
echo        (Ctrl+C to stop)
echo.
start "" "http://localhost:3000"
node server.js
goto :eof

:: ---------------------------------------------------------------
:require_winget
if "%WINGET_OK%"=="0" (
    echo.
    echo  [ERROR] winget not found - can't auto-install dependencies.
    echo          Install "App Installer" from the Microsoft Store, or
    echo          install Node.js, yt-dlp, and ffmpeg manually.
    exit /b 1
)
exit /b 0

:restart_needed
echo.
echo  [INFO] Installs finished, but this session can't pick up the
echo         new PATH. Close this window and run the script again -
echo         it will skip straight to launching.
pause
exit /b 0

:fail
echo.
echo  Setup did not complete.
pause
exit /b 1
