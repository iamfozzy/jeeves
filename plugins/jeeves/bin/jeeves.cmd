@echo off
rem Jeeves — launch the cockpit (the loop's orchestrator plus the browser UI).
rem   jeeves              start the cockpit, open the browser
rem   jeeves --no-open    start without opening a browser
rem   jeeves rebuild      rebuild the UI, then start
where node >nul 2>nul || (echo jeeves: 'node' is not on PATH.>&2 & exit /b 1)
node "%~dp0..\cockpit\bin\cockpit.mjs" %*
