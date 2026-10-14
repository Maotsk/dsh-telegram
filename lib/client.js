// dsh-host-telegram — browser (client) half.
//
// One settings card, registered exactly the way the plugin manager consumes it:
//
//   plugins.item, summary view  → the one-line description in the plugins list
//   plugins.item, full view     → the entry page: every field, expanded
//
// `plugins.row.config` is deliberately NOT registered: the profile row id
// matches our key there too, and the manager renders that slot as well, which
// showed the whole form twice.
//
// Values live in the plugin's `telegram` settings namespace and travel through
// the plugin's own host route, so the token never comes back to the browser —
// the route only reports whether one is configured.
window.__ModuleLoader__.load({
  id: '@maotsk/dsh-host-telegram',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const module = { exports: {} }
    const exports = module.exports

    const ROUTE = '/dsh-host-telegram/config'
    const ROW_ID = 'telegram'
    const LOCALE_NS = 'dsh-host-telegram'

    const CARD_RU = {
      cardSub: 'Управление сессиями DSH из Telegram: список, привязка, промпты, живой стриминг',
      tokenLabel: 'Токен бота',
      tokenHintSet: 'Токен уже задан — оставьте пустым, чтобы не менять',
      tokenHintNew: 'Получите у @BotFather или задайте TELEGRAM_BOT_TOKEN',
      chatsLabel: 'Разрешённые чаты',
      chatsHint: 'Через запятую; пусто — бот отказывает всем',
      proxyLabel: 'HTTP-прокси',
      proxyHint: 'Только CONNECT, например http://user:pass@host:1080; пусто — напрямую',
      localeLabel: 'Язык интерфейса',
      keyboardLabel: 'Нижняя клавиатура',
      keyboardDismissible: 'Сворачиваемая (по умолчанию)',
      keyboardOff: 'Не показывать',
      keyboardPersistent: 'Закреплена всегда',
      save: 'Сохранить',
      saving: 'Сохранение…',
      saved: 'Сохранено — применится без перезапуска',
      loadFailed: 'Не удалось прочитать настройки: ',
      saveFailed: 'Ошибка: ',
    }

    async function call(method, body) {
      const res = await fetch(ROUTE, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status))
      return data.config
    }

    const styles = {
      card: { display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '13px' },
      summary: { fontSize: '12px', opacity: 0.75 },
      sub: { fontSize: '12px', opacity: 0.7, marginBottom: '2px' },
      label: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #666)' },
      input: {
        width: '100%', boxSizing: 'border-box', height: '32px', padding: '0 10px',
        borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2, #d0d0d0)',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)', font: 'inherit', fontSize: '13px',
      },
      save: {
        height: '32px', padding: '0 14px', borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, #d0d0d0)',
        background: 'var(--dsw-alias-bg-layer-2, #f5f5f5)', color: 'var(--dsw-alias-label-primary, inherit)',
        font: 'inherit', fontSize: '13px',
      },
    }

    const field = (title, hint, control) => h('div', { style: styles.label },
      h('span', null, title), control, hint ? h('span', { style: { opacity: 0.75 } }, hint) : null)

    function TelegramSettings(props) {
      const [state, setState] = React.useState(null)
      const [token, setToken] = React.useState('')
      const [chats, setChats] = React.useState('')
      const [proxy, setProxy] = React.useState('')
      const [locale, setLocale] = React.useState('ru')
      const [keyboard, setKeyboard] = React.useState('dismissible')
      const [status, setStatus] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        call('GET').then((config) => {
          if (!alive || !config) return
          setState(config)
          setChats((config.allowChatIds || []).join(', '))
          setProxy(config.proxy || '')
          setLocale(config.locale || 'ru')
          setKeyboard(config.keyboard || 'dismissible')
        }).catch((error) => {
          if (alive) setStatus(CARD_RU.loadFailed + error.message)
        })
        return () => { alive = false }
      }, [])

      const save = async () => {
        setBusy(true)
        setStatus('')
        try {
          const config = await call('PUT', {
            config: {
              botToken: token,
              allowChatIds: chats.split(/[^0-9-]+/).filter((part) => part !== '').map((part) => Number(part)),
              proxy,
              locale,
              keyboard,
            },
          })
          setState(config)
          setToken('')
          setStatus(CARD_RU.saved)
        } catch (error) {
          setStatus(CARD_RU.saveFailed + error.message)
        } finally {
          setBusy(false)
        }
      }

      // The list asks for the summary view: exactly the one-line description.
      if (props && props.view === 'summary') return h('span', { style: styles.summary }, CARD_RU.cardSub)

      return h('div', { style: styles.card },
        h('div', { style: styles.sub }, CARD_RU.cardSub),
        field(CARD_RU.tokenLabel,
          state && state.botTokenConfigured ? CARD_RU.tokenHintSet : CARD_RU.tokenHintNew,
          h('input', {
            style: styles.input, type: 'password', value: token,
            placeholder: state && state.botTokenConfigured ? '•••••• (задан)' : '123456:AA…',
            onChange: (event) => setToken(event.target.value),
          })),
        field(CARD_RU.chatsLabel, CARD_RU.chatsHint,
          h('input', { style: styles.input, value: chats, placeholder: '741585801', onChange: (event) => setChats(event.target.value) })),
        field(CARD_RU.proxyLabel, CARD_RU.proxyHint,
          h('input', { style: styles.input, value: proxy, placeholder: 'http://user:pass@host:1080', onChange: (event) => setProxy(event.target.value) })),
        field(CARD_RU.localeLabel, null,
          h('select', { style: styles.input, value: locale, onChange: (event) => setLocale(event.target.value) },
            h('option', { value: 'ru' }, 'Русский'),
            h('option', { value: 'zh' }, '中文'))),
        field(CARD_RU.keyboardLabel, null,
          h('select', { style: styles.input, value: keyboard, onChange: (event) => setKeyboard(event.target.value) },
            h('option', { value: 'dismissible' }, CARD_RU.keyboardDismissible),
            h('option', { value: 'off' }, CARD_RU.keyboardOff),
            h('option', { value: 'persistent' }, CARD_RU.keyboardPersistent))),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          h('button', {
            onClick: save, disabled: busy,
            style: Object.assign({}, styles.save, { cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }),
          }, busy ? CARD_RU.saving : CARD_RU.save),
          status ? h('span', { style: { fontSize: '12px', opacity: 0.8 } }, status) : null),
      )
    }

    function apply(ctx) {
      const locale = ctx && (ctx.get ? ctx.get('locale') : ctx.locale)
      if (locale && typeof locale.register === 'function') {
        try {
          locale.register(LOCALE_NS, 'ru', CARD_RU)
        } catch (error) {
          console.warn('[dsh-host-telegram] locale registration failed:', error && error.message)
        }
      }
      const slots = ctx && (ctx.get ? ctx.get('slots') : ctx.slots)
      if (!slots) return
      const render = (props) => h(TelegramSettings, Object.assign({}, props, { ctx }))
      const register = () => slots.register(
        { name: 'plugins.item', id: ROW_ID, label: () => 'Telegram', order: 60, locale: LOCALE_NS, inject: () => ({ ctx }) },
        render,
      )
      if (typeof slots.inject === 'function') {
        try {
          slots.inject('plugins.item', register)
          return
        } catch (error) {
          console.warn('[dsh-host-telegram] slot inject failed:', error && error.message)
        }
      }
      if (typeof slots.register === 'function') {
        try {
          register()
        } catch (error) {
          console.warn('[dsh-host-telegram] slot registration failed:', error && error.message)
        }
      }
    }

    module.exports = { apply, inject: ['slots', 'locale'] }
    return module.exports
  },
})
