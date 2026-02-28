# One-Click Coding Agent

Полностью локальный AI-агент для кодинга. Один клик — и у вас автономный ассистент, который читает, пишет и редактирует код, запускает команды, ищет по проекту. Без облака, без API-ключей, без подписок.

**Модель:** [Qwen3.5-35B-A3B](https://huggingface.co/unsloth/Qwen3.5-35B-A3B-GGUF) (MoE, 35B параметров, 3B активных) — квантизация UD-Q4_K_XL, ~19 ГБ.

**Inference:** [llama.cpp](https://github.com/ggml-org/llama.cpp) — предсобранные бинарники скачиваются автоматически.

---

## Возможности

- **Автоматическая настройка** — при первом запуске скачивает llama.cpp и модель, определяет GPU/CPU/RAM, запускает сервер с оптимальными параметрами
- **IDE-интерфейс** — файловое дерево, редактор кода с подсветкой синтаксиса, табы, чат с агентом
- **Автономный агент** — итеративный цикл: explore → edit → verify, до 30 шагов
- **Инструменты агента** — чтение/запись/редактирование файлов, поиск по коду, выполнение команд, управление директориями
- **Безопасность** — подтверждение опасных операций (write, edit, delete, execute), блокировка деструктивных команд
- **Multi-GPU** — автоматический `--tensor-split` для систем с несколькими видеокартами
- **Кроссплатформенность** — Linux (AppImage, deb, rpm, tar.gz), macOS (dmg, zip), Windows (NSIS installer, portable)
- **Resizable панели** — ширина сайдбара и чата настраивается перетаскиванием

## Системные требования

| Компонент | Минимум | Рекомендуется |
|-----------|---------|---------------|
| RAM | 16 ГБ | 32+ ГБ |
| GPU VRAM | — (работает на CPU) | 24+ ГБ (NVIDIA/AMD/Apple Silicon) |
| Диск | 25 ГБ | 40 ГБ |
| ОС | Linux x64, macOS 12+, Windows 10+ | Ubuntu 22.04+, macOS 14+, Windows 11 |

GPU значительно ускоряет inference. Поддерживаются:
- **NVIDIA** — CUDA (через предсобранный бинарник с Vulkan fallback на Linux)
- **AMD** — Vulkan
- **Apple Silicon** — Metal
- **CPU-only** — работает, но медленно

---

## Быстрый старт (из исходников)

```bash
git clone https://github.com/user/one-click-coding-agent.git
cd one-click-coding-agent
npm install
npm run dev
```

При первом запуске нажмите **«Автонастройка»** — приложение автоматически:

1. Определит ваше оборудование (GPU, VRAM, CPU, RAM)
2. Скачает подходящий бинарник llama-server (~30–200 МБ)
3. Скачает модель с HuggingFace (~19 ГБ, с поддержкой докачки)
4. Запустит inference-сервер с оптимальными параметрами

---

## Сборка бинарников

### Предварительные требования

```bash
node >= 18
npm >= 9
```

### Linux — AppImage + deb + rpm + tar.gz

```bash
npm run package:linux
```

Результат в `release/`:
```
One-Click Coding Agent-0.1.0.AppImage      # Универсальный, работает везде
one-click-coding-agent_0.1.0_amd64.deb     # Debian/Ubuntu
one-click-coding-agent-0.1.0.x86_64.rpm    # Fedora/RHEL
one-click-coding-agent-0.1.0.tar.gz        # Архив
```

AppImage — рекомендуемый формат. Запуск:
```bash
chmod +x "One-Click Coding Agent-0.1.0.AppImage"
./"One-Click Coding Agent-0.1.0.AppImage"
```

> **Примечание:** для ARM64 (Raspberry Pi 5, Ampere и т.д.) бинарники также собираются автоматически.

### macOS — DMG + ZIP

```bash
npm run package:mac
```

Результат:
```
One-Click Coding Agent-0.1.0.dmg           # Disk image с drag-to-Applications
One-Click Coding Agent-0.1.0-mac.zip       # ZIP-архив
```

Собирается для **x64** (Intel) и **arm64** (Apple Silicon) одновременно.

> **Примечание:** для подписи и нотаризации (Gatekeeper) нужен Apple Developer Certificate. Без него пользователям придётся разрешить запуск в System Settings → Privacy & Security.

### Windows — NSIS Installer + Portable

```bash
npm run package:win
```

Результат:
```
One-Click Coding Agent Setup 0.1.0.exe     # Установщик (NSIS)
"One-Click Coding Agent 0.1.0.exe"         # Portable (без установки)
```

### Все платформы сразу

```bash
npm run package:all
```

> **Важно:** кросс-компиляция имеет ограничения. macOS DMG можно собрать только на macOS. Linux AppImage — на Linux. Windows NSIS — на Linux/Windows. Для полного набора используйте CI (см. ниже).

---

## CI/CD (GitHub Actions)

Пример workflow для автоматической сборки на всех платформах:

```yaml
name: Build & Release
on:
  push:
    tags: ['v*']

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: ubuntu-22.04
            cmd: npm run package:linux
          - os: macos-14
            cmd: npm run package:mac
          - os: windows-latest
            cmd: npm run package:win
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: ${{ matrix.cmd }}
      - uses: actions/upload-artifact@v4
        with:
          name: release-${{ matrix.os }}
          path: release/*
```

---

## Архитектура

```
one-click-coding-agent/
├── electron/                   Electron main process
│   ├── main.ts                 Точка входа, IPC-хэндлеры, окно
│   ├── preload.ts              contextBridge (renderer ↔ main)
│   ├── resources.ts            Детекция GPU/CPU/RAM, выбор бинарника
│   ├── model-manager.ts        Скачивание модели (resume + retry)
│   ├── server-manager.ts       Управление llama-server (скачивание, запуск, health)
│   ├── agent.ts                Ядро агента (tool-calling loop, context pruning)
│   ├── tools.ts                Инструменты (файлы, shell, поиск, sandbox)
│   └── types.ts                Общие TypeScript-типы
├── src/                        React renderer
│   ├── App.tsx                 Корневой layout с resizable панелями
│   ├── components/
│   │   ├── Chat.tsx            Чат-интерфейс
│   │   ├── MessageBubble.tsx   Сообщения (markdown + code highlighting)
│   │   ├── ToolCallBlock.tsx   Блоки вызовов инструментов
│   │   ├── ThinkingBlock.tsx   Блок размышлений (<think>)
│   │   ├── CodeEditor.tsx      Редактор кода с подсветкой
│   │   ├── EditorTabs.tsx      Табы открытых файлов
│   │   ├── Sidebar.tsx         Файловое дерево проекта
│   │   ├── SetupWizard.tsx     Визард первоначальной настройки
│   │   └── StatusBar.tsx       Статус-бар
│   └── hooks/
│       ├── useAgent.ts         IPC с агентом, управление сообщениями
│       ├── useEditor.ts        Управление открытыми файлами/табами
│       └── useResizable.ts     Drag-resize для панелей
├── build/icons/                Иконки приложения
├── electron-builder.yml        Конфигурация сборки бинарников
├── vite.config.ts              Vite + Electron + Tailwind
└── package.json
```

## Инструменты агента

| Инструмент | Описание |
|------------|----------|
| `read_file` | Чтение файла с номерами строк, поддержка offset/limit |
| `write_file` | Создание новых файлов |
| `edit_file` | Точечное редактирование (exact string match) |
| `delete_file` | Удаление файла |
| `create_directory` | Создание директории |
| `list_directory` | Дерево файлов с настраиваемой глубиной |
| `find_files` | Поиск по имени (glob) или содержимому (grep) |
| `execute_command` | Выполнение shell-команд (с подтверждением) |

Все операции ограничены рабочей директорией проекта (sandbox). Деструктивные команды (`rm -rf /`, `chmod 777 /`, и т.д.) блокируются.

## Стек технологий

- **Electron 34** — кроссплатформенный десктоп
- **React 19** + **TypeScript 5** — UI
- **Tailwind CSS 4** — стилизация
- **Vite 6** — сборка
- **llama.cpp** — LLM inference (предсобранные бинарники)
- **highlight.js** — подсветка синтаксиса
- **react-markdown** — рендеринг markdown в чате
- **electron-builder** — пакетирование (AppImage/deb/rpm/dmg/nsis)

## Лицензия

[Apache 2.0](LICENSE)
