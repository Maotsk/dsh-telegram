/**
 * Card self-check for the browser half (lib/client.js) — no browser needed.
 *
 * Loads the module in a stubbed environment exactly the way
 * `dsh-client-ui-plugin-manager` consumes it: `window.__ModuleLoader__` captures
 * the plugin spec, `react` and the cordis `slots` service are stubs, and the
 * registered component is rendered for both views:
 *
 *   summary  → one description line (what the plugins list shows)
 *   full     → the form (what the plugin page shows)
 *
 * Catches the two regressions this card is prone to: registering more than one
 * slot (the manager renders `plugins.row.config` as well, which duplicates the
 * form) and rendering the form inside the summary view.
 *
 * Usage: node scripts/check-client.mjs [path/to/client.js]
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const file = process.argv[2] ?? resolve(root, 'lib/client.js')
const source = readFileSync(file, 'utf8')

// ── environment stubs ────────────────────────────────────────────────────────
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec
    },
  },
}

const reactStub = {
  createElement(type, props, ...children) {
    return {
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false),
    }
  },
  useState(initial) {
    return [initial, () => {}]
  },
  useEffect() {},
}

const injectedSlots = []
const registered = []
const fakeCtx = {
  get(name) {
    if (name === 'slots') {
      return {
        inject(slotName, fn) {
          injectedSlots.push(slotName)
          fn()
        },
        register(definition, render) {
          registered.push({ definition, render })
        },
      }
    }
    if (name === 'locale') return { register() {} }
    return undefined
  },
}

// ── load the client half ─────────────────────────────────────────────────────
eval(source)
if (loaded === null) {
  console.error('FAIL: window.__ModuleLoader__.load was never called')
  process.exit(1)
}
const client = loaded.factory(spec => {
  if (spec === 'react') return reactStub
  throw new Error(`unexpected require: ${spec}`)
})
client.apply(fakeCtx)

// ── assertions ───────────────────────────────────────────────────────────────
const failures = []
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`ok   ${label}`)
    return
  }
  failures.push(`${label}${detail === '' ? '' : ` (${detail})`}`)
}

const collect = (node, out = { types: [], text: [] }, depth = 0) => {
  if (depth > 50 || node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.text.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out, depth + 1)
    return out
  }
  if (typeof node === 'object' && node.type !== undefined) {
    // Functional components are rendered here, exactly like React would.
    if (typeof node.type === 'function') {
      collect(node.type(node.props ?? {}), out, depth + 1)
      return out
    }
    if (typeof node.type === 'string') out.types.push(node.type)
    collect(node.children, out, depth + 1)
  }
  return out
}

check('exactly one slot registration', registered.length === 1, `got ${registered.length}`)
check('slot is plugins.item', injectedSlots.length === 1 && injectedSlots[0] === 'plugins.item', injectedSlots.join(', '))

if (registered.length === 1) {
  const { definition, render } = registered[0]
  check('registration carries the row id', definition.id === 'telegram', String(definition.id))
  check('registration carries a title', typeof definition.label === 'function' && definition.label() === 'Telegram')

  const summary = collect(render({ view: 'summary' }))
  const controls = summary.types.filter(type => ['input', 'select', 'button', 'textarea'].includes(type))
  check('summary view has no controls', controls.length === 0, summary.types.join(','))
  check('summary view carries the description', summary.text.join(' ').includes('Управление сессиями DSH'))

  const full = collect(render({}))
  const inputs = full.types.filter(type => type === 'input').length
  const selects = full.types.filter(type => type === 'select').length
  const saves = full.text.filter(text => text === 'Сохранить').length
  check('full view has three inputs', inputs === 3, `inputs=${inputs}`)
  check('full view has two selects', selects === 2, `selects=${selects}`)
  check('full view has one save button', saves === 1, `save=${saves}`)
  const text = full.text.join(' | ')
  for (const title of ['Токен бота', 'Разрешённые чаты', 'HTTP-прокси', 'Язык интерфейса', 'Нижняя клавиатура']) {
    check(`full view carries the «${title}» label`, text.includes(title))
  }
}

if (failures.length > 0) {
  console.error(`\nИТОГ: FAIL — ${failures.length} problem(s):\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('\nИТОГ: ВСЁ ОК — карточка регистрируется один раз, в списке показывает описание, на странице — все поля')
