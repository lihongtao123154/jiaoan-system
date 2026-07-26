@echo off
chcp 65001 >nul
title 《体育与健康》课程教学资源库

echo ============================================
echo   《体育与健康》课程教学资源库 - 启动
echo ============================================

cd /d "%~dp0"
start /B node server.js
timeout /t 2 /nobreak >nul

echo.
echo   本地访问: http://localhost:3000
echo   默认账号: admin / admin123
echo.
echo   关闭本窗口即可停止服务
echo ============================================

start http://localhost:3000
pause
