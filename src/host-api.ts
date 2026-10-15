/**
 * In-process host API for DSH 0.2.x.
 *
 * The upstream plugin talked to the DSH 0.0.x `apiProxy` service. This module
 * provides the same `ApiProxy` shape (see ./apiproxy-shim.ts) on top of the
 * cordis services DSH 0.2.x actually mounts — the very services the Web UI
 * drives, so Telegram sees the same workspaces and sessions:
 *
 *   sessions.list/history/create/prompt/cancel/rename/fork -> ctx.sessionController
 *   llm.models                                              -> ctx.sessionController.modelCatalog()
 *   workspace.list/create/archiveSession                    -> ctx.workspaceRegistry / workspaceController
 *   settings.update (agent-default-model)                   -> ctx.agentDefaultModel.saveSelection()
 *   agentPresets.list/select                                -> ctx.agentPresets (+ ctx.agents.get)
 *   respond (ask_user_question answers)                     -> user-questions waterfall / ctx.userQuestions
 *
 * `events` mirrors the console's event surface: real `session/event` frames
 * plus synthesised `question/asked` / `question/decided` frames, because DSH
 * 0.2.x models agent questions as a projection rather than session events.
 * @module @maotsk/dsh-host-telegram/host-api
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  AgentPresetEntry, ApiProxy, ClientResponse, HistoryEntry, ModelCatalogFailure, ModelProviderGroup, PromptContentPart, RpcId,
  RpcReceipt, RpcResponse, RpcResult, SessionSummary, WorkspaceId, WorkspaceView,
} from './apiproxy-shim.ts'

/** Services the host API needs before it can drive sessions at all. */
export const HOST_API_SERVICES = ['sessionController', 'workspaceRegistry'] as const

/** Global default model settings namespace (the profile's `agent-default-model` row). */
const AGENT_DEFAULT_MODEL_NS = 'agent-default-model'

/** Abort signal for the mandatory-signal controller calls. */
const liveSignal = (): AbortSignal => new AbortController().signal

// ── Host side shapes (loose structural views of the 0.2.x services) ─────────

/** One `session.list` row as DSH 0.2.x returns it. */
interface HostSessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: string
  origin?: 'subagent'
  cwd?: string
  agentAvailable?: boolean
  projections?: { kind?: string; asOfSeq: number; values: Record<string, unknown> }
}

/** One workspace entity from `ctx.workspaceRegistry` (uses `id`, not `workspaceId`). */
interface HostWorkspace {
  id?: string
  workspaceId?: string
  path: string
  title: string
  sessionIds?: readonly string[]
  createdAt?: string | number | Date
  updatedAt?: string | number | Date
}

/** One raw session log event (0.2.x wire shape). */
interface HostSessionEvent {
  type?: string
  seq?: number
  time?: number
  data?: unknown
}

interface SessionControllerLike {
  list(request: { cursor?: string }, signal: AbortSignal): Promise<{ items: readonly HostSessionSummary[] }>
  page(request: {
    address: { kind: 'session'; sessionId: SessionId }
    throughSeq: number
    beforeSeq?: number
    maxMessages?: number
  }, signal: AbortSignal): Promise<{ records: readonly { type: 'event'; event: HostSessionEvent }[]; hasMore: boolean }>
  /** Host-only log read; unlike `page` it needs no cursor. */
  inspect(sessionId: string, signal?: AbortSignal): Promise<{ events?: readonly HostSessionEvent[] } | undefined>
  /** Resume a cold session and hand back its live agent. */
  resolveAgent(sessionId: string): Promise<{ agent?: unknown; error?: { message?: string } } | undefined>
  create(request: { workspaceId?: string; cwd?: string; agentPreset?: string }): Promise<{ sessionId: string }>
  prompt(request: {
    requestId: string
    sessionId: string
    mode: 'queue' | 'steer'
    content: readonly PromptContentPart[]
    clientTimeZone?: string
  }, signal: AbortSignal): Promise<{ accepted: true }>
  cancel(request: { sessionId: string }): { accepted: true }
  fork(request: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string }>
  rename(request: { sessionId: string; title: string }): Promise<{ title: string; seq: number }>
  projections(request: { sessionId: string }, signal: AbortSignal): Promise<{ asOfSeq: number; values: Record<string, unknown> } | null>
  modelCatalog(): Promise<{ groups: ModelProviderGroup[]; failures: ModelCatalogFailure[] }>
}

interface WorkspaceRegistryLike {
  list(): readonly HostWorkspace[]
  get(id: string): HostWorkspace | undefined
  create(path: string, title?: string): unknown
  readonly archivedSessionIds: readonly string[]
  archiveSession(sessionId: string, options?: { stopActivity?: boolean }): unknown
}

interface WorkspaceControllerLike {
  create(request: { path: string }): Promise<{ workspace: HostWorkspace; created: boolean }>
  archiveSession(request: { sessionId: string; stopActivity?: boolean }): Promise<{ archivedSessionIds: readonly string[] }>
}

interface AgentPresetsLike {
  list(): Promise<readonly { id: string; name?: string; description?: string; broken?: string }[]>
  select(agent: unknown, agentPreset: string): Promise<string>
  readonly defaultId?: string
}

interface AgentsLike {
  get(sessionId: string): unknown
}

interface AgentDefaultModelLike {
  saveSelection(selection: { provider: string; model: string; reasoningEffort?: string }): unknown
}

interface SettingsControllerLike {
  update(ns: string, patch: Record<string, unknown>, expectedRevision?: number): Promise<unknown>
}

/** One `user-questions/request` waterfall payload field set we rely on. */
interface UserQuestionRequestEvent {
  questions?: readonly { id: string; question: string; header?: string; detail?: string; multiSelect?: boolean }[]
  agent?: { session?: { id?: string } }
  signal?: AbortSignal
  wait?: { callId?: string; timed?: boolean }
}

interface UserQuestionsLike {
  answer(agent: unknown, callId: string, answer: { answers: readonly { id: string; selected: string[]; custom?: string }[] }): boolean
}

/** Console event sink: the shape `TelegramConsole` subscribes with. */
type ConsoleEventSink = (session: { id: string }, event: unknown) => void

/** The host API plus the console's event surface. */
export interface HostApi extends ApiProxy {
  readonly events: { on(name: 'session/event', handler: ConsoleEventSink): () => void }
}

/** One question batch waiting for a Telegram tap. */
interface PendingQuestion {
  sessionId: string
  callId: string
  agent: unknown
  questions: readonly { id: string }[]
  resolve: (answer: { answers: { id: string; selected: string[]; custom?: string }[] }) => void
  settle: (outcome: 'answered' | 'cancelled') => void
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Fold a host exception into the RPC failure branch the console formats. */
function failureOf(error: unknown): { code: string; message: string; details: unknown } {
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown } | undefined
  const raw = typeof candidate?.code === 'string' && candidate.code !== ''
    ? candidate.code
    : 'gateway/internal'
  return {
    // The console matches legacy codes such as `agent-preset-locked`, while
    // 0.2.x spells the same condition `agent-preset/locked`.
    code: raw.replace(/\//g, '-'),
    message: candidate?.message === undefined ? String(error) : String(candidate.message),
    details: candidate?.details ?? {},
  }
}

/**
 * Tail of a raw log covering at most `maxMessages` user/assistant messages —
 * the message-aligned window `page` would have returned without a cursor.
 * @param events - the whole log, oldest first.
 * @param maxMessages - message budget; non-positive returns everything.
 * @returns the tail slice, oldest first.
 */
function tailByMessages(events: readonly HostSessionEvent[], maxMessages: number): readonly HostSessionEvent[] {
  if (maxMessages <= 0 || events.length === 0) return events
  let seen = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]?.type
    if (type === 'user/message' || type === 'assistant/message') {
      seen += 1
      if (seen > maxMessages) return events.slice(index + 1)
    }
  }
  return events
}

/** Map one host session row onto the ApiProxy summary shape. */
function mapSummary(row: HostSessionSummary): SessionSummary {
  const title = row.projections?.values?.title
  const agentPreset = row.projections?.values?.agentPreset
  return {
    sessionId: row.sessionId as SessionId,
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : Date.now(),
    running: Boolean(row.running),
    blank: Boolean(row.blank),
    ...(row.parentSessionId === undefined ? {} : { parentSessionId: row.parentSessionId as SessionId }),
    ...(row.origin === undefined ? {} : { origin: row.origin }),
    ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
    ...(typeof agentPreset === 'string' ? { agentPreset } : {}),
    ...(row.projections === undefined
      ? {}
      : { projections: { asOfSeq: row.projections.asOfSeq, values: { ...row.projections.values, ...(title === undefined ? {} : { title }) } } }),
  }
}

/** Map one host workspace onto the ApiProxy view shape. */
function mapWorkspace(workspace: HostWorkspace): WorkspaceView {
  const id = workspace.workspaceId ?? workspace.id ?? ''
  return {
    workspaceId: id as WorkspaceId,
    path: workspace.path,
    title: workspace.title,
    sessionIds: [...(workspace.sessionIds ?? [])] as SessionId[],
    createdAt: workspace.createdAt === undefined ? '' : String(workspace.createdAt),
    updatedAt: workspace.updatedAt === undefined ? '' : String(workspace.updatedAt),
  }
}

// ── The host API ───────────────────────────────────────────────────────────

/**
 * Build the ApiProxy surface over the mounted 0.2.x services.
 * @param ctx - plugin context inside the host process.
 * @returns the host API and its console event surface.
 */
export function createHostApi(ctx: Context): HostApi {
  const get = <T>(name: string): T | undefined => {
    try {
      return (ctx as unknown as { get(key: string): T | undefined }).get(name)
    } catch {
      return undefined
    }
  }
  const required = <T>(name: string): T => {
    const service = get<T>(name)
    if (service === undefined) throw new Error(`dsh-messenger-telegram: service "${name}" is not mounted`)
    return service
  }

  const sessions = (): SessionControllerLike => required<SessionControllerLike>('sessionController')
  const registry = (): WorkspaceRegistryLike | undefined => get<WorkspaceRegistryLike>('workspaceRegistry')

  const ok = <T>(rpcId: RpcId, value: T): RpcResponse<T> => ({ rpcId, result: { ok: true, value } })
  const fail = <T>(rpcId: RpcId, error: unknown): RpcResponse<T> => ({
    rpcId,
    result: { ok: false, error: failureOf(error) } as RpcResult<T>,
  })

  // ── Question bridge ──────────────────────────────────────────────────────
  const sinks = new Set<ConsoleEventSink>()
  const pending = new Map<string, PendingQuestion>()

  const emit = (sessionId: string, event: unknown): void => {
    for (const sink of [...sinks]) {
      try {
        sink({ id: sessionId }, event)
      } catch (error) {
        ctx.logger?.warn?.(`telegram: question bridge sink failed: ${String(error)}`)
      }
    }
  }

  const questionEvent = (type: 'question/asked' | 'question/decided', callId: string, data: Record<string, unknown>): unknown => ({
    type,
    seq: 0,
    time: Date.now(),
    data: { id: callId, ...data },
  })

  const skipAnswer = (questions: readonly { id: string }[]): { answers: { id: string; selected: string[] }[] } => ({
    answers: questions.map(question => ({ id: question.id, selected: [] })),
  })

  const settlePending = (sessionId: string, callId: string, outcome: 'answered' | 'cancelled'): void => {
    pending.delete(callId)
    emit(sessionId, questionEvent('question/decided', callId, { outcome }))
  }

  // The waterfall lets the browser answer the same question; a rejection on the
  // downstream path (no other answerer mounted) must not fail the ask.
  const downstreamNever = new Promise<never>(() => {})
  ctx.on('user-questions/request', (request: UserQuestionRequestEvent, next: () => Promise<unknown>) => {
    const sessionId = request?.agent?.session?.id
    const callId = request?.wait?.callId
    const questions = request?.questions
    if (sessionId === undefined || callId === undefined || questions === undefined || questions.length === 0) {
      return next()
    }
    let settle: (outcome: 'answered' | 'cancelled') => void = () => {}
    const answer = new Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }>((resolve) => {
      settle = (outcome: 'answered' | 'cancelled') => {
        pending.delete(callId)
        emit(sessionId, questionEvent('question/decided', callId, { outcome }))
        resolve(skipAnswer(questions))
      }
      pending.set(callId, {
        sessionId,
        callId,
        agent: request.agent,
        questions,
        resolve: (batch) => {
          pending.delete(callId)
          emit(sessionId, questionEvent('question/decided', callId, { outcome: 'answered' }))
          resolve(batch)
        },
        settle,
      })
    })
    emit(sessionId, questionEvent('question/asked', callId, { questions }))
    if (request.signal !== undefined) {
      request.signal.addEventListener('abort', () => {
        if (pending.has(callId)) settle('cancelled')
      }, { once: true })
    }
    let downstream: Promise<unknown>
    try {
      downstream = Promise.resolve(next()).catch(() => downstreamNever)
    } catch {
      downstream = downstreamNever
    }
    return Promise.race([answer, downstream]).then((resolved) => {
      // The browser answered first: drop the Telegram keyboard state.
      if (pending.has(callId)) settle('answered')
      return resolved
    })
  })

  const answerQuestion = (sessionId: string, callId: string, answer: { answers: { id: string; selected: string[]; custom?: string }[] }): boolean => {
    const waiting = pending.get(callId)
    if (waiting !== undefined) {
      waiting.resolve(answer)
      return true
    }
    // No live waterfall (ask already timed out): the continued-question path.
    const agent = get<AgentsLike>('agents')?.get(sessionId)
    const userQuestions = get<UserQuestionsLike>('userQuestions')
    if (agent === undefined || userQuestions === undefined) return false
    try {
      return userQuestions.answer(agent, callId, answer)
    } catch (error) {
      ctx.logger?.warn?.(`telegram: question answer failed: ${String(error)}`)
      return false
    }
  }

  const cancelQuestion = (sessionId: string, callId: string): boolean => {
    const waiting = pending.get(callId)
    if (waiting !== undefined) {
      waiting.settle('cancelled')
      return true
    }
    const agent = get<AgentsLike>('agents')?.get(sessionId)
    const userQuestions = get<UserQuestionsLike>('userQuestions')
    if (agent === undefined || userQuestions === undefined) return false
    try {
      // 0.2.x has no cancel: the documented skip answer stands in for it.
      return userQuestions.answer(agent, callId, skipAnswer([{ id: '' }]))
    } catch {
      return false
    }
  }

  // ── The ApiProxy surface ─────────────────────────────────────────────────
  const api: ApiProxy = {
    sessions: {
      async list(request) {
        const { rpcId } = request
        try {
          const { items } = await sessions().list({}, liveSignal())
          return ok(rpcId, { items: items.map(mapSummary) })
        } catch (error) {
          return fail(rpcId, error)
        }
      },
      async history(request) {
        const { rpcId, payload } = request
        try {
          const controller = sessions()
          // `page` is cursor-addressed: the projections baseline carries the log
          // cursor, and `inspect` (host-only, cursor-free) is the fallback.
          let cursor: number | undefined
          let projections: { values: Record<string, unknown> } | undefined
          try {
            const baseline = await controller.projections({ sessionId: payload.sessionId }, liveSignal())
            if (baseline !== null) {
              cursor = baseline.asOfSeq
              projections = { values: baseline.values }
            }
          } catch { /* projections are optional for todos */ }
          let inspected: readonly HostSessionEvent[] | undefined
          if (cursor === undefined) {
            try {
              inspected = (await controller.inspect(payload.sessionId, liveSignal()))?.events
              const last = inspected?.[inspected.length - 1]
              if (typeof last?.seq === 'number') cursor = last.seq
            } catch { /* fall through to the raw tail */ }
          }
          if (cursor !== undefined) {
            try {
              const page = await controller.page({
                address: { kind: 'session', sessionId: payload.sessionId },
                throughSeq: cursor,
                ...(payload.maxMessages === undefined ? {} : { maxMessages: payload.maxMessages }),
                ...(payload.beforeSeq === undefined ? {} : { beforeSeq: payload.beforeSeq }),
              }, liveSignal())
              const events: HistoryEntry[] = page.records
                .filter(record => record?.type === 'event')
                .map(record => ({ event: record.event as HistoryEntry['event'] }))
              if (events.length > 0) {
                return ok(rpcId, { events, hasMore: page.hasMore, ...(projections === undefined ? {} : { projections }) })
              }
            } catch { /* fall back to the raw log tail below */ }
          }
          if (inspected === undefined) {
            try {
              inspected = (await controller.inspect(payload.sessionId, liveSignal()))?.events
            } catch { inspected = undefined }
          }
          const tail = tailByMessages(inspected ?? [], payload.maxMessages ?? 20)
          return ok(rpcId, {
            events: tail.map(event => ({ event: event as HistoryEntry['event'] })),
            hasMore: (inspected?.length ?? 0) > tail.length,
            ...(projections === undefined ? {} : { projections }),
          })
        } catch (error) {
          return fail(rpcId, error)
        }
      },
      async create(request) {
        const { rpcId, payload } = request
        try {
          const created = await sessions().create({
            ...(payload.workspaceId === undefined ? {} : { workspaceId: String(payload.workspaceId) }),
            ...(payload.cwd === undefined ? {} : { cwd: payload.cwd }),
            ...(payload.agentPreset === undefined ? {} : { agentPreset: payload.agentPreset }),
          })
          return ok(rpcId, { sessionId: created.sessionId as SessionId })
        } catch (error) {
          return fail(rpcId, error)
        }
      },
      async prompt(request) {
        const { rpcId, payload } = request
        try {
          await sessions().prompt({
            requestId: `session-request-${randomUUID()}`,
            sessionId: String(payload.sessionId),
            mode: payload.mode,
            // Text and image parts travel as submitted; the controller promotes
            // the base64 image bytes into durable attachment references.
            content: payload.content,
          }, liveSignal())
          return ok(rpcId, { accepted: true as const })
        } catch (error) {
          return fail(rpcId, error)
        }
      },
      async cancel(request) {
        const { rpcId, payload } = request
        try {
          sessions().cancel({ sessionId: String(payload.sessionId) })
          return ok(rpcId, { accepted: true as const })
        } catch (error) {
          return fail(rpcId, error)
        }
      },
      async rename(request) {
        const { rpcId, payload } = request
        try {
          const renamed = await sessions().rename({ sessionId: String(payload.sessionId), title: payload.title })
          return ok(rpcId, { title: renamed.title, seq: renamed.seq })
        } catch (error) {
          return fail(rpcId, error)
        }
      },
      async fork(request) {
        const { rpcId, payload } = request
        try {
          const forked = await sessions().fork({
            sessionId: String(payload.sessionId),
            ...(payload.atSeq === undefined ? {} : { atSeq: payload.atSeq }),
          })
          return ok(rpcId, { sessionId: forked.sessionId as SessionId })
        } catch (error) {
          return fail(rpcId, error)
        }
      },
    },
    workspace: {
      async list(request) {
        const { rpcId } = request
        try {
          const store = registry()
          if (store === undefined) throw new Error('dsh-messenger-telegram: workspace registry is not mounted')
          return ok(rpcId, {
            items: store.list().map(mapWorkspace),
            archivedSessionIds: [...store.archivedSessionIds] as SessionId[],
          })
        } catch (error) {
          return fail(rpcId, error)
        }
      },
      async create(request) {
        const { rpcId, payload } = request
        try {
          const controller = get<WorkspaceControllerLike>('workspaceController')
          if (controller !== undefined) {
            const created = await controller.create({ path: payload.path })
            return ok(rpcId, { workspace: mapWorkspace(created.workspace), created: created.created })
          }
          const store = registry()
          if (store === undefined) throw new Error('dsh-messenger-telegram: workspace registry is not mounted')
          await store.create(payload.path)
          const workspace = store.list().find(item => item.path === payload.path)
          if (workspace === undefined) throw new Error(`dsh-messenger-telegram: workspace "${payload.path}" not found after create`)
          return ok(rpcId, { workspace: mapWorkspace(workspace), created: true })
        } catch (error) {
          return fail(rpcId, error)
        }
      },
      async archiveSession(request) {
        const { rpcId, payload } = request
        try {
          const controller = get<WorkspaceControllerLike>('workspaceController')
          if (controller !== undefined) {
            const archived = await controller.archiveSession({ sessionId: String(payload.sessionId), stopActivity: true })
            return ok(rpcId, { archivedSessionIds: [...archived.archivedSessionIds] as SessionId[] })
          }
          const store = registry()
          if (store === undefined) throw new Error('dsh-messenger-telegram: workspace registry is not mounted')
          await store.archiveSession(String(payload.sessionId), { stopActivity: true })
          return ok(rpcId, { archivedSessionIds: [...store.archivedSessionIds] as SessionId[] })
        } catch (error) {
          return fail(rpcId, error)
        }
      },
    },
    llm: {
      async models(request) {
        const { rpcId } = request
        try {
          const catalog = await sessions().modelCatalog()
          return ok(rpcId, { groups: [...catalog.groups], failures: [...catalog.failures] })
        } catch (error) {
          return fail(rpcId, error)
        }
      },
    },
    settings: {
      async update(request) {
        const { rpcId, payload } = request
        try {
          if (payload.ns === AGENT_DEFAULT_MODEL_NS) {
            const patch = payload.patch as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
            const agentDefaultModel = get<AgentDefaultModelLike>('agentDefaultModel')
            if (agentDefaultModel === undefined) throw new Error('dsh-messenger-telegram: agentDefaultModel is not mounted')
            await agentDefaultModel.saveSelection({
              provider: String(patch.provider ?? ''),
              model: String(patch.model ?? ''),
              ...(typeof patch.reasoningEffort === 'string' ? { reasoningEffort: patch.reasoningEffort } : {}),
            })
            return ok(rpcId, { ns: payload.ns })
          }
          const settings = get<SettingsControllerLike>('settingsController')
          if (settings === undefined) throw new Error('dsh-messenger-telegram: settingsController is not mounted')
          return ok(rpcId, await settings.update(payload.ns, payload.patch as Record<string, unknown>, payload.expectedRevision))
        } catch (error) {
          return fail(rpcId, error)
        }
      },
    },
    agentPresets: {
      async list(request) {
        const { rpcId } = request
        try {
          const presets = get<AgentPresetsLike>('agentPresets')
          if (presets === undefined) throw new Error('dsh-messenger-telegram: agentPresets is not mounted')
          const rows = await presets.list()
          const defaultId = presets.defaultId
          const entries: AgentPresetEntry[] = rows.map(row => ({
            id: row.id,
            trust: 'system',
            isDefault: defaultId === undefined ? false : row.id === defaultId,
            ...(row.name === undefined ? {} : { name: row.name }),
            ...(row.description === undefined ? {} : { description: row.description }),
            ...(row.broken === undefined ? {} : { reason: row.broken }),
          }))
          return ok(rpcId, { presets: entries, authorable: false, hasDocument: false })
        } catch (error) {
          return fail(rpcId, error)
        }
      },
      async select(request) {
        const { rpcId, payload } = request
        try {
          const presets = get<AgentPresetsLike>('agentPresets')
          if (presets === undefined) throw new Error('dsh-messenger-telegram: agentPresets is not mounted')
          const sessionId = String(payload.sessionId)
          let agent = get<AgentsLike>('agents')?.get(sessionId)
          if (agent === undefined) {
            // A cold session has no live agent yet: resuming it is what the Web
            // UI does before it recomposes the preset.
            const resolved = await sessions().resolveAgent(sessionId)
            if (resolved?.agent === undefined) {
              throw new Error(resolved?.error?.message ?? `dsh-messenger-telegram: session "${sessionId}" has no live agent`)
            }
            agent = resolved.agent
          }
          const selected = await presets.select(agent, payload.agentPreset)
          return ok(rpcId, { agentPreset: selected })
        } catch (error) {
          return fail(rpcId, error)
        }
      },
    },
    async respond(message: ClientResponse): Promise<RpcReceipt> {
      const callId = String(message.rpcId)
      const sessionId = message.result.ok ? String(message.result.value.sessionId) : ''
      if (message.result.ok) {
        const accepted = answerQuestion(sessionId, callId, message.result.value.answer as { answers: { id: string; selected: string[]; custom?: string }[] })
        return accepted ? { accepted: true } : { accepted: false, reason: 'not-pending' }
      }
      const cancelled = cancelQuestion(sessionId, callId)
      return cancelled ? { accepted: true } : { accepted: false, reason: 'not-pending' }
    },
  }

  const events: HostApi['events'] = {
    on(name, handler) {
      if (name !== 'session/event') return () => {}
      sinks.add(handler)
      const stopHost = ctx.on('session/event', (session: { id?: string }, event: unknown) => {
        try {
          handler({ id: String(session?.id ?? '') }, event)
        } catch (error) {
          ctx.logger?.warn?.(`telegram: event push failed: ${String(error)}`)
        }
      })
      return () => {
        sinks.delete(handler)
        if (typeof stopHost === 'function') stopHost()
      }
    },
  }

  return Object.assign(api, { events })
}
