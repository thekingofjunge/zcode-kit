@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
call "%~dp0_node.cmd" || exit /b 1

echo ============================================================
echo  zcode-kit 本地路由
echo  监听地址与密钥见 config.json（默认 127.0.0.1:8788）
echo  本窗口保持打开即为服务运行中；关闭窗口即停止服务
echo ============================================================
echo.
%NODE% src\router.cjs %*
echo.
echo [已停止] 按任意键关闭。
pause >nul
