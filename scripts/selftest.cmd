@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
call "%~dp0_node.cmd" || exit /b 1

echo ============================================================
echo  端到端自检
echo ============================================================
echo.
%NODE% src\tools\selftest.cjs %*
echo.
pause
