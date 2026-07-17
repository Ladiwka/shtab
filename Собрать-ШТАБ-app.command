#!/bin/bash
# Собрать ~/Applications/ШТАБ.app — настоящее мак-приложение для дока.
# Идемпотентно: можно перезапускать (после апгрейда electron — обязательно).
set -e
cd "$(dirname "$0")"
PROJ="$(pwd)"
APP="$HOME/Applications/ШТАБ.app"
SRC="$PROJ/node_modules/electron/dist/Electron.app"

[ -d "$SRC" ] || { echo "⛔ Нет node_modules/electron — сначала запусти Поднять-на-маке.command"; read -r; exit 1; }

echo "→ собираю $APP …"
rm -rf "$APP"
mkdir -p "$HOME/Applications"
cp -R "$SRC" "$APP"

# имя и идентичность (имя в доке/меню берётся ТОЛЬКО из Info.plist — в рантайме не меняется)
PB=/usr/libexec/PlistBuddy
$PB -c "Set :CFBundleName ШТАБ" "$APP/Contents/Info.plist"
$PB -c "Set :CFBundleDisplayName ШТАБ" "$APP/Contents/Info.plist" 2>/dev/null \
  || $PB -c "Add :CFBundleDisplayName string ШТАБ" "$APP/Contents/Info.plist"
$PB -c "Set :CFBundleIdentifier ru.bogdan.shtab" "$APP/Contents/Info.plist"

# иконка
cp "$PROJ/assets/icon.icns" "$APP/Contents/Resources/electron.icns"

# stub: Electron сам грузит Contents/Resources/app; он require-ит НАСТОЯЩИЙ main.js проекта,
# так что код и node_modules остаются в git-папке — обновление кода = просто git pull
mkdir -p "$APP/Contents/Resources/app"
cat > "$APP/Contents/Resources/app/package.json" <<EOF
{ "name": "shtab", "version": "1.0.0", "main": "main.js" }
EOF
cat > "$APP/Contents/Resources/app/main.js" <<EOF
require('$PROJ/main.js');
EOF

# ОБЯЗАТЕЛЬНО: ad-hoc переподпись — правка Info.plist рвёт подпись,
# на Apple Silicon неподписанный бинарь не запустится
codesign --force --deep --sign - "$APP"

# сбросить кэш иконок дока
touch "$APP"; killall Dock 2>/dev/null || true

echo ""
echo "✓ Готово: $APP"
echo "  1) Открой Finder → Applications (домашняя) → перетащи ШТАБ в док."
echo "  2) Запускай из дока. Cmd+W прячет окно, Cmd+Q выходит."
echo "  3) Автозапуск при входе включится сам при первом запуске из ШТАБ.app."
read -r -p "Enter — закрыть…" _
