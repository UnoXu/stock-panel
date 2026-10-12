@echo off
rem 只负责起服务，不 pause —— 供开机自启和后台启动调用。
rem 需要「有报错时停下来给人看」的场景请用 start.bat。
setlocal
cd /d "%~dp0"

set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"

"%NODE%" server.mjs
