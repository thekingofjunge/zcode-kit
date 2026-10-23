@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

echo ============================================================
echo  清理运行期产物（准备分享/提交前建议执行）
echo  只会删除派生文件，不动源码与 docs
echo ============================================================
echo.

set FILES=config.json cred.resolved.json credential-plain.json zcode-credentials.plain.json router.log router.err dump.jsonl cookies.txt probe.json probe2.json probe-body.json test.json body.json
for %%f in (%FILES%) do (
  if exist "%%f" (
    del /q "%%f" >nul 2>&1
    echo   已删除 %%f
  )
)

echo.
echo 保留说明：
echo   ~/.zcode-proxy/credentials.json（若存在）是真实凭据，位于本目录之外，
echo   未被删除。分享项目目录不受影响。
echo.
echo 当前目录剩余文件：
dir /b
pause
