@echo off
setlocal EnableExtensions

if "%CLAUDE_PLUGIN_ROOT%"=="" (
  for %%I in ("%~dp0..") do set "PLUGIN_ROOT=%%~fI"
) else (
  set "PLUGIN_ROOT=%CLAUDE_PLUGIN_ROOT%"
)

call "%PLUGIN_ROOT%\bin\codex-team.cmd" daemon start >nul || exit /b 1
call "%PLUGIN_ROOT%\bin\codex-team.cmd" monitor events %*
