@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo [Fabula] 启动中...

if not exist "node_modules\electron\dist\electron.exe" (
  echo [Fabula] 依赖未安装，首次运行正在安装（需要几分钟）...
  call npm install
  if errorlevel 1 (
    echo [Fabula] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

start "" "node_modules\electron\dist\electron.exe" .
exit /b 0
