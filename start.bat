@echo off
REM ==========================================
REM  Ollama Client - Auto Start Script
REM  (Starts the Node server and opens the page)
REM ==========================================

REM --- Move to the project folder ---
cd /d "%~dp0"

REM --- Check Node.js ---
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] Node.js is not installed or not available in PATH.
  pause
  exit /b
)

REM --- Detect if port is already in use ---
set "LISTEN_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":3001 .*LISTENING"') do (
  set "LISTEN_PID=%%p"
  goto :port_checked
)

:port_checked
if defined LISTEN_PID (
  echo Port 3001 is already in use by PID %LISTEN_PID%.
  echo Reusing existing server and opening the dashboard page.
) else (
  REM --- Start the server in the background ---
  start "OllamaClient" cmd /k "npm start"
  REM --- Wait a few seconds for the server to start ---
  timeout /t 3 /nobreak >nul
)


REM --- Open the page in the default browser ---
start "" "http://localhost:3001"

echo Server started and page opened.
echo You can close this window if needed.
exit /b
