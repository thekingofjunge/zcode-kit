@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
call "%~dp0_node.cmd" || exit /b 1

echo ============================================================
echo  刷新凭据（客户端 → 项目 → 前端）
echo  适用时机：上游开始返回 401 / 换了账号 / 客户端重新登录过
echo ============================================================
echo.
%NODE% src\refresh-all.cjs
echo.
echo 若本地路由正在运行，请重启它以加载新凭据。
pause
