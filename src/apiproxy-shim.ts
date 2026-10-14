/**
 * Local stand-in for the types of `@deepseek-ai/dsh-host-apiproxy`.
 *
 * The upstream plugin was written against the DSH 0.0.x generation, where the
 * host mounted an `apiProxy` service carrying this RPC contract. DSH 0.2.x does
 * not ship that package or service at all (it moved to `dsh-api-gateway` plus
 * the generated typert controllers), so this fork declares the types it still
 * needs locally and implements them in-process in `./host-api.ts`.
 *
 * Type declarations are copied from the `@deepseek-ai/dsh-host-apiproxy`
 * 0.0.1-rc.1 contract (MIT) — only the parts this plugin consumes.
 */
import type { SessionId, SessionEvent, TodoItem } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'

/**
 * Message correlation id: the initiator mints it on a request; a response
 * echoes the matching request's rpcId and never mints a new one.
 */
export type RpcId = string & { readonly __rpcIdBrand?: unique symbol }

/**
 * Brands a string as RpcId (same precedent as `SessionId()`).
 * @param id - Raw id string.
 * @returns The same string, branded (compile-time cast, zero runtime cost).
 */
export function RpcId(id: string): RpcId {
  return id as RpcId
}

/** Failure branch shared by every RPC result. */
export interface RpcError {
  code: string
  message: string
  details?: unknown
}

/** Result of one RPC call. */
export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RpcError }

/** Signature-layer narrow form, request side. */
export interface RpcRequest<P> {
  rpcId: RpcId
  payload: P
}

/** Signature-layer narrow form, response side: rpcId always echoes the request. */
export interface RpcResponse<T> {
  rpcId: RpcId
  result: RpcResult<T>
}

/** Delivery receipt for a client-response frame. */
export interface RpcReceipt {
  accepted: boolean
  reason?: string
}

/** Response frame answering a server-request (client-response). */
export interface ClientResponse {
  type: 'client-response'
  rpcId: RpcId
  result: RpcResult<{
    sessionId: SessionId
    answer: AskUserQuestionAnswer
  }>
}

/** Workspace identity brand. */
export type WorkspaceId = string & { readonly __workspaceIdBrand?: unique symbol }

/** Whole current value per registered session-projection key. */
export interface SessionProjectionsBlock {
  /** Seq of the last event the values reflect; -1 for an empty log. */
  asOfSeq: number
  values: { todos?: TodoItem[] | null } & Record<string, unknown>
}

/** One row of the session list. */
export interface SessionSummary {
  sessionId: SessionId
  /** Last activity, in epoch milliseconds. */
  updatedAt: number
  /** Status of the attached agent; always false for cold (unattached) sessions. */
  running: boolean
  /** Derived conversation-not-started bit. */
  blank: boolean
  /** fork/spawn lineage; absent for root sessions. */
  parentSessionId?: SessionId
  /** Coarse durable origin used by navigation surfaces. */
  origin?: 'subagent'
  /** Session working directory; absent when unrecorded. */
  cwd?: string
  /** Agent preset this session's agent was composed from. */
  agentPreset?: string
  /** Projection baseline for this row (carries the title on 0.0.x). */
  projections?: SessionProjectionsBlock
}

/** One log entry of a history page. */
export interface HistoryEntry {
  event: SessionEvent
}

/** Provider-owned model entry of the catalog. */
export interface ModelCatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: unknown
}

/** One provider and the models it advertised successfully. */
export interface ModelProviderGroup {
  id: string
  name: string
  models: ModelCatalogModel[]
}

/** A provider whose asynchronous catalog lookup failed. */
export interface ModelCatalogFailure {
  id: string
  name: string
  message: string
}

/** One workspace row. */
export interface WorkspaceView {
  workspaceId: WorkspaceId
  /** Canonical directory path. */
  path: string
  /** Display title (defaults to the path basename at create). */
  title: string
  /** Sessions accounted under this workspace. */
  sessionIds: SessionId[]
  /** ISO-8601 creation instant. */
  createdAt: string
  /** ISO-8601 last-mutation instant. */
  updatedAt: string
}

/** One agent preset offered by the deployment. */
export interface AgentPresetEntry {
  readonly id: string
  readonly trust: 'system' | 'user'
  readonly isDefault: boolean
  readonly name?: string
  readonly description?: string
  readonly reason?: string
}

/** Browser-submitted prompt content; only the text part is produced here. */
export type PromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string; name?: string }

/**
 * The host-side ApiProxy surface this plugin consumes. The upstream contract
 * carries many more namespaces (subagents, goals, credentials, events, …);
 * only the ones the console port calls are declared here.
 */
export interface ApiProxy {
  sessions: {
    list(request: RpcRequest<{ cursor?: string }>): Promise<RpcResponse<{ items: SessionSummary[] }>>
    history(request: RpcRequest<{ sessionId: SessionId; beforeSeq?: number; maxMessages?: number }>): Promise<RpcResponse<{
      events: HistoryEntry[]
      hasMore: boolean
      projections?: { values?: { todos?: TodoItem[] | null } & Record<string, unknown> }
    }>>
    create(request: RpcRequest<{ workspaceId?: WorkspaceId; cwd?: string; sessionId?: SessionId; agentPreset?: string }>): Promise<RpcResponse<{ sessionId: SessionId }>>
    prompt(request: RpcRequest<{ sessionId: SessionId; mode: 'queue' | 'steer'; content: PromptContentPart[] }>): Promise<RpcResponse<{ accepted: true }>>
    cancel(request: RpcRequest<{ sessionId: SessionId }>): Promise<RpcResponse<{ accepted: true }>>
    rename(request: RpcRequest<{ sessionId: SessionId; title: string }>): Promise<RpcResponse<{ title: string; seq: number }>>
    fork(request: RpcRequest<{ sessionId: SessionId; atSeq?: number }>): Promise<RpcResponse<{ sessionId: SessionId }>>
  }
  workspace: {
    list(request: RpcRequest<Record<string, never>>): Promise<RpcResponse<{ items: WorkspaceView[]; archivedSessionIds: SessionId[] }>>
    create(request: RpcRequest<{ path: string }>): Promise<RpcResponse<{ workspace: WorkspaceView; created: boolean }>>
    archiveSession(request: RpcRequest<{ sessionId: SessionId }>): Promise<RpcResponse<{ archivedSessionIds: SessionId[] }>>
  }
  llm: {
    models(request: RpcRequest<Record<string, never>>): Promise<RpcResponse<{ groups: ModelProviderGroup[]; failures: ModelCatalogFailure[] }>>
  }
  settings: {
    update(request: RpcRequest<{ ns: string; patch: object; expectedRevision?: number }>): Promise<RpcResponse<unknown>>
  }
  agentPresets: {
    list(request: RpcRequest<Record<string, never>>): Promise<RpcResponse<{ presets: readonly AgentPresetEntry[]; authorable: boolean; hasDocument: boolean }>>
    select(request: RpcRequest<{ sessionId: SessionId; agentPreset: string }>): Promise<RpcResponse<{ agentPreset: string }>>
  }
  /** Response entry for server-requests (client-response, echoing their rpcId). */
  respond(message: ClientResponse): Promise<RpcReceipt>
}
