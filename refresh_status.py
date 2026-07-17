"""
ШТАБ · кокпит — обновлятор статус-карточки проекта.

Читает журнал проекта (ЖУРНАЛ/ВИДЕНИЕ/README/CLAUDE), просит headless `claude -p`
сделать ПРОСТУЮ выжимку простым языком по схеме и пишет data/status/<id>.json.
Запускается приложением, когда журнал поменялся с прошлой выжимки → карточка
подтягивается сама. Никаких инструментов claude не нужно (журнал даём в промпт),
поэтому подтверждений/обхода прав нет.

Аргументы: <project_id> <project_dir> <out_json>
Окружение: SHTAB_CLAUDE — путь к claude.exe
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

SCHEMA = '''Ты делаешь ПРОСТУЮ статус-карточку проекта для его владельца — НЕ программиста.
Верни СТРОГО один JSON без пояснений и без ```-ограды, по схеме:
{
  "pulse": "одна спокойная строка ПРОСТЫМИ словами: где остановились и как идёт",
  "health": "ok" | "slow" | "stuck",
  "done": ["что уже сделали, простым языком, до 4"],
  "next": ["что дальше / что осталось, до 3"],
  "waiting": ["чего ждём / блокер, 0-2, если нет — []"],
  "changes": ["последние изменения человеческим языком: 'добавили агента', 'новая ссылка', 'поправили баги', до 6"],
  "updated": "ГГГГ-ММ-ДД (дата последней записи журнала) или пусто"
}
ЯЗЫК: как занятому владельцу, не разработчику. БЕЗ жаргона (не «отрефакторил фронтенд», а
«переделал вид — стало удобнее»). Коротко, спокойно, по-русски, вся карточка 4-6 строк смысла.
БЕЗ процентов/тегов/ETA. ВАЖНО: самые СВЕЖИЕ записи могут быть и в конце, и в начале журнала —
определи по ДАТАМ, где свежее, и опиши именно ТЕКУЩЕЕ состояние, а не прошлое.'''

SOURCES = ["ЖУРНАЛ.md", "ВИДЕНИЕ.md", "README.md", "readme.md", "CLAUDE.md"]


def pick_source(pdir: Path):
    for name in SOURCES:
        f = pdir / name
        if f.exists() and f.is_file():
            return f
    return None


def git_source(pdir: Path):
    """Без журнала/README — выжимку делаем из git-истории (она есть у любого репо).
    Возвращает (текст, mtime-метка) или None."""
    head = pdir / ".git" / "logs" / "HEAD"
    if not head.exists():
        return None
    try:
        log = subprocess.run(
            ["git", "-C", str(pdir), "log", "-40", "--date=format:%Y-%m-%d", "--format=%ad · %s"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20,
        ).stdout.strip()
        stat = subprocess.run(
            ["git", "-C", str(pdir), "diff", "--stat", "HEAD~10..HEAD"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20,
        ).stdout.strip()
    except Exception:
        return None
    if not log:
        return None
    text = ("ИСТОРИЯ КОММИТОВ (свежие сверху — это и есть последние события проекта):\n"
            + log + ("\n\nЧТО МЕНЯЛОСЬ (файлы за последние 10 коммитов):\n" + stat[-2000:] if stat else ""))
    return text, head.stat().st_mtime


def main():
    if len(sys.argv) < 4:
        print("usage: refresh_status.py <id> <dir> <out>", file=sys.stderr)
        sys.exit(2)
    pid, pdir_s, out_s = sys.argv[1], sys.argv[2], sys.argv[3]
    pdir, out = Path(pdir_s), Path(out_s)
    # папки data/status может ещё не быть (свежая установка) → без этого запись падает
    # FileNotFoundError и карточка навсегда висит на «готовлю выжимку…»
    out.parent.mkdir(parents=True, exist_ok=True)
    claude = os.environ.get("SHTAB_CLAUDE", "claude")

    src = pick_source(pdir)
    src_mtime = None
    if src is not None:
        text = src.read_text(encoding="utf-8", errors="replace")
        # даём ОБА конца файла: у кого-то журнал растёт вниз, у кого-то новое пишут сверху
        if len(text) > 17000:
            recent = text[:5000] + "\n\n[…середина журнала пропущена…]\n\n" + text[-12000:]
        else:
            recent = text
        src_name = src.name
        # метку берём как МАКСИМАЛЬНЫЙ mtime среди всех источников — main.js сравнивает так же.
        # Иначе (штамп по одному приоритетному файлу) карточка с более свежим README/CLAUDE
        # считалась бы вечно устаревшей и гоняла claude при каждом открытии.
        mts = [(pdir / n).stat().st_mtime for n in SOURCES if (pdir / n).is_file()]
        src_mtime = max(mts) if mts else src.stat().st_mtime
        # ЖУРНАЛ МОГ ОТСТАТЬ ОТ РАБОТЫ: коммиты есть, а записи о них нет (журнал двухнедельной
        # давности при вчерашних коммитах — обычное дело). Тогда одного журнала мало: карточка
        # обновилась бы тем же старым текстом. Добавляем коммиты ПОСЛЕ последней записи — скажет правду.
        head = pdir / ".git" / "logs" / "HEAD"
        if head.exists():
            head_m = head.stat().st_mtime
            if head_m > src_mtime + 60:      # git реально новее журнала
                g = git_source(pdir)
                if g is not None:
                    recent += ("\n\n[журнал отстал от работы — вот коммиты, которых в нём ещё нет]\n"
                               + g[0][:6000])
                    src_name += " + git-история"
            # метка ОБЯЗАНА учитывать git так же, как main.js (newestSource берёт максимум),
            # иначе stale=true навсегда и claude гоняется при каждом открытии карточки
            src_mtime = max(src_mtime, head_m)
    else:
        g = git_source(pdir)
        if g is None:
            # ни журнала, ни git — тихая минимальная карточка
            data = {"pulse": "Проект тихий — записей мало.", "health": "slow",
                    "done": [], "next": [], "waiting": [], "changes": [],
                    "updated": "", "_src_mtime": 0}
            out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            print("minimal")
            return
        recent, src_mtime = g
        src_name = "git-история"

    prompt = (SCHEMA + f"\n\nВот журнал проекта «{pid}» (источник: {src_name}):\n\n"
              + recent + "\n\nВерни ТОЛЬКО JSON.")

    try:
        p = subprocess.run([claude, "-p"], input=prompt, capture_output=True,
                           text=True, encoding="utf-8", errors="replace", timeout=200)
    except Exception as e:
        print(f"claude err: {e}", file=sys.stderr)
        sys.exit(1)

    raw = p.stdout or ""
    m = re.search(r"\{.*\}", raw, re.S)
    if not m:
        print("no json in output", file=sys.stderr)
        sys.exit(1)
    try:
        data = json.loads(m.group(0))
    except Exception as e:
        print(f"json parse err: {e}", file=sys.stderr)
        sys.exit(1)

    # стягиваем к схеме + метка исходника (чтобы знать, свежо ли)
    data.setdefault("waiting", [])
    data.setdefault("changes", [])
    data["_src_mtime"] = src_mtime
    # атомарная запись: temp + rename. Иначе прерывание питона посреди write_text оставило бы
    # половину json, и карточка при следующем открытии сломалась бы на парсинге.
    tmp = out.with_suffix(out.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, out)
    print("ok:", data.get("pulse", "")[:60])


if __name__ == "__main__":
    main()
