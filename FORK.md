# Форк для DSH 0.2.x

Это форк [Kevin66Z0/dsh-telegram](https://github.com/Kevin66Z0/dsh-telegram),
адаптированный под **DSH 0.2.x** и публикуемый как **`@maotsk/dsh-host-telegram`**
(в апстриме тот же плагин лежит под именем `@deepseek-ai/dsh-host-telegram`).
(проверено на 0.2.0-rc.2). Апстрим написан под поколение DSH 0.0.x, где хост
монтировал сервис `apiProxy` — в 0.2.x такого пакета и сервиса нет, поэтому
апстрим-версия падала при загрузке:

```
dsh: warning: 1 entry did not activate
telegram (@deepseek-ai/dsh-host-telegram): failed to import   # имя апстрима, до переименования форка
```

## Что изменено

| Файл | Что сделано |
| --- | --- |
| `src/apiproxy-shim.ts` | новый. Локальные типы контракта `ApiProxy` (RPC-конверт `{rpcId, payload}` → `{rpcId, result}`, `SessionSummary`, `WorkspaceView`, `AgentPresetEntry`, каталог моделей) вместо отсутствующего пакета `@deepseek-ai/dsh-host-apiproxy`. Типы скопированы из контракта 0.0.1-rc.1 (MIT), только используемая часть. |
| `src/host-api.ts` | новый. Тот же `ApiProxy`, но поверх **in-process сервисов DSH 0.2.x** — тех же, которыми пользуется веб-интерфейс: `sessionController` (`list`, `page`, `create`, `prompt`, `cancel`, `fork`, `rename`, `modelCatalog`), `workspaceRegistry` / `workspaceController` (список, создание, архив), `agentDefaultModel` (глобальная модель), `agentPresets` + `agents` (пресеты), `settingsController` (прочие настройки). Плюс мост вопросов агента: `question/asked` и `question/decided` синтезируются из waterfall-события `user-questions/request`, ответ уходит либо в тот же waterfall (открытый вопрос), либо в `userQuestions.answer(agent, callId, …)` (просроченный вопрос). Реальная лента сессий (`ctx.on('session/event')`) прокидывается как есть. |
| `src/index.ts` | `inject` вместо `['apiProxy']` — `HOST_API_SERVICES`; API строится через `createHostApi(apiCtx)`; события консоли берутся из `api.events`; удалён `installSettingsSection` (в 0.2.x его нет — конфигурация читается из строки плагина в `cordis.patch.yml` профиля). |
| `src/console.ts`, `src/render.ts` | импорт типов переведён на локальный шим. |
| `src/inbound-media.ts` | новый (0.2.1). Помощники приёма картинок: выбор крупнейшей версии фото, фильтр MIME под attachment-store DSH, лимит Telegram, image-часть промпта. |
| `package.json` | версия `0.1.0-rc.7`, убраны несуществующие зависимости (`dsh-host-apiproxy`, `dsh-settings`), добавлены `build`-скрипт и `esbuild` в devDependencies. |

`lib/index.js` собран из этих исходников: `npm run build`
(`esbuild --bundle --packages=external`).

## Установка в профиль DSH 0.2.x

1. Добавить зависимость и бандл в профиль (например `web`):

   ```bash
   dsh plugin --profile web add github:Maotsk/dsh-telegram#fix/dsh-0.2-inprocess-port
   ```

   либо через веб-интерфейс: Настройки → Плагины → добавить пакет из GitHub.

2. Прописать строку конфига в `$DSH_HOME/profiles/web/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: telegram
         name: '@maotsk/dsh-host-telegram'
         config:
           botToken: '123456:AA...'
           allowChatIds: [123456789]
           proxy: 'http://user:password@proxy-host:port'
   ```

   `allowChatIds` пустой = бот отказывает всем. `proxy` — только HTTP CONNECT
   (`undici.ProxyAgent`; SOCKS5 не поддерживается) и необязателен, если
   `api.telegram.org` доступен напрямую.

3. Перезапустить DSH. В логе должны появиться строки
   `telegram: configuring bot for N allowed chat ids` и
   `telegram: bot @<name> listening`.

## Что проверено на живых данных

Пробником на копии реального хранилища (отдельный DSH_HOME, бот выключен) проверено:
список сессий с заголовками (25 шт.), 6 проектов с количеством сессий, каталог моделей,
Пресеты: `standard` (по умолчанию), `ptc`, `minimal`, `cordis`. История берёт курсор
из проекций (`asOfSeq`), окно ограничивается числом сообщений (20 сообщений ≈ 122 события);
если проекций нет — резервный путь через `sessionController.inspect` с хвостом по сообщениям.
Выбор пресета работает и на «холодной» сессии — через `sessionController.resolveAgent`.
Коды ошибок хоста приводятся к старому формату, который матчит консоль:
`workspace-invalid-path`, `session-not-found`, `gateway-bad-request`, `agent-preset-locked`.

## Карточка настроек в веб-интерфейсе

Страница «Настройки → Плагины» в 0.2.x сама форму не рисует: карточка плагина
показывает только «Включён / Подключён». Поэтому у форка есть **клиентская
половина** — `lib/client.js` (в `package.json`: `exports["./client"]` и блок
`dsh.client`, сборка не нужна, файл написан руками). Она регистрируется в слотах
DSH (`settings.plugin.item`, `plugins.item`, `plugins.row.config`) и рисует
русскую карточку в правой панели — там же, где была карточка `messenger-gateway`.

| Поле | Что делает |
| --- | --- |
| Токен бота | Секрет: показывается как «задан», пустое поле при сохранении НЕ затирает текущий токен |
| `allowChatIds` | список разрешённых chat id (пустой — бот отказывает всем) |
| `proxy` | HTTP-прокси для Telegram (только CONNECT); пусто — `ALL_PROXY`/`HTTPS_PROXY` или прямое подключение |
| `locale` | язык интерфейса: `ru` (по умолчанию) или `zh` |
| `keyboard` | нижняя клавиатура: `dismissible` (по умолчанию — сворачивается кнопкой Telegram), `off` (не показывать совсем), `persistent` (закреплена) |
| `photoOnlyMode` | фото без подписи: `prompt` (по умолчанию — ждать вопрос пользователя), `run` (сразу отправить агенту с пометкой) |

Браузер не может дотянуться до cordis-сервисов, поэтому карточка ходит в
собственный маршрут плагина:

```
GET  /dsh-host-telegram/config   — текущие значения (токен только флагом «задан»)
PUT  /dsh-host-telegram/config   — проверка доверенного запроса, затем settings.update()
```

Все шесть полей помечены `.volatile()`, поэтому значения приходят в плагин
«живыми» handle'ами (`Volatile<T>` из `@deepseek-ai/cosmokit`, читаются через
`isVolatile()`/`get()` — без разворачивания получается `undefined`). `apply()`
заново собирает эффективный конфиг и пересобирает сессию бота по событиям
`settings/document-updated`, `loader/volatile-update`, `app-boot/config-reload`
и по сверке раз в 5 секунд — то есть правки применяются без перезапуска DSH.

## Фото и картинки-документы

Апстрим обрабатывал только `message:text`, поэтому фотография молча пропадала.
В форке добавлены обработчики `message:photo` и `message:document`:

- `src/inbound-media.ts` (новый) — чистые помощники: выбор самой крупной версии
  фото, фильтр MIME (`image/png`, `image/jpeg`, `image/webp`, `image/gif` —
  ровно те, что принимает attachment-store DSH), лимит Telegram 20 МБ и
  преобразование байтов в image-часть промпта (`base64`).
- `src/index.ts` — `api.getFile` резолвит файл через клиент бота (то есть через
  прокси), байты скачиваются из `api.telegram.org/file/bot<token>/<file_path>`
  тем же транспортом; при ошибке в чат уходит «не удалось скачать изображение»,
  а текст промпта всё равно отправляется.
- Промпт собирается как `[image, …, { text }]` — тот же shape, что отправляет
  веб-форма; `sessionController.prompt` сам превращает base64 в durable-ссылку.
  Раньше хост-адаптер (`src/host-api.ts`) отфильтровывал всё, кроме `text`.
- Режим `photoOnlyMode` (по умолчанию `prompt`, как в `dsh-messenger-gateway`):
  фото без подписи не запускает агента, а копится в `pendingImages` чата; бот
  отвечает подсказкой (одна на альбом — апдейты одного альбома приходят
  по отдельности, поэтому ответ отложен на 700 мс) и отправляет картинки вместе
  со следующим текстом. Команда (`/…`) картинки не «съедает» — они ждут вопроса.
  Режим `run` отправляет фото сразу, вместо вопроса ставя пометку
  `[Пользователь прислал фото]`. Подпись к фото — это вопрос, она запускает
  агента немедленно в любом режиме.

## Русский интерфейс

Апстрим написан с китайскими строками и без i18n. В форке перевод сделан на
границе вывода: `src/locale-ru.ts` содержит словарь (`RUSSIAN_PHRASES`, 249 пар)
и числовые правила (`RUSSIAN_PATTERNS`, 9 правил — возраст и счётные слова с
согласованием через `plural()`), а `localize()`/`localizeRows()` применяются в
транспорте перед отправкой в Telegram. Поэтому:

- `callback_data` никогда не переводится — нажатия кнопок работают как раньше;
- ответные клавиатуры несут ASCII-команды (`/attach 1 · …`), маршрутизация не ломается;
- `locale: zh` возвращает исходное поведение.

Проверка покрытия: `node .dsh_tmp/locale-check.mjs` (в этом репозитории скрипт
не хранится) — 150 строк с иероглифами, 0 непереведённых.

## Подписи кнопок

Апстрим резал названия проектов/пресетов до 6–8 символов («📁 worksp…»). В форке
подпись заполняется до лимита Telegram (64 символа) — `TELEGRAM_BUTTON_MAX = 60`
и `fitButtonText()`: имя выводится целиком, обрезается только если физически не
влезает в кнопку. Строки списков (`SESSION_TITLE_MAX`) расширены с 48 до 80.

## Отличия от апстрима

- **Отмена вопроса** (`🚫`) в 0.2.x выражается «пропуском» — ответом с пустыми
  `selected`: отдельного `cancel` у сервиса вопросов нет.
- Вопрос доступен и в Telegram, и в веб-интерфейсе одновременно: слушатель
  вызывает `next()`, поэтому кто ответит первым — тот и выигрывает.
- `/status` не показывает строку «预设:», если проекция `agentPreset` пуста.

Лицензия апстрима (MIT) сохранена.
