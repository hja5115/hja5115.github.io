@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js가 필요합니다. Node.js를 설치한 뒤 다시 실행해 주세요.
  pause
  exit /b 1
)
set PORT=4174
echo.
echo 브라우저에서 http://127.0.0.1:4174 를 열어주세요.
echo 이 창을 닫으면 로컬 편집기가 종료됩니다.
echo.
node scripts/serve.mjs
pause
