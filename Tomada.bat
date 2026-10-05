@echo off
rem Abre o Tomada. Se o app ainda nao foi construido (pasta out\), constroi antes.
setlocal
cd /d "%~dp0"

rem Este PC tem ELECTRON_RUN_AS_NODE ligada; com ela o Electron vira um Node comum e nao abre.
set ELECTRON_RUN_AS_NODE=

if not exist "node_modules\" (
  echo Instalando dependencias, so na primeira vez...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :falhou
)

if not exist "out\main\index.js" (
  echo Construindo o Tomada, so na primeira vez...
  call npm run build
  if errorlevel 1 goto :falhou
)

start "" "node_modules\electron\dist\electron.exe" .
exit /b 0

:falhou
echo.
echo O Tomada nao conseguiu iniciar. Leia a mensagem acima.
pause
exit /b 1
