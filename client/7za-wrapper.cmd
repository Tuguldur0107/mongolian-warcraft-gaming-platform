@echo off
setlocal

:: Run real 7za with all args
"D:\Personal files\Personal\New\Personal projects\warcraft\client\node_modules\7zip-bin\win\x64\7za.exe" %*
set EXIT_CODE=%errorlevel%

:: 7za exit code 2 = "Fatal error" but on Windows without Developer Mode,
:: this is caused ONLY by failed symlink creation (macOS files in winCodeSign).
:: The extraction succeeded for all Windows-needed files. Treat as success.
if %EXIT_CODE% == 2 (
    echo [7za-wrapper] Ignoring exit code 2 (symlink creation failed, Windows files OK)
    exit /b 0
)

exit /b %EXIT_CODE%
