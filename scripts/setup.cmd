@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
call "%~dp0_node.cmd" || exit /b 1

echo ============================================================
echo  zcode-kit 初始化
echo ============================================================
echo.

if not exist config.json (
  copy /y config.example.json config.json >nul
  echo [1] 已从模板创建 config.json —— 建议先打开改成你自己的端口与密钥
) else (
  echo [1] config.json 已存在，跳过
)
echo.

echo [2] 读取客户端凭据并换取项目凭据 ...
%NODE% src\refresh-all.cjs
if errorlevel 1 (
  echo.
  echo [中断] 凭据刷新失败。请确认 ZCode 客户端已安装且处于已登录状态。
  pause
  exit /b 1
)

echo.
echo ============================================================
echo  完成。下一步：
echo    scripts\start.cmd     启动本地路由
echo    scripts\selftest.cmd  自检
echo ============================================================
pause
