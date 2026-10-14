# Форк для DSH 0.2.x

Это форк [Kevin66Z0/dsh-telegram](https://github.com/Kevin66Z0/dsh-telegram)
(`@deepseek-ai/dsh-host-telegram`), адаптированный под **DSH 0.2.x**
(проверено на 0.2.0-rc.2). Апстрим написан под поколение DSH 0.0.x, где хост
монтировал сервис `apiProxy` — в 0.2.x такого пакета и сервиса нет, поэтому
апстрим-версия падала при загрузке:

```
dsh: warning: 1 entry did not activate
telegram (@deepseek-ai/dsh-host-telegram): failed to import
```

## Что изменено

| Файл | Что сделано |
| --- | --- |
| `src/apiproxy-shim.ts` | новый. Локальные типы контракта `ApiProxy` (RPC-конверт `{rpcId, payload}` → `{rpcId, result}`, `SessionSummary`, `WorkspaceView`, `AgentPresetEntry`, каталог моделей) вместо отсутствующего пакета `@deepseek-ai/dsh-host-apiproxy`. Типы скопированы из контракта 0.0.1-rc.1 (MIT), только используемая часть. |
| `src/host-api.ts` | новый. Тот же `ApiProxy`, но поверх **in-process сервисов DSH 0.2.x** — тех же, которыми пользуется веб-интерфейс: `sessionController` (`list`, `page`, `create`, `prompt`, `cancel`, `fork`, `rename`, `modelCatalog`), `workspaceRegistry` / `workspaceController` (список, создание, архив), `agentDefaultModel` (глобальная модель), `agentPresets` + `agents` (пресеты), `settingsController` (прочие настройки). Плюс мост вопросов агента: `question/asked` и `question/decided` синтезируются из waterfall-события `user-questions/request`, ответ уходит либо в тот же waterfall (открытый вопрос), либо в `userQuestions.answer(agent, callId, …)` (просроченный вопрос). Реальная лента сессий (`ctx.on('session/event')`) прокидывается как есть. |
| `src/index.ts` | `inject` вместо `['apiProxy']` — `HOST_API_SERVICES`; API строится через `createHostApi(apiCtx)`; события консоли берутся из `api.events`; удалён `installSettingsSection` (в 0.2.x его нет — конфигурация читается из строки плагина в `cordis.patch.yml` профиля). |
| `src/console.ts`, `src/render.ts` | импорт типов переведён на локальный шим. |
| `package.json` | версия `0.1.0-rc.6`, убраны несуществующие зависимости (`dsh-host-apiproxy`, `dsh-settings`), добавлены `build`-скрипт и `esbuild` в devDependencies. |

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
         name: '@deepseek-ai/dsh-host-telegram'
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

## Отличия от апстрима

- **Нет страницы настроек в веб-интерфейсе** — в 0.2.x нет `installSettingsSection`;
  токен, белый список и прокси задаются строкой плагина в `cordis.patch.yml`.
- **Отмена вопроса** (`🚫`) в 0.2.x выражается «пропуском» — ответом с пустыми
  `selected`: отдельного `cancel` у сервиса вопросов нет.
- Вопрос доступен и в Telegram, и в веб-интерфейсе одновременно: слушатель
  вызывает `next()`, поэтому кто ответит первым — тот и выигрывает.
- `/status` не показывает строку «预设:», если проекция `agentPreset` пуста.

Лицензия апстрима (MIT) сохранена.
