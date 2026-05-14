@echo off
REM 拆除 Windows 合并栈并删除卷（compose down -v）
cd /d "%~dp0"
docker-compose -f docker-compose.yml -f docker-compose.windows.yml down -v
