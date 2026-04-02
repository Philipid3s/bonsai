@echo off
setlocal EnableDelayedExpansion
REM ==========================================
REM  bonsAI - local ollama client - Auto Start Script
REM  (Starts Chroma if needed, then Node server and opens the page)
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

set "APP_PORT=3001"
set "CHROMA_HOST=127.0.0.1"
set "CHROMA_PORT=8000"

for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
  if /I "%%~A"=="PORT" set "APP_PORT=%%~B"
  if /I "%%~A"=="CHROMA_HOST" set "CHROMA_HOST=%%~B"
  if /I "%%~A"=="CHROMA_PORT" set "CHROMA_PORT=%%~B"
)

echo Checking Chroma at http://%CHROMA_HOST%:%CHROMA_PORT%/api/v2/heartbeat ...
powershell -NoProfile -Command ^
  "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://%CHROMA_HOST%:%CHROMA_PORT%/api/v2/heartbeat' -TimeoutSec 2; exit 0 } catch { exit 1 }"

if %errorlevel% neq 0 (
  echo Chroma is not responding. Attempting to start it...

  if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" (
    where chroma >nul 2>nul && (
      start "bonsAI Chroma" cmd /k "chroma run"
      goto :wait_for_chroma
    )
  )

  where python >nul 2>nul && python -c "import chromadb" >nul 2>nul && (
    start "bonsAI Chroma" cmd /k "python -m chromadb.cli.cli run"
    goto :wait_for_chroma
  )

  where docker >nul 2>nul && docker info >nul 2>nul && (
    echo Starting Chroma with Docker...
    docker rm -f bonsai-chroma >nul 2>nul
    start "bonsAI Chroma" cmd /k "docker run --name bonsai-chroma -p %CHROMA_PORT%:8000 -v \"%cd%\chroma-data:/data\" chromadb/chroma"
    goto :wait_for_chroma
  )

  echo [WARNING] Could not auto-start Chroma.
  echo No usable local Chroma launcher was found.
  echo Install Python chromadb with `pip install chromadb`, or make sure Docker Desktop is running.
  goto :check_app_port
)

echo Chroma is already running.
goto :check_app_port

:wait_for_chroma
set "CHROMA_READY="
for /l %%I in (1,1,10) do (
  timeout /t 1 /nobreak >nul
  powershell -NoProfile -Command ^
    "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://%CHROMA_HOST%:%CHROMA_PORT%/api/v2/heartbeat' -TimeoutSec 2; exit 0 } catch { exit 1 }"
  if !errorlevel! equ 0 (
    set "CHROMA_READY=1"
    goto :chroma_checked
  )
)

:chroma_checked
if defined CHROMA_READY (
  echo Chroma started successfully.
) else (
  echo [WARNING] Chroma did not respond on http://%CHROMA_HOST%:%CHROMA_PORT%.
)

:check_app_port
REM --- Detect if port is already in use ---
set "LISTEN_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%APP_PORT% .*LISTENING"') do (
  set "LISTEN_PID=%%p"
  goto :port_checked
)

:port_checked
if defined LISTEN_PID (
  echo Port %APP_PORT% is already in use by PID %LISTEN_PID%.
  echo Reusing existing server and opening the dashboard page.
) else (
  REM --- Start the server in the background ---
  start "bonsAI" cmd /k "npm start"
  REM --- Wait a few seconds for the server to start ---
  timeout /t 3 /nobreak >nul
)


REM --- Open the page in the default browser ---
start "" "http://localhost:%APP_PORT%"

echo Server started and page opened.
echo You can close this window if needed.
exit /b
