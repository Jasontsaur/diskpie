@echo off
chcp 65001 >nul
cd /d "%~dp0"
title DiskPie
echo 正在啟動 DiskPie...（關閉這個視窗就會結束程式）
python diskpie.py %*
if errorlevel 1 pause
