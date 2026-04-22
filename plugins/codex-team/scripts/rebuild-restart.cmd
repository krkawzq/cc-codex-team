@echo off
setlocal EnableExtensions

if "%CLAUDE_PLUGIN_ROOT%"=="" (
  for %%I in ("%~dp0..") do set "PLUGIN_ROOT=%%~fI"
) else (
  set "PLUGIN_ROOT=%CLAUDE_PLUGIN_ROOT%"
)

echo [rebuild-restart] building...
pushd "%PLUGIN_ROOT%" || exit /b 1
call npm run build || (popd & exit /b 1)
popd

echo [rebuild-restart] restarting daemon...
call "%PLUGIN_ROOT%\bin\codex-team.cmd" daemon restart || exit /b 1

echo [rebuild-restart] done.
