@echo off
rem ШТАБ-кокпит: запуск на Windows. Двойной клик по этому файлу.
rem Ставит что может и запускает. Нет питона или claude — не беда: ШТАБ откроется,
rem просто вкладка «Терминал» и ИИ-выжимки будут недоступны (в Настройках → Окружение видно, чего нет).
setlocal
cd /d "%~dp0"
chcp 65001 >nul

rem Node — единственное, без чего запускать нечего
where npm >nul 2>&1 || (echo. & echo [X] Нет Node.js/npm — без него ШТАБ не запустить. & echo     Поставь с https://nodejs.org ^(LTS^), потом запусти этот файл снова. & echo. & pause & exit /b 1)

rem питон: ищем РАБОЧИЙ (в Win11 "where python" часто ловит заглушку из Microsoft Store)
set "PY="
for %%C in (py python) do (
  if not defined PY (
    where %%C >nul 2>&1 && ( %%C -c "import venv, ensurepip" >nul 2>&1 && set "PY=%%C" )
  )
)

if not defined PY (
  echo [!] Рабочий Python 3 не найден — пропускаю.
  echo     Без него ШТАБ откроется, но не будет вкладки "Терминал" и ИИ-выжимок.
  echo     Хочешь их: поставь с https://python.org ^(галочка "Add to PATH"^) и запусти этот файл снова.
  echo.
) else (
  if not exist "term\.venv\Scripts\python.exe" (
    echo   -^> создаю питон-окружение term\.venv ...
    %PY% -m venv "term\.venv" || echo [!] venv не создался — терминал и выжимки будут недоступны.
  )
  if exist "term\.venv\Scripts\python.exe" (
    echo   -^> проверяю зависимости сайдкара ^(aiohttp, pywinpty^)...
    "term\.venv\Scripts\python.exe" -m pip install -q -r term\requirements.txt || echo [!] зависимости не встали — терминал и выжимки будут недоступны.
  )
)

rem electron (node_modules не в git — своя сборка на каждой машине)
if not exist "node_modules\electron" (
  echo   -^> ставлю electron ^(npm install, первый раз пара минут^)...
  call npm install || (echo. & echo [X] npm install не прошёл — без него не запустить. & echo. & pause & exit /b 1)
)

where claude >nul 2>&1 || echo [!] claude CLI не найден — терминал и ИИ-выжимки не заработают ^(поставь и залогинь claude^).

echo   -^> запускаю ШТАБ...
echo      Первый раз? На стартовом экране есть кнопка "Открыть на демо-проектах" — посмотреть без настройки.
call npm start
