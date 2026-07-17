#!/bin/bash
# ШТАБ-кокпит: запуск на маке. Двойной клик по этому файлу в Finder.
# Сам проверяет, чего не хватает, ставит зависимости и запускает приложение.
set -e
cd "$(dirname "$0")"

fail() { echo ""; echo "⛔ $1"; echo ""; read -r -p "Enter — закрыть…" _; exit 1; }

# Node — единственное, без чего запускать нечего
command -v npm >/dev/null 2>&1 || fail "Нет node/npm — без него ШТАБ не запустить. Поставь: brew install node (или с nodejs.org)"

# питон нужен ТОЛЬКО для терминала и ИИ-выжимок. Нет его — не беда: ШТАБ откроется,
# демо-режим и обзор работают и без питона (в Настройках → Окружение видно, чего не хватает)
PY="$HOME/.shtab-pyenv"
if python3 -c 'import venv, ensurepip' >/dev/null 2>&1; then
  if [ ! -x "$PY/bin/python3" ]; then
    echo "→ создаю питон-окружение $PY …"
    python3 -m venv "$PY" || echo "⚠ venv не создался — терминал и выжимки будут недоступны."
  fi
  if [ -x "$PY/bin/pip" ]; then
    echo "→ проверяю зависимости сайдкара (aiohttp, ptyprocess)…"
    "$PY/bin/pip" install -q -r term/requirements.txt || echo "⚠ зависимости не встали — терминал и выжимки будут недоступны."
  fi
else
  echo "⚠ Рабочий python3 не найден (у Xcode бывает заглушка без venv/pip) — пропускаю."
  echo "  ШТАБ откроется, но без вкладки «Терминал» и ИИ-выжимок."
  echo "  Хочешь их: brew install python (или с python.org), потом запусти этот файл снова."
fi

# electron (node_modules не в git — ставится на каждой машине своя сборка)
if [ ! -d node_modules/electron ]; then
  echo "→ ставлю electron (npm install, первый раз пара минут)…"
  npm install
fi

# claude CLI — только предупреждение, кокпит работает и без терминалов
if [ ! -x "$HOME/.local/bin/claude" ] && ! command -v claude >/dev/null 2>&1; then
  echo "⚠ claude CLI не найден — вкладка «Терминал» не заработает (поставь/залогинь claude)."
fi

# приложение для дока — собрать, если ещё нет (дальше запускай ШТАБ из дока)
if [ ! -d "$HOME/Applications/ШТАБ.app" ] && [ -f "Собрать-ШТАБ-app.command" ]; then
  echo "→ собираю ШТАБ.app для дока…"
  bash "Собрать-ШТАБ-app.command" </dev/null || true
fi

echo "→ запускаю ШТАБ…"
npm start
