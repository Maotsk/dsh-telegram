// dsh-host-telegram — browser (client) half.
//
// Collapsible settings section for Настройки → Плагины: the list keeps a compact
// «Telegram» row with a status line, and the fields (token, allowed chats,
// proxy, language, keyboard) unfold on click. Values live in the plugin's
// `telegram` settings namespace and travel through the plugin's own host route,
// so the token never comes back to the browser — the route only reports whether
// one is configured.
window.__ModuleLoader__.load({
  id: '@deepseek-ai/dsh-host-telegram',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const module = { exports: {} }
    const exports = module.exports

    const ROUTE = '/dsh-host-telegram/config'
    const ROW_ID = 'telegram'
    const PKG = '@deepseek-ai/dsh-host-telegram'
    const ROW_CONFIG_KEY = PKG + '#' + ROW_ID

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
      section: { display: 'flex', flexDirection: 'column', gap: '10px' },
      header: {
        display: 'flex', alignItems: 'flex-start', gap: '8px', cursor: 'pointer',
        userSelect: 'none', padding: '2px 0',
      },
      chevron: { width: '12px', fontSize: '11px', lineHeight: '18px', opacity: 0.6 },
      title: { fontSize: '14px', color: 'var(--dsw-alias-label-primary, inherit)' },
      hint: { fontSize: '12px', opacity: 0.7, marginTop: '2px' },
      body: {
        display: 'flex', flexDirection: 'column', gap: '12px',
        padding: '4px 0 2px 20px', fontSize: '13px',
      },
      label: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #666)' },
      input: {
        width: '100%', boxSizing: 'border-box', height: '32px', padding: '0 10px',
        borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2, #d0d0d0)',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)', font: 'inherit', fontSize: '13px',
      },
      save: {
        height: '32px', padding: '0 14px', borderRadius: '8px', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2, #d0d0d0)',
        background: 'var(--dsw-alias-bg-layer-2, #f5f5f5)', color: 'var(--dsw-alias-label-primary, inherit)',
        font: 'inherit', fontSize: '13px',
      },
    }

    const field = (title, hint, control) => h('div', { style: styles.label },
      h('span', null, title), control, hint ? h('span', { style: { opacity: 0.75 } }, hint) : null)

    function TelegramSettings(props) {
      const [open, setOpen] = React.useState(false)
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
          if (alive) setStatus('Не удалось прочитать настройки: ' + error.message)
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
          setStatus('Сохранено — применится без перезапуска')
        } catch (error) {
          setStatus('Ошибка: ' + error.message)
        } finally {
          setBusy(false)
        }
      }

      const summary = state === null
        ? 'загрузка…'
        : `чатов: ${state.allowChatIds.length} · токен ${state.botTokenConfigured ? 'задан' : 'не задан'} · ${state.locale === 'zh' ? '中文' : 'русский'}`

      return h('div', { style: styles.section },
        h('div', { style: styles.header, onClick: () => setOpen(!open), role: 'button', tabIndex: 0 },
          h('span', { style: styles.chevron }, open ? '▾' : '▸'),
          h('div', null,
            h('div', { style: styles.title }, 'Telegram'),
            h('div', { style: styles.hint }, open ? 'Работает с теми же сессиями и проектами, что веб-интерфейс' : summary))),
        open ? h('div', { style: styles.body },
          field('Токен бота',
            state && state.botTokenConfigured ? 'Токен уже задан — оставьте пустым, чтобы не менять' : 'Получите у @BotFather или задайте TELEGRAM_BOT_TOKEN',
            h('input', {
              style: styles.input, type: 'password', value: token,
              placeholder: state && state.botTokenConfigured ? '•••••• (задан)' : '123456:AA…',
              onChange: (event) => setToken(event.target.value),
            })),
          field('Разрешённые чаты', 'Через запятую; пусто — бот отказывает всем',
            h('input', { style: styles.input, value: chats, placeholder: '741585801', onChange: (event) => setChats(event.target.value) })),
          field('HTTP-прокси', 'Только CONNECT, например http://user:pass@host:1080; пусто — напрямую',
            h('input', { style: styles.input, value: proxy, placeholder: 'http://user:pass@host:1080', onChange: (event) => setProxy(event.target.value) })),
          field('Язык интерфейса', null,
            h('select', { style: styles.input, value: locale, onChange: (event) => setLocale(event.target.value) },
              h('option', { value: 'ru' }, 'Русский'),
              h('option', { value: 'zh' }, '中文'))),
          field('Нижняя клавиатура', null,
            h('select', { style: styles.input, value: keyboard, onChange: (event) => setKeyboard(event.target.value) },
              h('option', { value: 'dismissible' }, 'Сворачиваемая (по умолчанию)'),
              h('option', { value: 'off' }, 'Не показывать'),
              h('option', { value: 'persistent' }, 'Закреплена всегда'))),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            h('button', { onClick: save, disabled: busy, style: Object.assign({}, styles.save, { opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }) },
              busy ? 'Сохранение…' : 'Сохранить'),
            status ? h('span', { style: { fontSize: '12px', opacity: 0.8 } }, status) : null)) : null,
      )
    }

    function apply(ctx) {
      const slots = ctx && (ctx.get ? ctx.get('slots') : ctx.slots)
      if (!slots) return
      const render = (props) => h(TelegramSettings, Object.assign({}, props, { ctx }))
      const register = (slotName, definition) => {
        const mount = () => slots.register(Object.assign({ name: slotName, inject: () => ({ ctx }) }, definition), render)
        if (typeof slots.inject === 'function') {
          try {
            slots.inject(slotName, mount)
            return
          } catch (error) {
            console.warn('[dsh-host-telegram] slot inject failed:', error && error.message)
          }
        }
        if (typeof slots.register === 'function') {
          try {
            mount()
          } catch (error) {
            console.warn('[dsh-host-telegram] slot registration failed:', error && error.message)
          }
        }
      }
      register('settings.plugin.item', { key: ROW_ID, label: () => 'Telegram', order: 60 })
      register('plugins.item', { id: ROW_ID, label: () => 'Telegram', order: 60 })
      register('plugins.row.config', { key: ROW_CONFIG_KEY })
    }

    module.exports = { apply, inject: ['slots'] }
    return module.exports
  },
})
