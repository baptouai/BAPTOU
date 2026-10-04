' Starts BAPTOU Admin without a console window. The server opens its own window.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "node """ & here & "\server.mjs""", 0, False
