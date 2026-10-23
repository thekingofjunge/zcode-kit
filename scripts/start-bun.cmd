@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

where bun >nul 2>&1
if errorlevel 1 (
  echo [错误] 找不到 bun。
  echo.
  echo 本项目在 Node 下能跑通本地接口，但发往上游的那一跳可能因
  echo 传输层指纹被风控拦截（405 unusual activity）。
  echo 如果你遇到 405，建议改用 Bun 运行本路由：
  echo.
  echo   安装 Bun : powershell -c "irm bun.sh/install.ps1 ^| iex"
  echo   启动     : bun src\router.cjs
  echo.
  pause
  exit /b 1
)

echo ============================================================
echo  zcode-kit 本地路由（Bun 运行时）
echo  本窗口保持打开即为服务运行中
echo ============================================================
echo.
bun src\router.cjs %*
echo.
echo [已停止] 按任意键关闭。
pause >nul
