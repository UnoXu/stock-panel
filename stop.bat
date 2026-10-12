@echo off
chcp 65001 >nul
rem 停掉持仓助手（本机 8787 端口上的服务）
setlocal

echo.
echo  正在查找 8787 端口上的服务...
set "FOUND="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr ":8787"') do (
  set "FOUND=1"
  echo  找到 PID %%p，正在结束...
  taskkill /PID %%p /F >nul 2>&1
)

if not defined FOUND (
  echo  没有在运行的服务（8787 端口空闲）。
) else (
  echo  已停止。数据文件没有被删除，下次启动照样在。
)
echo.
pause
