@echo off
setlocal EnableExtensions

set "HERE=%~dp0"

call "%HERE%marketplace-add-local.cmd" || exit /b 1
call "%HERE%marketplace-install-local.cmd" || exit /b 1

echo [install-local] done. Plugin 'codex-team' installed.
