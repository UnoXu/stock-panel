' 持仓助手 — 无窗口后台启动（供开机自启用）
' 双击这个文件也能启动；它会调用 start.bat，但不显示黑窗口。
' 想停掉服务：运行同目录的 stop.bat

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = scriptDir

' 用 cmd 启动（不 pause 的版本），窗口隐藏（0）
shell.Run """" & scriptDir & "\start-server.cmd""", 0, False
