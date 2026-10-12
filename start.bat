@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"

echo.
echo  正在启动持仓助手...
echo.
"%NODE%" server.mjs
if errorlevel 1 (
  echo.
  echo  启动失败。请确认上面第一行报错信息。
  echo  也可以先检查 Node 是否存在：
  echo    "%NODE%" -v
  echo.
)
pause
