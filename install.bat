@echo off
REM Reader - one-click installer for people who cloned this repo from GitHub.
REM Windows: double-click this file (install.bat) in File Explorer.
REM
REM It builds the extension from source, then walks you through the single
REM manual step Chrome requires ("Load unpacked").

cd /d "%~dp0"

echo.
echo   Reader - installing the Chrome extension from this folder
echo.

REM --- 1. Make sure Node.js / npm are available -------------------------------
where npm >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed - the build needs it.
  echo.
  echo   Install it once ^(free, ~30 seconds^):
  echo     1. Go to  https://nodejs.org  and download the "LTS" version
  echo     2. Open the downloaded installer and click through it
  echo     3. Come back and double-click install.bat again
  echo.
  start "" "https://nodejs.org/en/download/prebuilt-installer"
  echo Press any key to close.
  pause >nul
  exit /b 1
)

REM --- 2. Build the extension -------------------------------------------------
echo Installing dependencies ^(first run downloads a bit - please wait^)...
call npm install
if errorlevel 1 goto fail

echo.
echo Building the extension...
call npm run build
if errorlevel 1 goto fail

echo.
echo   Built. The extension is the  dist  folder inside this project.
echo.

REM --- 3. Hand off to Chrome for the one manual step --------------------------
echo Finish in Chrome ^(one time, ~15 seconds^):
echo   1. Chrome will open to  chrome://extensions
echo   2. Turn ON "Developer mode" ^(toggle, top-right^)
echo   3. Click "Load unpacked"
echo   4. Pick this folder:
echo         %cd%\dist
echo.

start chrome "chrome://extensions/"
start "" "%cd%\dist"

echo Done - you can close this window.
echo.
echo Press any key to close.
pause >nul
exit /b 0

:fail
echo.
echo   Something went wrong during the build. Scroll up to see the error.
echo Press any key to close.
pause >nul
exit /b 1
