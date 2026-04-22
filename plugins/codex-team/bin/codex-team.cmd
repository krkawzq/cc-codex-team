@echo off
setlocal EnableExtensions EnableDelayedExpansion

if "%CLAUDE_PLUGIN_ROOT%"=="" (
  for %%I in ("%~dp0..") do set "PLUGIN_ROOT=%%~fI"
) else (
  set "PLUGIN_ROOT=%CLAUDE_PLUGIN_ROOT%"
)

if not "%CLAUDE_PLUGIN_DATA%"=="" (
  if not "%CLAUDE_PLUGIN_ROOT%"=="" (
    if "%CODEX_TEAM_DATA_DIR%"=="" set "CODEX_TEAM_DATA_DIR=%CLAUDE_PLUGIN_DATA%\data"
  ) else (
    echo %CLAUDE_PLUGIN_DATA% | findstr /I /C:"codex-team" >nul
    if not errorlevel 1 if "%CODEX_TEAM_DATA_DIR%"=="" set "CODEX_TEAM_DATA_DIR=%CLAUDE_PLUGIN_DATA%\data"
  )
)

set "ENTRY=%PLUGIN_ROOT%\dist\main.js"
if not exist "%ENTRY%" (
  echo codex-team is not built yet: %ENTRY% missing 1>&2
  echo run: cd %PLUGIN_ROOT% ^&^& npm install ^&^& npm run build 1>&2
  exit /b 1
)

node "%ENTRY%" %*
