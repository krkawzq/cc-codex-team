@echo off
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
claude plugin marketplace add "%ROOT%"
