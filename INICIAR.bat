@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Necesitas instalar Node.js 22.13 o superior desde https://nodejs.org & pause & exit /b 1)
if not exist node_modules call npm install
start "" http://localhost:3000
call npm start
pause
