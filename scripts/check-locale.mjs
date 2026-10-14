/**
 * Translation coverage check — no browser, no manual eyeballing.
 *
 * The fork keeps the upstream logic and translates at the output boundary, so a
 * missed phrase silently leaks the source language into a message. This script
 * extracts every string literal and template in `src/` that still carries the
 * source alphabet, runs each through `localize(text, 'ru')` (bundled on the fly
 * with esbuild) and fails if anything survives — including runtime-shaped
 * variants where `${…}` placeholders are already substituted, and a check that
 * localize is idempotent (the console edits messages in place).
 *
 * `src/locale-ru.ts` is the dictionary itself and is excluded on purpose.
 *
 * Usage: node scripts/check-locale.mjs
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const SOURCE_ALPHABET = /[\u4e00-\u9fff]/ // Simplified Chinese, the upstream literal language

// ── bundle the locale module so the check runs from a clean checkout ─────────
const workdir = mkdtempSync(join(tmpdir(), 'dsh-telegram-locale-'))
const bundle = join(workdir, 'locale.mjs')
await build({
  entryPoints: [resolve(root, 'src/locale-ru.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile: bundle,
  logLevel: 'silent',
})
const { localize } = await import(pathToFileURL(bundle).href)

// ── extract candidate literals from the sources ──────────────────────────────
const DICTIONARY = 'locale-ru.ts'
const stripComments = source =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')

/** Turn the raw literal body into the value the runtime sees (`\n` → newline). */
const unescapeLiteral = raw => raw
  .replace(/\\n/g, '\n')
  .replace(/\\t/g, '\t')
  .replace(/\\r/g, '\r')
  .replace(/\\'/g, "'")
  .replace(/\\"/g, '"')
  .replace(/\\`/g, '`')
  .replace(/\\\$/g, '$')
  .replace(/\\\\/g, '\\')

const literals = new Set()
for (const file of readdirSync(join(root, 'src'))) {
  if (!file.endsWith('.ts') || file === DICTIONARY) continue
  const code = stripComments(readFileSync(join(root, 'src', file), 'utf8'))
  for (const match of code.matchAll(/'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const value = unescapeLiteral(match[1] ?? match[2] ?? '')
    if (SOURCE_ALPHABET.test(value)) literals.add(value)
  }
}

const withPlaceholderValues = value => [
  value.replace(/\$\{[^}]*\}/g, '3'),
  value.replace(/\$\{[^}]*\}/g, 'X'),
]

const untranslated = [...literals].filter(value => SOURCE_ALPHABET.test(localize(value, 'ru')))
const runtimeUntranslated = [...literals]
  .flatMap(withPlaceholderValues)
  .filter(value => SOURCE_ALPHABET.test(value) && SOURCE_ALPHABET.test(localize(value, 'ru')))
const notIdempotent = [...literals].filter(value => localize(localize(value, 'ru'), 'ru') !== localize(value, 'ru'))

// ── report ───────────────────────────────────────────────────────────────────
console.log(`проверено строк: ${literals.size}`)
console.log(`вариантов с подставленными значениями: ${literals.size * 2}`)
if (untranslated.length > 0) console.error(`непереведённых: ${untranslated.length}\n- ${untranslated.slice(0, 20).join('\n- ')}`)
else console.log('непереведённых: 0')
if (runtimeUntranslated.length > 0) console.error(`непереведённых после подстановки: ${runtimeUntranslated.length}\n- ${runtimeUntranslated.slice(0, 20).join('\n- ')}`)
else console.log('непереведённых после подстановки: 0')
if (notIdempotent.length > 0) console.error(`неидемпотентных: ${notIdempotent.length}\n- ${notIdempotent.slice(0, 10).join('\n- ')}`)
else console.log('неидемпотентных: 0')

if (untranslated.length > 0 || runtimeUntranslated.length > 0 || notIdempotent.length > 0) {
  console.error('\nИТОГ: FAIL — добавьте недостающие пары в src/locale-ru.ts')
  process.exit(1)
}
console.log('\nИТОГ: ВСЁ ОК — весь интерфейс переводится, повторный перевод ничего не портит')
