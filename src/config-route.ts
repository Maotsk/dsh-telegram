/**
 * HTTP surface of the settings card.
 *
 * The browser card (lib/client.js) lives in the right-hand panel of the Web UI
 * and cannot reach the cordis services directly, so the plugin exposes two
 * routes on the host web server:
 *
 *   GET  /dsh-host-telegram/config  → current values (the token only as a flag)
 *   PUT  /dsh-host-telegram/config  → merge a patch into the `telegram` settings
 *
 * The token never travels back to the browser: `describe({redactSecrets:true})`
 * hides it on the server side and this route only reports whether it is set, so
 * an empty field on save keeps the running token.
 *
 * @module @deepseek-ai/dsh-host-telegram/config-route
 */
import type { Context } from '@deepseek-ai/cordis'

/** The subset of the plugin configuration the card edits. */
export interface EditableConfig {
  botToken: string
  allowChatIds: number[]
  proxy: string
  locale: string
  keyboard: string
}

/** What the card receives: no secret material, only its configured state. */
interface PublicConfig {
  botTokenConfigured: boolean
  allowChatIds: number[]
  proxy: string
  locale: string
  keyboard: string
}

/** The route path the card calls. */
export const CONFIG_ROUTE = '/dsh-host-telegram/config'

/** Settings namespace the plugin registers with the settings service. */
const SETTINGS_NS = 'telegram'

const isLoopback = (address: string): boolean =>
  address === '::1' || address === 'localhost' || address.startsWith('127.') || address.startsWith('::ffff:127.')

/**
 * Whether a request may change plugin settings: same-origin browser traffic from
 * the loopback interface, never a cross-site request.
 * @param request - the incoming HTTP request.
 * @returns true when the request is trusted.
 */
function isTrustedRequest(request: {
  socket?: { remoteAddress?: string }
  headers?: Record<string, string | string[] | undefined>
}): boolean {
  const host = String(request?.headers?.host ?? '')
  if (host === '') return false
  if (String(request?.headers?.['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return false
  const remote = request?.socket?.remoteAddress
  if (remote !== undefined && !isLoopback(remote)) return false
  const origin = request?.headers?.origin
  if (typeof origin === 'string' && origin !== '') {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  return true
}

/** Write one JSON response. */
function writeJson(response: { writeHead: (status: number, headers: Record<string, string>) => void, end: (body: string) => void }, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(payload)
}

/** Read a JSON request body with a size cap. */
async function readJson(request: AsyncIterable<Uint8Array>, limit: number): Promise<unknown> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Project the live configuration for the browser (never the token itself). */
function publicConfig(config: EditableConfig): PublicConfig {
  return {
    botTokenConfigured: String(config.botToken ?? '').trim() !== '',
    allowChatIds: Array.isArray(config.allowChatIds) ? config.allowChatIds : [],
    proxy: String(config.proxy ?? ''),
    locale: config.locale === 'zh' ? 'zh' : 'ru',
    keyboard: ['off', 'persistent'].includes(config.keyboard) ? config.keyboard : 'dismissible',
  }
}

/** Normalise the card's patch into the settings document shape. */
function patchOf(body: unknown): Record<string, unknown> {
  const input = (body ?? {}) as Record<string, unknown>
  const source = (input.config ?? input) as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  if (Array.isArray(source.allowChatIds)) {
    patch.allowChatIds = source.allowChatIds
      .map(value => Number(value))
      .filter(value => Number.isFinite(value))
  }
  if (typeof source.proxy === 'string') patch.proxy = source.proxy.trim()
  if (typeof source.locale === 'string') patch.locale = source.locale === 'zh' ? 'zh' : 'ru'
  if (typeof source.keyboard === 'string') {
    patch.keyboard = ['off', 'persistent'].includes(source.keyboard) ? source.keyboard : 'dismissible'
  }
  // An empty token keeps the configured one; only a typed value overwrites it.
  if (typeof source.botToken === 'string' && source.botToken.trim() !== '') patch.botToken = source.botToken.trim()
  return patch
}

/**
 * Install the settings-card routes on the host web server.
 * @param ctx - plugin context.
 * @param read - read the live configuration.
 */
export function registerConfigRoute(ctx: Context, read: () => EditableConfig): void {
  ctx.inject(['webServer'], (webCtx) => {
    const holder = webCtx as unknown as { get?: (key: string) => unknown, webServer?: unknown }
    const webServer = (holder.get?.('webServer') ?? holder.webServer) as
      | { register?: (route: unknown) => unknown }
      | undefined
    if (typeof webServer?.register !== 'function') return
    webCtx.effect(() => webServer.register?.({
      kind: 'exact',
      path: CONFIG_ROUTE,
      handler: async (request: any, response: any) => {
        if (request.method === 'GET') {
          writeJson(response, 200, { ok: true, config: publicConfig(read()) })
          return
        }
        if (request.method !== 'PUT' && request.method !== 'POST') {
          writeJson(response, 405, { ok: false, error: 'GET or PUT only' })
          return
        }
        if (!isTrustedRequest(request)) {
          writeJson(response, 403, { ok: false, error: 'forbidden' })
          return
        }
        let patch: Record<string, unknown>
        try {
          patch = patchOf(await readJson(request, 1_048_576))
        } catch (error) {
          writeJson(response, 400, { ok: false, error: String((error as Error)?.message ?? error) })
          return
        }
        if (Object.keys(patch).length === 0) {
          writeJson(response, 200, { ok: true, config: publicConfig(read()) })
          return
        }
        try {
          const settings = ctx.get?.('settings') as { update?: (ns: string, patch: unknown) => Promise<unknown> } | undefined
          if (typeof settings?.update !== 'function') throw new Error('settings service is not mounted')
          await settings.update(SETTINGS_NS, patch)
          writeJson(response, 200, { ok: true, config: publicConfig(read()) })
        } catch (error) {
          writeJson(response, 409, { ok: false, error: String((error as Error)?.message ?? error) })
        }
      },
    }), 'telegram.config-route')
  })
}
