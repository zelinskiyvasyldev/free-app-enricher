@echo off
REM Free App Enricher - one-click local startup
REM Starts the enrichment server on :3000 and a self-healing public tunnel.
cd /d "%~dp0"

echo Starting enrichment server on port 3000...
start "Free App Enricher - server" cmd /k "node server.js"

echo Starting self-healing public tunnel (pinggy + auto URL updates)...
start "Free App Enricher - tunnel" cmd /k "node tunnel.js"

echo.
echo ============================================================
echo  Wait ~15 seconds. The tunnel window will show:
echo    YOUR ENRICHER URL:  https://xxxxx.free.pinggy.net
echo    AUTO-UPDATE CODE:   app-enricher-xxxxxxxx
echo.
echo  ONE-TIME: copy the AUTO-UPDATE CODE into Google Sheets:
echo    Free App Enricher -^> 2. Set URL auto-update channel
echo  After that the sheet always finds the current URL by itself,
echo  even when the tunnel renews (every ~50 minutes) or the PC
echo  restarts. You never paste a URL again.
echo ============================================================
echo.
echo Keep both windows open while enrichment runs.
pause
