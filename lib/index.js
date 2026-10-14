// src/index.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { Bot } from "grammy";
import { ProxyAgent, fetch as undiciFetch } from "undici";

// src/apiproxy-shim.ts
function RpcId(id) {
  return id;
}

// src/index.ts
import { isVolatile } from "@deepseek-ai/cosmokit";

// src/host-api.ts
import { randomUUID } from "node:crypto";
var HOST_API_SERVICES = ["sessionController", "workspaceRegistry"];
var AGENT_DEFAULT_MODEL_NS = "agent-default-model";
var liveSignal = () => new AbortController().signal;
function failureOf(error) {
  const candidate = error;
  const raw = typeof candidate?.code === "string" && candidate.code !== "" ? candidate.code : "gateway/internal";
  return {
    // The console matches legacy codes such as `agent-preset-locked`, while
    // 0.2.x spells the same condition `agent-preset/locked`.
    code: raw.replace(/\//g, "-"),
    message: candidate?.message === void 0 ? String(error) : String(candidate.message),
    details: candidate?.details ?? {}
  };
}
function tailByMessages(events, maxMessages) {
  if (maxMessages <= 0 || events.length === 0) return events;
  let seen = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]?.type;
    if (type === "user/message" || type === "assistant/message") {
      seen += 1;
      if (seen > maxMessages) return events.slice(index + 1);
    }
  }
  return events;
}
function mapSummary(row) {
  const title = row.projections?.values?.title;
  const agentPreset = row.projections?.values?.agentPreset;
  return {
    sessionId: row.sessionId,
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : Date.now(),
    running: Boolean(row.running),
    blank: Boolean(row.blank),
    ...row.parentSessionId === void 0 ? {} : { parentSessionId: row.parentSessionId },
    ...row.origin === void 0 ? {} : { origin: row.origin },
    ...row.cwd === void 0 ? {} : { cwd: row.cwd },
    ...typeof agentPreset === "string" ? { agentPreset } : {},
    ...row.projections === void 0 ? {} : { projections: { asOfSeq: row.projections.asOfSeq, values: { ...row.projections.values, ...title === void 0 ? {} : { title } } } }
  };
}
function mapWorkspace(workspace) {
  const id = workspace.workspaceId ?? workspace.id ?? "";
  return {
    workspaceId: id,
    path: workspace.path,
    title: workspace.title,
    sessionIds: [...workspace.sessionIds ?? []],
    createdAt: workspace.createdAt === void 0 ? "" : String(workspace.createdAt),
    updatedAt: workspace.updatedAt === void 0 ? "" : String(workspace.updatedAt)
  };
}
function createHostApi(ctx) {
  const get = (name2) => {
    try {
      return ctx.get(name2);
    } catch {
      return void 0;
    }
  };
  const required = (name2) => {
    const service = get(name2);
    if (service === void 0) throw new Error(`dsh-messenger-telegram: service "${name2}" is not mounted`);
    return service;
  };
  const sessions = () => required("sessionController");
  const registry = () => get("workspaceRegistry");
  const ok = (rpcId, value) => ({ rpcId, result: { ok: true, value } });
  const fail = (rpcId, error) => ({
    rpcId,
    result: { ok: false, error: failureOf(error) }
  });
  const sinks = /* @__PURE__ */ new Set();
  const pending = /* @__PURE__ */ new Map();
  const emit = (sessionId, event) => {
    for (const sink of [...sinks]) {
      try {
        sink({ id: sessionId }, event);
      } catch (error) {
        ctx.logger?.warn?.(`telegram: question bridge sink failed: ${String(error)}`);
      }
    }
  };
  const questionEvent = (type, callId, data) => ({
    type,
    seq: 0,
    time: Date.now(),
    data: { id: callId, ...data }
  });
  const skipAnswer = (questions) => ({
    answers: questions.map((question) => ({ id: question.id, selected: [] }))
  });
  const settlePending = (sessionId, callId, outcome) => {
    pending.delete(callId);
    emit(sessionId, questionEvent("question/decided", callId, { outcome }));
  };
  const downstreamNever = new Promise(() => {
  });
  ctx.on("user-questions/request", (request, next) => {
    const sessionId = request?.agent?.session?.id;
    const callId = request?.wait?.callId;
    const questions = request?.questions;
    if (sessionId === void 0 || callId === void 0 || questions === void 0 || questions.length === 0) {
      return next();
    }
    let settle = () => {
    };
    const answer = new Promise((resolve) => {
      settle = (outcome) => {
        pending.delete(callId);
        emit(sessionId, questionEvent("question/decided", callId, { outcome }));
        resolve(skipAnswer(questions));
      };
      pending.set(callId, {
        sessionId,
        callId,
        agent: request.agent,
        questions,
        resolve: (batch) => {
          pending.delete(callId);
          emit(sessionId, questionEvent("question/decided", callId, { outcome: "answered" }));
          resolve(batch);
        },
        settle
      });
    });
    emit(sessionId, questionEvent("question/asked", callId, { questions }));
    if (request.signal !== void 0) {
      request.signal.addEventListener("abort", () => {
        if (pending.has(callId)) settle("cancelled");
      }, { once: true });
    }
    let downstream;
    try {
      downstream = Promise.resolve(next()).catch(() => downstreamNever);
    } catch {
      downstream = downstreamNever;
    }
    return Promise.race([answer, downstream]).then((resolved) => {
      if (pending.has(callId)) settle("answered");
      return resolved;
    });
  });
  const answerQuestion = (sessionId, callId, answer) => {
    const waiting = pending.get(callId);
    if (waiting !== void 0) {
      waiting.resolve(answer);
      return true;
    }
    const agent = get("agents")?.get(sessionId);
    const userQuestions = get("userQuestions");
    if (agent === void 0 || userQuestions === void 0) return false;
    try {
      return userQuestions.answer(agent, callId, answer);
    } catch (error) {
      ctx.logger?.warn?.(`telegram: question answer failed: ${String(error)}`);
      return false;
    }
  };
  const cancelQuestion = (sessionId, callId) => {
    const waiting = pending.get(callId);
    if (waiting !== void 0) {
      waiting.settle("cancelled");
      return true;
    }
    const agent = get("agents")?.get(sessionId);
    const userQuestions = get("userQuestions");
    if (agent === void 0 || userQuestions === void 0) return false;
    try {
      return userQuestions.answer(agent, callId, skipAnswer([{ id: "" }]));
    } catch {
      return false;
    }
  };
  const api = {
    sessions: {
      async list(request) {
        const { rpcId } = request;
        try {
          const { items } = await sessions().list({}, liveSignal());
          return ok(rpcId, { items: items.map(mapSummary) });
        } catch (error) {
          return fail(rpcId, error);
        }
      },
      async history(request) {
        const { rpcId, payload } = request;
        try {
          const controller = sessions();
          let cursor;
          let projections;
          try {
            const baseline = await controller.projections({ sessionId: payload.sessionId }, liveSignal());
            if (baseline !== null) {
              cursor = baseline.asOfSeq;
              projections = { values: baseline.values };
            }
          } catch {
          }
          let inspected;
          if (cursor === void 0) {
            try {
              inspected = (await controller.inspect(payload.sessionId, liveSignal()))?.events;
              const last = inspected?.[inspected.length - 1];
              if (typeof last?.seq === "number") cursor = last.seq;
            } catch {
            }
          }
          if (cursor !== void 0) {
            try {
              const page = await controller.page({
                address: { kind: "session", sessionId: payload.sessionId },
                throughSeq: cursor,
                ...payload.maxMessages === void 0 ? {} : { maxMessages: payload.maxMessages },
                ...payload.beforeSeq === void 0 ? {} : { beforeSeq: payload.beforeSeq }
              }, liveSignal());
              const events2 = page.records.filter((record) => record?.type === "event").map((record) => ({ event: record.event }));
              if (events2.length > 0) {
                return ok(rpcId, { events: events2, hasMore: page.hasMore, ...projections === void 0 ? {} : { projections } });
              }
            } catch {
            }
          }
          if (inspected === void 0) {
            try {
              inspected = (await controller.inspect(payload.sessionId, liveSignal()))?.events;
            } catch {
              inspected = void 0;
            }
          }
          const tail = tailByMessages(inspected ?? [], payload.maxMessages ?? 20);
          return ok(rpcId, {
            events: tail.map((event) => ({ event })),
            hasMore: (inspected?.length ?? 0) > tail.length,
            ...projections === void 0 ? {} : { projections }
          });
        } catch (error) {
          return fail(rpcId, error);
        }
      },
      async create(request) {
        const { rpcId, payload } = request;
        try {
          const created = await sessions().create({
            ...payload.workspaceId === void 0 ? {} : { workspaceId: String(payload.workspaceId) },
            ...payload.cwd === void 0 ? {} : { cwd: payload.cwd },
            ...payload.agentPreset === void 0 ? {} : { agentPreset: payload.agentPreset }
          });
          return ok(rpcId, { sessionId: created.sessionId });
        } catch (error) {
          return fail(rpcId, error);
        }
      },
      async prompt(request) {
        const { rpcId, payload } = request;
        try {
          await sessions().prompt({
            requestId: `session-request-${randomUUID()}`,
            sessionId: String(payload.sessionId),
            mode: payload.mode,
            content: payload.content.filter((part) => part.type === "text")
          }, liveSignal());
          return ok(rpcId, { accepted: true });
        } catch (error) {
          return fail(rpcId, error);
        }
      },
      async cancel(request) {
        const { rpcId, payload } = request;
        try {
          sessions().cancel({ sessionId: String(payload.sessionId) });
          return ok(rpcId, { accepted: true });
        } catch (error) {
          return fail(rpcId, error);
        }
      },
      async rename(request) {
        const { rpcId, payload } = request;
        try {
          const renamed = await sessions().rename({ sessionId: String(payload.sessionId), title: payload.title });
          return ok(rpcId, { title: renamed.title, seq: renamed.seq });
        } catch (error) {
          return fail(rpcId, error);
        }
      },
      async fork(request) {
        const { rpcId, payload } = request;
        try {
          const forked = await sessions().fork({
            sessionId: String(payload.sessionId),
            ...payload.atSeq === void 0 ? {} : { atSeq: payload.atSeq }
          });
          return ok(rpcId, { sessionId: forked.sessionId });
        } catch (error) {
          return fail(rpcId, error);
        }
      }
    },
    workspace: {
      async list(request) {
        const { rpcId } = request;
        try {
          const store = registry();
          if (store === void 0) throw new Error("dsh-messenger-telegram: workspace registry is not mounted");
          return ok(rpcId, {
            items: store.list().map(mapWorkspace),
            archivedSessionIds: [...store.archivedSessionIds]
          });
        } catch (error) {
          return fail(rpcId, error);
        }
      },
      async create(request) {
        const { rpcId, payload } = request;
        try {
          const controller = get("workspaceController");
          if (controller !== void 0) {
            const created = await controller.create({ path: payload.path });
            return ok(rpcId, { workspace: mapWorkspace(created.workspace), created: created.created });
          }
          const store = registry();
          if (store === void 0) throw new Error("dsh-messenger-telegram: workspace registry is not mounted");
          await store.create(payload.path);
          const workspace = store.list().find((item) => item.path === payload.path);
          if (workspace === void 0) throw new Error(`dsh-messenger-telegram: workspace "${payload.path}" not found after create`);
          return ok(rpcId, { workspace: mapWorkspace(workspace), created: true });
        } catch (error) {
          return fail(rpcId, error);
        }
      },
      async archiveSession(request) {
        const { rpcId, payload } = request;
        try {
          const controller = get("workspaceController");
          if (controller !== void 0) {
            const archived = await controller.archiveSession({ sessionId: String(payload.sessionId), stopActivity: true });
            return ok(rpcId, { archivedSessionIds: [...archived.archivedSessionIds] });
          }
          const store = registry();
          if (store === void 0) throw new Error("dsh-messenger-telegram: workspace registry is not mounted");
          await store.archiveSession(String(payload.sessionId), { stopActivity: true });
          return ok(rpcId, { archivedSessionIds: [...store.archivedSessionIds] });
        } catch (error) {
          return fail(rpcId, error);
        }
      }
    },
    llm: {
      async models(request) {
        const { rpcId } = request;
        try {
          const catalog = await sessions().modelCatalog();
          return ok(rpcId, { groups: [...catalog.groups], failures: [...catalog.failures] });
        } catch (error) {
          return fail(rpcId, error);
        }
      }
    },
    settings: {
      async update(request) {
        const { rpcId, payload } = request;
        try {
          if (payload.ns === AGENT_DEFAULT_MODEL_NS) {
            const patch = payload.patch;
            const agentDefaultModel = get("agentDefaultModel");
            if (agentDefaultModel === void 0) throw new Error("dsh-messenger-telegram: agentDefaultModel is not mounted");
            await agentDefaultModel.saveSelection({
              provider: String(patch.provider ?? ""),
              model: String(patch.model ?? ""),
              ...typeof patch.reasoningEffort === "string" ? { reasoningEffort: patch.reasoningEffort } : {}
            });
            return ok(rpcId, { ns: payload.ns });
          }
          const settings = get("settingsController");
          if (settings === void 0) throw new Error("dsh-messenger-telegram: settingsController is not mounted");
          return ok(rpcId, await settings.update(payload.ns, payload.patch, payload.expectedRevision));
        } catch (error) {
          return fail(rpcId, error);
        }
      }
    },
    agentPresets: {
      async list(request) {
        const { rpcId } = request;
        try {
          const presets = get("agentPresets");
          if (presets === void 0) throw new Error("dsh-messenger-telegram: agentPresets is not mounted");
          const rows = await presets.list();
          const defaultId = presets.defaultId;
          const entries = rows.map((row) => ({
            id: row.id,
            trust: "system",
            isDefault: defaultId === void 0 ? false : row.id === defaultId,
            ...row.name === void 0 ? {} : { name: row.name },
            ...row.description === void 0 ? {} : { description: row.description },
            ...row.broken === void 0 ? {} : { reason: row.broken }
          }));
          return ok(rpcId, { presets: entries, authorable: false, hasDocument: false });
        } catch (error) {
          return fail(rpcId, error);
        }
      },
      async select(request) {
        const { rpcId, payload } = request;
        try {
          const presets = get("agentPresets");
          if (presets === void 0) throw new Error("dsh-messenger-telegram: agentPresets is not mounted");
          const sessionId = String(payload.sessionId);
          let agent = get("agents")?.get(sessionId);
          if (agent === void 0) {
            const resolved = await sessions().resolveAgent(sessionId);
            if (resolved?.agent === void 0) {
              throw new Error(resolved?.error?.message ?? `dsh-messenger-telegram: session "${sessionId}" has no live agent`);
            }
            agent = resolved.agent;
          }
          const selected = await presets.select(agent, payload.agentPreset);
          return ok(rpcId, { agentPreset: selected });
        } catch (error) {
          return fail(rpcId, error);
        }
      }
    },
    async respond(message) {
      const callId = String(message.rpcId);
      const sessionId = message.result.ok ? String(message.result.value.sessionId) : "";
      if (message.result.ok) {
        const accepted = answerQuestion(sessionId, callId, message.result.value.answer);
        return accepted ? { accepted: true } : { accepted: false, reason: "not-pending" };
      }
      const cancelled = cancelQuestion(sessionId, callId);
      return cancelled ? { accepted: true } : { accepted: false, reason: "not-pending" };
    }
  };
  const events = {
    on(name2, handler) {
      if (name2 !== "session/event") return () => {
      };
      sinks.add(handler);
      const stopHost = ctx.on("session/event", (session, event) => {
        try {
          handler({ id: String(session?.id ?? "") }, event);
        } catch (error) {
          ctx.logger?.warn?.(`telegram: event push failed: ${String(error)}`);
        }
      });
      return () => {
        sinks.delete(handler);
        if (typeof stopHost === "function") stopHost();
      };
    }
  };
  return Object.assign(api, { events });
}

// src/config-route.ts
var CONFIG_ROUTE = "/dsh-host-telegram/config";
var SETTINGS_NS = "telegram";
var isLoopback = (address) => address === "::1" || address === "localhost" || address.startsWith("127.") || address.startsWith("::ffff:127.");
function isTrustedRequest(request) {
  const host = String(request?.headers?.host ?? "");
  if (host === "") return false;
  if (String(request?.headers?.["sec-fetch-site"] ?? "").toLowerCase() === "cross-site") return false;
  const remote = request?.socket?.remoteAddress;
  if (remote !== void 0 && !isLoopback(remote)) return false;
  const origin = request?.headers?.origin;
  if (typeof origin === "string" && origin !== "") {
    try {
      if (new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}
function writeJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(payload);
}
async function readJson(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function publicConfig(config) {
  return {
    botTokenConfigured: String(config.botToken ?? "").trim() !== "",
    allowChatIds: Array.isArray(config.allowChatIds) ? config.allowChatIds : [],
    proxy: String(config.proxy ?? ""),
    locale: config.locale === "zh" ? "zh" : "ru",
    keyboard: ["off", "persistent"].includes(config.keyboard) ? config.keyboard : "dismissible"
  };
}
function patchOf(body) {
  const input = body ?? {};
  const source = input.config ?? input;
  const patch = {};
  if (Array.isArray(source.allowChatIds)) {
    patch.allowChatIds = source.allowChatIds.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  }
  if (typeof source.proxy === "string") patch.proxy = source.proxy.trim();
  if (typeof source.locale === "string") patch.locale = source.locale === "zh" ? "zh" : "ru";
  if (typeof source.keyboard === "string") {
    patch.keyboard = ["off", "persistent"].includes(source.keyboard) ? source.keyboard : "dismissible";
  }
  if (typeof source.botToken === "string" && source.botToken.trim() !== "") patch.botToken = source.botToken.trim();
  return patch;
}
function registerConfigRoute(ctx, read) {
  ctx.inject(["webServer"], (webCtx) => {
    const holder = webCtx;
    const webServer = holder.get?.("webServer") ?? holder.webServer;
    if (typeof webServer?.register !== "function") return;
    webCtx.effect(() => webServer.register?.({
      kind: "exact",
      path: CONFIG_ROUTE,
      handler: async (request, response) => {
        if (request.method === "GET") {
          writeJson(response, 200, { ok: true, config: publicConfig(read()) });
          return;
        }
        if (request.method !== "PUT" && request.method !== "POST") {
          writeJson(response, 405, { ok: false, error: "GET or PUT only" });
          return;
        }
        if (!isTrustedRequest(request)) {
          writeJson(response, 403, { ok: false, error: "forbidden" });
          return;
        }
        let patch;
        try {
          patch = patchOf(await readJson(request, 1048576));
        } catch (error) {
          writeJson(response, 400, { ok: false, error: String(error?.message ?? error) });
          return;
        }
        if (Object.keys(patch).length === 0) {
          writeJson(response, 200, { ok: true, config: publicConfig(read()) });
          return;
        }
        try {
          const settings = ctx.get?.("settings");
          if (typeof settings?.update !== "function") throw new Error("settings service is not mounted");
          await settings.update(SETTINGS_NS, patch);
          writeJson(response, 200, { ok: true, config: publicConfig(read()) });
        } catch (error) {
          writeJson(response, 409, { ok: false, error: String(error?.message ?? error) });
        }
      }
    }), "telegram.config-route");
  });
}

// src/locale-ru.ts
function plural(count, forms) {
  const abs = Math.abs(count) % 100;
  const tail = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (tail > 1 && tail < 5) return forms[1];
  if (tail === 1) return forms[0];
  return forms[2];
}
var RUSSIAN_PATTERNS = [
  // Relative age labels: the count drives Russian agreement through `plural`,
  // so "5 分钟前" becomes "5 минут назад", not a calqued fragment.
  [/^刚刚$/, "\u0442\u043E\u043B\u044C\u043A\u043E \u0447\u0442\u043E"],
  [/(\d+)\s*分钟前/, (...args) => `${args[1]} ${plural(Number(args[1]), ["\u043C\u0438\u043D\u0443\u0442\u0443", "\u043C\u0438\u043D\u0443\u0442\u044B", "\u043C\u0438\u043D\u0443\u0442"])} \u043D\u0430\u0437\u0430\u0434`],
  [/(\d+)\s*小时前/, (...args) => `${args[1]} ${plural(Number(args[1]), ["\u0447\u0430\u0441", "\u0447\u0430\u0441\u0430", "\u0447\u0430\u0441\u043E\u0432"])} \u043D\u0430\u0437\u0430\u0434`],
  [/(\d+)\s*天前/, (...args) => `${args[1]} ${plural(Number(args[1]), ["\u0434\u0435\u043D\u044C", "\u0434\u043D\u044F", "\u0434\u043D\u0435\u0439"])} \u043D\u0430\u0437\u0430\u0434`],
  // Counted nouns: sessions, dialogue rounds, messages, models, characters.
  [/(\d+)\s*个会话/, (...args) => `${args[1]} ${plural(Number(args[1]), ["\u0441\u0435\u0441\u0441\u0438\u044F", "\u0441\u0435\u0441\u0441\u0438\u0438", "\u0441\u0435\u0441\u0441\u0438\u0439"])}`],
  [/(\d+)\s*轮对话/, (...args) => `${args[1]} ${plural(Number(args[1]), ["\u0440\u0430\u0443\u043D\u0434", "\u0440\u0430\u0443\u043D\u0434\u0430", "\u0440\u0430\u0443\u043D\u0434\u043E\u0432"])} \u0434\u0438\u0430\u043B\u043E\u0433\u0430`],
  [/(\d+)\s*条消息/, (...args) => `${args[1]} ${plural(Number(args[1]), ["\u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435", "\u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F", "\u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439"])}`],
  [/(\d+)\s*个模型/, (...args) => `${args[1]} ${plural(Number(args[1]), ["\u043C\u043E\u0434\u0435\u043B\u044C", "\u043C\u043E\u0434\u0435\u043B\u0438", "\u043C\u043E\u0434\u0435\u043B\u0435\u0439"])}`],
  [/(\d+)\s*个?字符/, (...args) => `${args[1]} ${plural(Number(args[1]), ["\u0441\u0438\u043C\u0432\u043E\u043B", "\u0441\u0438\u043C\u0432\u043E\u043B\u0430", "\u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432"])}`]
];
var RUSSIAN_PHRASES = [
  // console.ts — question-flow replies
  ["\u2705 \u5DF2\u56DE\u7B54\u3002", "\u2705 \u041E\u0442\u0432\u0435\u0442 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D."],
  ["\u23F9 \u5DF2\u8BF7\u6C42\u505C\u6B62\u3002", "\u23F9 \u0417\u0430\u043F\u0440\u043E\u0448\u0435\u043D\u0430 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0430."],
  ["\u26D4 \u672A\u77E5\u6309\u94AE\u3002", "\u26D4 \u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043A\u043D\u043E\u043F\u043A\u0430."],
  ["\u26D4 \u8BE5\u63D0\u95EE\u5DF2\u5931\u6548\uFF08\u53EF\u80FD\u5DF2\u5728\u522B\u5904\u56DE\u7B54\uFF09\u3002", "\u26D4 \u0412\u043E\u043F\u0440\u043E\u0441 \u0443\u0436\u0435 \u043D\u0435\u0430\u043A\u0442\u0443\u0430\u043B\u0435\u043D (\u0432\u043E\u0437\u043C\u043E\u0436\u043D\u043E, \u043D\u0430 \u043D\u0435\u0433\u043E \u043E\u0442\u0432\u0435\u0442\u0438\u043B\u0438 \u0432 \u0434\u0440\u0443\u0433\u043E\u043C \u043C\u0435\u0441\u0442\u0435)."],
  ["\u{1F6AB} \u5DF2\u53D6\u6D88\u3002", "\u{1F6AB} \u041E\u0442\u043C\u0435\u043D\u0435\u043D\u043E."],
  ["\u23F3 \u56DE\u7B54\u4E2D\u2026", "\u23F3 \u041E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u0435\u043C \u043E\u0442\u0432\u0435\u0442\u2026"],
  ["\u26D4 \u8BE5\u63D0\u95EE\u5DF2\u5931\u6548\uFF08\u9009\u9879\u5DF2\u66F4\u65B0\uFF0C\u8BF7\u91CD\u9009\uFF09\u3002", "\u26D4 \u0412\u043E\u043F\u0440\u043E\u0441 \u0443\u0436\u0435 \u043D\u0435\u0430\u043A\u0442\u0443\u0430\u043B\u0435\u043D (\u0432\u0430\u0440\u0438\u0430\u043D\u0442\u044B \u043E\u0431\u043D\u043E\u0432\u0438\u043B\u0438\u0441\u044C \u2014 \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0441\u043D\u043E\u0432\u0430)."],
  ["\u270D\uFE0F \u8BF7\u76F4\u63A5\u8F93\u5165\u5BF9\u300C${truncate(question.question, 60)}\u300D\u7684\u56DE\u7B54\uFF08\u53D1\u9001\u6587\u672C\u5373\u53EF\uFF09\u3002", "\u270D\uFE0F \u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043E\u0442\u0432\u0435\u0442 \u043D\u0430 \xAB${truncate(question.question, 60)}\xBB \u0442\u0435\u043A\u0441\u0442\u043E\u043C (\u043F\u0440\u043E\u0441\u0442\u043E \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435)."],
  ["\u26D4 \u8FD8\u6709\u95EE\u9898\u300C${truncate(question.question, 40)}\u300D\u672A\u56DE\u7B54\uFF1A\u9009\u62E9\u9009\u9879\u6216\u70B9\u300C\u270D\uFE0F \u81EA\u5B9A\u4E49\u56DE\u7B54\u300D\u3002", "\u26D4 \u041E\u0441\u0442\u0430\u043B\u0441\u044F \u0432\u043E\u043F\u0440\u043E\u0441 \xAB${truncate(question.question, 40)}\xBB: \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0432\u0430\u0440\u0438\u0430\u043D\u0442 \u0438\u043B\u0438 \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \xAB\u270D\uFE0F \u0421\u0432\u043E\u0439 \u043E\u0442\u0432\u0435\u0442\xBB."],
  ["\u{1F6AB} \u5DF2\u53D6\u6D88\u8BE5\u63D0\u95EE\u3002", "\u{1F6AB} \u0412\u043E\u043F\u0440\u043E\u0441 \u043E\u0442\u043C\u0435\u043D\u0451\u043D."],
  ["\u21A9\uFE0F \u5DF2\u53D6\u6D88\u81EA\u5B9A\u4E49\u56DE\u7B54\u3002", "\u21A9\uFE0F \u0421\u0432\u043E\u0439 \u043E\u0442\u0432\u0435\u0442 \u043E\u0442\u043C\u0435\u043D\u0451\u043D."],
  ["\u2705 \u5DF2\u8BB0\u5F55\u5BF9\u300C${truncate(question.question, 40)}\u300D\u7684\u56DE\u7B54\uFF0C\u70B9\u300C\u2705 \u63D0\u4EA4\u56DE\u7B54\u300D\u5B8C\u6210\u3002", "\u2705 \u041E\u0442\u0432\u0435\u0442 \u043D\u0430 \xAB${truncate(question.question, 40)}\xBB \u0437\u0430\u043F\u0438\u0441\u0430\u043D; \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \xAB\u2705 \u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u043E\u0442\u0432\u0435\u0442\xBB."],
  ["\u21A9\uFE0F \u5DF2\u53D6\u6D88\u91CD\u547D\u540D\u3002", "\u21A9\uFE0F \u041F\u0435\u0440\u0435\u0438\u043C\u0435\u043D\u043E\u0432\u0430\u043D\u0438\u0435 \u043E\u0442\u043C\u0435\u043D\u0435\u043D\u043E."],
  ["\u26D4 \u5F53\u524D\u65E0\u6FC0\u6D3B\u4F1A\u8BDD\uFF0C\u65E0\u6CD5\u91CD\u547D\u540D\u3002\u8BF7\u5148\u7ED1\u5B9A\u4F1A\u8BDD\uFF08\u5982 /attach\uFF09\u3002", "\u26D4 \u041D\u0435\u0442 \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0439 \u0441\u0435\u0441\u0441\u0438\u0438 \u2014 \u043F\u0435\u0440\u0435\u0438\u043C\u0435\u043D\u043E\u0432\u0430\u043D\u0438\u0435 \u043D\u0435\u0432\u043E\u0437\u043C\u043E\u0436\u043D\u043E. \u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u043F\u0440\u0438\u0432\u044F\u0436\u0438\u0442\u0435 \u0441\u0435\u0441\u0441\u0438\u044E (\u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440, /attach)."],
  ["\u2705 \u5DF2\u91CD\u547D\u540D\u4E3A ${accepted}", "\u2705 \u041F\u0435\u0440\u0435\u0438\u043C\u0435\u043D\u043E\u0432\u0430\u043D\u043E \u0432 ${accepted}"],
  ["\u8FD8\u6CA1\u6709\u7ED1\u5B9A\u4F1A\u8BDD\u3002\u53D1 /attach\uFF08\u65E0\u53C2\u6570\u5148\u9009\u5DE5\u4F5C\u533A/\u672A\u5206\u7EC4/\u5F52\u6863\uFF09\u9009\u62E9\u5E76\u7ED1\u5B9A\u4E00\u4E2A\u4F1A\u8BDD\u3002", "\u0421\u0435\u0441\u0441\u0438\u044F \u0435\u0449\u0451 \u043D\u0435 \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043D\u0430. \u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /attach (\u0431\u0435\u0437 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u043E\u0432 \u2014 \u0432\u044B\u0431\u043E\u0440 \u0440\u0430\u0431\u043E\u0447\u0435\u0439 \u043E\u0431\u043B\u0430\u0441\u0442\u0438 / \u0431\u0435\u0437 \u0433\u0440\u0443\u043F\u043F\u044B / \u0430\u0440\u0445\u0438\u0432\u0430) \u0438 \u043F\u0440\u0438\u0432\u044F\u0436\u0438\u0442\u0435 \u0441\u0435\u0441\u0441\u0438\u044E."],
  ["\u{1F4E5} \u5DF2\u52A0\u5165\u961F\u5217\uFF1A${truncate(text, QUEUE_ACK_MAX)}", "\u{1F4E5} \u0414\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u043E \u0432 \u043E\u0447\u0435\u0440\u0435\u0434\u044C: ${truncate(text, QUEUE_ACK_MAX)}"],
  // console.ts — command routing and session lists
  ["\u672A\u77E5\u547D\u4EE4 /${command.name}\u3002\u53D1\u9001 /start \u67E5\u770B\u53EF\u7528\u547D\u4EE4\u3002", "\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043A\u043E\u043C\u0430\u043D\u0434\u0430 /${command.name}. \u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /start, \u0447\u0442\u043E\u0431\u044B \u0443\u0432\u0438\u0434\u0435\u0442\u044C \u0441\u043F\u0438\u0441\u043E\u043A \u043A\u043E\u043C\u0430\u043D\u0434."],
  ["\u5F53\u524D\u6CA1\u6709\u53EF\u7528\u4F1A\u8BDD\u3002\u7528 /new \u521B\u5EFA\u4E00\u4E2A\u3002", "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u044B\u0445 \u0441\u0435\u0441\u0441\u0438\u0439 \u043D\u0435\u0442. \u0421\u043E\u0437\u0434\u0430\u0439\u0442\u0435 \u043D\u043E\u0432\u0443\u044E \u043A\u043E\u043C\u0430\u043D\u0434\u043E\u0439 /new."],
  ["\u8FD8\u6CA1\u6709\u5DE5\u4F5C\u533A\u3002\u53D1 /new <\u670D\u52A1\u5668\u76EE\u5F55\u8DEF\u5F84> \u65B0\u5EFA\u5DE5\u4F5C\u533A\u5E76\u521B\u5EFA\u4F1A\u8BDD\uFF0C\u6216 /new none \u521B\u5EFA\u672A\u5206\u7C7B\u4F1A\u8BDD\u3002", "\u0420\u0430\u0431\u043E\u0447\u0438\u0445 \u043E\u0431\u043B\u0430\u0441\u0442\u0435\u0439 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442. \u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /new <\u043F\u0443\u0442\u044C \u043D\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u0435>, \u0447\u0442\u043E\u0431\u044B \u0441\u043E\u0437\u0434\u0430\u0442\u044C \u043E\u0431\u043B\u0430\u0441\u0442\u044C \u0438 \u0441\u0435\u0441\u0441\u0438\u044E, \u043B\u0438\u0431\u043E /new none \u2014 \u0441\u0435\u0441\u0441\u0438\u044F \u0431\u0435\u0437 \u043E\u0431\u043B\u0430\u0441\u0442\u0438."],
  ["\u5E8F\u53F7 ${rawTarget} \u8D85\u51FA\u8303\u56F4\uFF1A\u5148 /attach \u5237\u65B0\u5217\u8868", "\u041D\u043E\u043C\u0435\u0440 ${rawTarget} \u0432\u043D\u0435 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D\u0430: \u043E\u0431\u043D\u043E\u0432\u0438\u0442\u0435 \u0441\u043F\u0438\u0441\u043E\u043A \u043A\u043E\u043C\u0430\u043D\u0434\u043E\u0439 /attach"],
  ["\u5DE5\u4F5C\u533A\u5E8F\u53F7 ${rawTarget} \u8D85\u51FA\u8303\u56F4\uFF1A\u5148 /attach \u5237\u65B0\u8303\u56F4\u5217\u8868", "\u041D\u043E\u043C\u0435\u0440 \u0440\u0430\u0431\u043E\u0447\u0435\u0439 \u043E\u0431\u043B\u0430\u0441\u0442\u0438 ${rawTarget} \u0432\u043D\u0435 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D\u0430: \u043E\u0431\u043D\u043E\u0432\u0438\u0442\u0435 \u0441\u043F\u0438\u0441\u043E\u043A \u043A\u043E\u043C\u0430\u043D\u0434\u043E\u0439 /attach"],
  ["\uFF08\u7A7A\u767D\u4F1A\u8BDD\uFF09", "(\u043F\u0443\u0441\u0442\u0430\u044F \u0441\u0435\u0441\u0441\u0438\u044F)"],
  ["\u{1F517} \u5DF2\u7ED1\u5B9A ${sessionId}\uFF08${shortSessionId(sessionId)}\uFF09\n\n\u6700\u8FD1 ${ATTACH_ROUNDS} \u8F6E\u5BF9\u8BDD\uFF1A", "\u{1F517} \u041F\u0440\u0438\u0432\u044F\u0437\u0430\u043D\u0430 ${sessionId} (${shortSessionId(sessionId)})\n\n\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0435 ${ATTACH_ROUNDS} \u0440\u0430\u0443\u043D\u0434\u0430 \u0434\u0438\u0430\u043B\u043E\u0433\u0430:"],
  ["\u{1F527} \u8FDB\u884C\u4E2D\uFF1A\n", "\u{1F527} \u0412 \u0440\u0430\u0431\u043E\u0442\u0435:\n"],
  ["\u23F3 \u8FDB\u884C\u4E2D\u2026", "\u23F3 \u0412\u044B\u043F\u043E\u043B\u043D\u044F\u0435\u0442\u0441\u044F\u2026"],
  ["\u8FD8\u6CA1\u6709\u5DE5\u4F5C\u533A\u3002", "\u0420\u0430\u0431\u043E\u0447\u0438\u0445 \u043E\u0431\u043B\u0430\u0441\u0442\u0435\u0439 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442."],
  ["/attach none\uFF08\u672A\u5206\u7EC4\uFF09", "/attach none (\u0431\u0435\u0437 \u0433\u0440\u0443\u043F\u043F\u044B)"],
  ["/attach arc\uFF08\u5F52\u6863\uFF09", "/attach arc (\u0430\u0440\u0445\u0438\u0432)"],
  ["\u9009\u62E9\u4F1A\u8BDD\u8303\u56F4\uFF1A\u70B9\u4E0B\u65B9\u7684\u8303\u56F4\u6309\u94AE\uFF0C\u6216\u76F4\u63A5 /attach <\u4F1A\u8BDDid>\u3002", "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043E\u0431\u043B\u0430\u0441\u0442\u044C \u0441\u0435\u0441\u0441\u0438\u0439: \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \u043A\u043D\u043E\u043F\u043A\u0443 \u043D\u0438\u0436\u0435 \u0438\u043B\u0438 \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /attach <id \u0441\u0435\u0441\u0441\u0438\u0438>."],
  ["\u9009\u62E9\u4F1A\u8BDD\u8303\u56F4\uFF1A\u70B9\u4E0B\u65B9\u7684\u8303\u56F4\u6309\u94AE\uFF08\u6216 ${scopes.join('\u3001')}\uFF09\uFF0C\u6216\u76F4\u63A5 /attach <\u4F1A\u8BDDid>\u3002", "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043E\u0431\u043B\u0430\u0441\u0442\u044C \u0441\u0435\u0441\u0441\u0438\u0439: \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \u043A\u043D\u043E\u043F\u043A\u0443 \u043D\u0438\u0436\u0435 (\u0438\u043B\u0438 ${scopes.join('\u3001')}), \u043B\u0438\u0431\u043E \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /attach <id \u0441\u0435\u0441\u0441\u0438\u0438>."],
  ["${hint}\uFF08\u6682\u65E0\u4F1A\u8BDD\uFF09", "${hint} (\u0441\u0435\u0441\u0441\u0438\u0439 \u043D\u0435\u0442)"],
  ["\u{1F517} \u5FEB\u6377\u7ED1\u5B9A\uFF1A\u8FD0\u884C\u4E2D\u7684\u5168\u90E8\u4F1A\u8BDD\uFF0C\u52A0\u6700\u8FD1\u5B8C\u6210\u7684 5 \u4E2A\u3002\u70B9\u6309\u94AE\u76F4\u63A5\u7ED1\u5B9A\uFF08\u6216 /attach <\u5E8F\u53F7>\uFF09\u3002", "\u{1F517} \u0411\u044B\u0441\u0442\u0440\u0430\u044F \u043F\u0440\u0438\u0432\u044F\u0437\u043A\u0430: \u0432\u0441\u0435 \u0437\u0430\u043F\u0443\u0449\u0435\u043D\u043D\u044B\u0435 \u0441\u0435\u0441\u0441\u0438\u0438 \u043F\u043B\u044E\u0441 5 \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0445 \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043D\u043D\u044B\u0445. \u041D\u0430\u0436\u043C\u0438\u0442\u0435 \u043A\u043D\u043E\u043F\u043A\u0443 \u0438\u043B\u0438 \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /attach <\u043D\u043E\u043C\u0435\u0440>."],
  ["\u672A\u5206\u7EC4\u4F1A\u8BDD\uFF1A", "\u0421\u0435\u0441\u0441\u0438\u0438 \u0431\u0435\u0437 \u0433\u0440\u0443\u043F\u043F\u044B:"],
  ["\u5F52\u6863\u4F1A\u8BDD\uFF1A", "\u0410\u0440\u0445\u0438\u0432\u043D\u044B\u0435 \u0441\u0435\u0441\u0441\u0438\u0438:"],
  ["\u26D4 \u8BE5\u5DE5\u4F5C\u533A\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0 /attach\u3002", "\u26D4 \u0420\u0430\u0431\u043E\u0447\u0430\u044F \u043E\u0431\u043B\u0430\u0441\u0442\u044C \u0443\u0441\u0442\u0430\u0440\u0435\u043B\u0430, \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /attach \u0437\u0430\u043D\u043E\u0432\u043E."],
  ["\u5DE5\u4F5C\u533A\u300C${workspace.title}\u300D\u7684\u4F1A\u8BDD\uFF1A", "\u0421\u0435\u0441\u0441\u0438\u0438 \u0440\u0430\u0431\u043E\u0447\u0435\u0439 \u043E\u0431\u043B\u0430\u0441\u0442\u0438 \xAB${workspace.title}\xBB:"],
  ["\u5DF2\u6536\u8D77\u5FEB\u6377\u952E\u76D8\uFF0C\u4F1A\u8BDD\u7ED1\u5B9A\u4E0D\u53D8\u3002", "\u041A\u043B\u0430\u0432\u0438\u0430\u0442\u0443\u0440\u0430 \u0441\u043A\u0440\u044B\u0442\u0430, \u043F\u0440\u0438\u0432\u044F\u0437\u043A\u0430 \u0441\u0435\u0441\u0441\u0438\u0438 \u043D\u0435 \u0438\u0437\u043C\u0435\u043D\u0438\u043B\u0430\u0441\u044C."],
  ["\u26A0\uFE0F \u786E\u8BA4\u6536\u8D77\u5FEB\u6377\u952E\u76D8\uFF1F\u518D\u6B21\u53D1\u9001 /close \u786E\u8BA4\uFF08\u4F1A\u8BDD\u7ED1\u5B9A\u4E0D\u53D8\uFF1B\u5176\u5B83\u547D\u4EE4\u6216\u6587\u5B57\u53EF\u53D6\u6D88\uFF09\u3002", "\u26A0\uFE0F \u0421\u043A\u0440\u044B\u0442\u044C \u043A\u043B\u0430\u0432\u0438\u0430\u0442\u0443\u0440\u0443? \u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /close \u0435\u0449\u0451 \u0440\u0430\u0437 \u0434\u043B\u044F \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F (\u043F\u0440\u0438\u0432\u044F\u0437\u043A\u0430 \u0441\u0435\u0441\u0441\u0438\u0438 \u043D\u0435 \u0438\u0437\u043C\u0435\u043D\u0438\u0442\u0441\u044F; \u0434\u0440\u0443\u0433\u0430\u044F \u043A\u043E\u043C\u0430\u043D\u0434\u0430 \u0438\u043B\u0438 \u0442\u0435\u043A\u0441\u0442 \u043E\u0442\u043C\u0435\u043D\u0438\u0442)."],
  ["\u5DF2\u6253\u5F00\u952E\u76D8\u533A\u3002", "\u041A\u043B\u0430\u0432\u0438\u0430\u0442\u0443\u0440\u0430 \u043E\u0442\u043A\u0440\u044B\u0442\u0430."],
  ["\u{1F4CC} \u5FEB\u6377\u952E\u76D8\u5DF2\u56DE\u5230\u5E38\u7528\u64CD\u4F5C\u3002", "\u{1F4CC} \u041A\u043B\u0430\u0432\u0438\u0430\u0442\u0443\u0440\u0430 \u0432\u0435\u0440\u043D\u0443\u043B\u0430\u0441\u044C \u043A \u0447\u0430\u0441\u0442\u044B\u043C \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044F\u043C."],
  ["\u26D4 /stop \u4E0D\u9700\u8981\u53C2\u6570\uFF1A\u5B83\u505C\u6B62\u5F53\u524D\u7ED1\u5B9A\u7684\u4F1A\u8BDD\u3002", "\u26D4 /stop \u043D\u0435 \u043F\u0440\u0438\u043D\u0438\u043C\u0430\u0435\u0442 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u043E\u0432: \u043E\u043D \u043E\u0441\u0442\u0430\u043D\u0430\u0432\u043B\u0438\u0432\u0430\u0435\u0442 \u0442\u0435\u043A\u0443\u0449\u0443\u044E \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043D\u043D\u0443\u044E \u0441\u0435\u0441\u0441\u0438\u044E."],
  ["\u6CA1\u6709\u6253\u5F00\u4F1A\u8BDD\u3002\u70B9\u4E0B\u65B9\u6309\u94AE\u505C\u6B62\u5BF9\u5E94\u4F1A\u8BDD\uFF1A", "\u041E\u0442\u043A\u0440\u044B\u0442\u044B\u0445 \u0441\u0435\u0441\u0441\u0438\u0439 \u043D\u0435\u0442. \u041D\u0430\u0436\u043C\u0438\u0442\u0435 \u043A\u043D\u043E\u043F\u043A\u0443 \u043D\u0438\u0436\u0435, \u0447\u0442\u043E\u0431\u044B \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C \u043D\u0443\u0436\u043D\u0443\u044E \u0441\u0435\u0441\u0441\u0438\u044E:"],
  ["\u6CA1\u6709\u6253\u5F00\u4F1A\u8BDD\u3002\u70B9\u4E0B\u65B9\u6309\u94AE\u67E5\u770B\u4F1A\u8BDD\u8BE6\u60C5\uFF1A", "\u041E\u0442\u043A\u0440\u044B\u0442\u044B\u0445 \u0441\u0435\u0441\u0441\u0438\u0439 \u043D\u0435\u0442. \u041D\u0430\u0436\u043C\u0438\u0442\u0435 \u043A\u043D\u043E\u043F\u043A\u0443 \u043D\u0438\u0436\u0435, \u0447\u0442\u043E\u0431\u044B \u043F\u043E\u0441\u043C\u043E\u0442\u0440\u0435\u0442\u044C \u0434\u0435\u0442\u0430\u043B\u0438 \u0441\u0435\u0441\u0441\u0438\u0438:"],
  ["\u4F1A\u8BDD ${shortSessionId(id)} \u4E0D\u5B58\u5728\u3002", "\u0421\u0435\u0441\u0441\u0438\u044F ${shortSessionId(id)} \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430."],
  // console.ts — /status details
  ["\u7248\u672C: ${TELEGRAM_VERSION}", "\u0412\u0435\u0440\u0441\u0438\u044F: ${TELEGRAM_VERSION}"],
  ["\u{1F7E2} \u8FD0\u884C\u4E2D", "\u{1F7E2} \u0417\u0430\u043F\u0443\u0449\u0435\u043D\u0430"],
  ["\u26AA \u7A7A\u95F2", "\u26AA \u041F\u0440\u043E\u0441\u0442\u043E\u0439"],
  ["\u76EE\u5F55: ${summaryItem.cwd ?? '\uFF08\u672A\u8BB0\u5F55\uFF09'}", "\u041A\u0430\u0442\u0430\u043B\u043E\u0433: ${summaryItem.cwd ?? '\uFF08\u672A\u8BB0\u5F55\uFF09'}"],
  ["\uFF08\u672A\u8BB0\u5F55\uFF09", "(\u043D\u0435 \u0437\u0430\u043F\u0438\u0441\u0430\u043D\u043E)"],
  ["\u66F4\u65B0: ${timeAgo(summaryItem.updatedAt, now)}", "\u041E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u043E: ${timeAgo(summaryItem.updatedAt, now)}"],
  ["\u9884\u8BBE: ${summaryItem.agentPreset ?? '\u9ED8\u8BA4'}", "\u041F\u0440\u0435\u0441\u0435\u0442: ${summaryItem.agentPreset ?? '\u9ED8\u8BA4'}"],
  ["\u9ED8\u8BA4", "\u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E"],
  ["\u6807\u9898: ${truncate(title, 80)}", "\u0417\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A: ${truncate(title, 80)}"],
  ["\u6D88\u606F: \u7528\u6237 ${stats.users} \xB7 \u52A9\u624B ${stats.assistants} \xB7 \u5DE5\u5177\u8C03\u7528 ${stats.tools}", "\u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F: \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044C ${stats.users} \xB7 \u0430\u0441\u0441\u0438\u0441\u0442\u0435\u043D\u0442 ${stats.assistants} \xB7 \u0432\u044B\u0437\u043E\u0432\u044B \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u043E\u0432 ${stats.tools}"],
  ["\u4E0A\u4E0B\u6587 ~${stats.chars} \u5B57\u7B26\uFF08\u8FD1 ${stats.users + stats.assistants} \u6761\u6D88\u606F\uFF09", "\u041A\u043E\u043D\u0442\u0435\u043A\u0441\u0442: ~${stats.chars} \u0441\u0438\u043C\u0432. (\u0437\u0430 \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0435 ${stats.users + stats.assistants} \u0441\u043E\u043E\u0431\u0449.)"],
  // console.ts — /model
  ["\u6CA1\u6709\u627E\u5230\u6A21\u578B ${name}\u3002\u53D1\u9001 /model \u67E5\u770B\u53EF\u914D\u7F6E\u6A21\u578B\u5217\u8868\u3002", "\u041C\u043E\u0434\u0435\u043B\u044C ${name} \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430. \u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /model, \u0447\u0442\u043E\u0431\u044B \u0443\u0432\u0438\u0434\u0435\u0442\u044C \u0441\u043F\u0438\u0441\u043E\u043A \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B\u0445 \u043C\u043E\u0434\u0435\u043B\u0435\u0439."],
  ["\u2705 \u5DF2\u8BBE\u7F6E\u5168\u5C40\u9ED8\u8BA4\u6A21\u578B ${match.providerName}/${match.modelName}", "\u2705 \u0413\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u0430\u044F \u043C\u043E\u0434\u0435\u043B\u044C \u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E: ${match.providerName}/${match.modelName}"],
  ["\u6682\u65E0\u53EF\u7528\u6A21\u578B\u3002", "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u044B\u0445 \u043C\u043E\u0434\u0435\u043B\u0435\u0439 \u043D\u0435\u0442."],
  ["\u{1F39B} \u8BBE\u7F6E\u5168\u5C40\u9ED8\u8BA4\u6A21\u578B\uFF1A\n\n\u70B9\u6309\u94AE\u9009\u62E9\uFF0C\u6216\u53D1\u9001 /model <\u6A21\u578B\u540D> \u76F4\u63A5\u6307\u5B9A\u3002", "\u{1F39B} \u0413\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u0430\u044F \u043C\u043E\u0434\u0435\u043B\u044C \u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E:\n\n\u041D\u0430\u0436\u043C\u0438\u0442\u0435 \u043A\u043D\u043E\u043F\u043A\u0443 \u0438\u043B\u0438 \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /model <\u0438\u043C\u044F \u043C\u043E\u0434\u0435\u043B\u0438>."],
  ["\n\n\u8FD8\u6709 ${buttons.length - MODEL_KEYBOARD_LIMIT} \u4E2A\u6A21\u578B\u672A\u663E\u793A\u3002", "\n\n\u041D\u0435 \u043F\u043E\u043A\u0430\u0437\u0430\u043D\u043E \u043C\u043E\u0434\u0435\u043B\u0435\u0439: ${buttons.length - MODEL_KEYBOARD_LIMIT}."],
  ["\n\n\u26A0\uFE0F \u90E8\u5206\u6A21\u578B\u52A0\u8F7D\u5931\u8D25\uFF1A\n${catalog.failures.map(failure => `${failure.name}\uFF08${failure.message}\uFF09`).join('\\n')}", "\n\n\u26A0\uFE0F \u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0447\u0430\u0441\u0442\u044C \u043C\u043E\u0434\u0435\u043B\u0435\u0439:\n${catalog.failures.map(failure => `${failure.name} (${failure.message})`).join('\\n')}"],
  // console.ts — /create, /operate, /new
  ["\u521B\u5EFA\u4F1A\u8BDD\uFF1A\u9009\u62E9\u4E00\u79CD\u65B9\u5F0F\u3002\n\n\xB7 /new \u2014 \u65B0\u5EFA\u4F1A\u8BDD\uFF08\u9009\u5DE5\u4F5C\u533A / \u672A\u5206\u7C7B / \u8DEF\u5F84\uFF09\n\xB7 /fork \u2014 \u5206\u53C9\u5F53\u524D\u4F1A\u8BDD\uFF08\u4ECE\u6700\u540E\u4E00\u4E2A\u5DF2\u5B8C\u6210\u56DE\u5408\uFF09", "\u0421\u043E\u0437\u0434\u0430\u043D\u0438\u0435 \u0441\u0435\u0441\u0441\u0438\u0438: \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0441\u043F\u043E\u0441\u043E\u0431.\n\n\xB7 /new \u2014 \u043D\u043E\u0432\u0430\u044F \u0441\u0435\u0441\u0441\u0438\u044F (\u0440\u0430\u0431\u043E\u0447\u0430\u044F \u043E\u0431\u043B\u0430\u0441\u0442\u044C / \u0431\u0435\u0437 \u043E\u0431\u043B\u0430\u0441\u0442\u0438 / \u043F\u0443\u0442\u044C)\n\xB7 /fork \u2014 \u0444\u043E\u0440\u043A \u0442\u0435\u043A\u0443\u0449\u0435\u0439 \u0441\u0435\u0441\u0441\u0438\u0438 (\u0441 \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0435\u0433\u043E \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043D\u043D\u043E\u0433\u043E \u0440\u0430\u0443\u043D\u0434\u0430)"],
  ["\u64CD\u4F5C\u4F1A\u8BDD\uFF1A\u9009\u62E9\u4E00\u9879\u3002\n\n\xB7 /archive \u2014 \u5F52\u6863\u5F53\u524D\u4F1A\u8BDD\n\xB7 /stop \u2014 \u505C\u6B62\u8FDB\u884C\u4E2D\u7684\u56DE\u5408\n\xB7 /curTasks \u2014 \u67E5\u770B\u4EFB\u52A1\u5217\u8868", "\u041E\u043F\u0435\u0440\u0430\u0446\u0438\u0438 \u0441 \u0441\u0435\u0441\u0441\u0438\u0435\u0439: \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043F\u0443\u043D\u043A\u0442.\n\n\xB7 /archive \u2014 \u0430\u0440\u0445\u0438\u0432\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0442\u0435\u043A\u0443\u0449\u0443\u044E \u0441\u0435\u0441\u0441\u0438\u044E\n\xB7 /stop \u2014 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C \u0442\u0435\u043A\u0443\u0449\u0438\u0439 \u0440\u0430\u0443\u043D\u0434\n\xB7 /curTasks \u2014 \u0441\u043F\u0438\u0441\u043E\u043A \u0437\u0430\u0434\u0430\u0447"],
  ["\u5728\u54EA\u4E2A\u5DE5\u4F5C\u533A\u521B\u5EFA\u4F1A\u8BDD\uFF1F\u70B9\u6309\u94AE\u5373\u53EF\uFF0C\u6216 /new <\u670D\u52A1\u5668\u76EE\u5F55\u8DEF\u5F84> \u65B0\u5EFA\u5DE5\u4F5C\u533A\u3002", "\u0412 \u043A\u0430\u043A\u043E\u0439 \u0440\u0430\u0431\u043E\u0447\u0435\u0439 \u043E\u0431\u043B\u0430\u0441\u0442\u0438 \u0441\u043E\u0437\u0434\u0430\u0442\u044C \u0441\u0435\u0441\u0441\u0438\u044E? \u041D\u0430\u0436\u043C\u0438\u0442\u0435 \u043A\u043D\u043E\u043F\u043A\u0443 \u0438\u043B\u0438 \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /new <\u043F\u0443\u0442\u044C \u043D\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u0435> \u0434\u043B\u044F \u043D\u043E\u0432\u043E\u0439 \u043E\u0431\u043B\u0430\u0441\u0442\u0438."],
  ["\u672A\u5206\u7C7B", "\u0411\u0435\u0437 \u043E\u0431\u043B\u0430\u0441\u0442\u0438"],
  ["\u5DE5\u4F5C\u533A\u5E8F\u53F7 ${rawTarget} \u8D85\u51FA\u8303\u56F4\uFF1A\u53D1\u9001 /new \u91CD\u65B0\u770B\u770B\u5DE5\u4F5C\u533A\u5217\u8868", "\u041D\u043E\u043C\u0435\u0440 \u0440\u0430\u0431\u043E\u0447\u0435\u0439 \u043E\u0431\u043B\u0430\u0441\u0442\u0438 ${rawTarget} \u0432\u043D\u0435 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D\u0430: \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /new, \u0447\u0442\u043E\u0431\u044B \u0441\u043D\u043E\u0432\u0430 \u0443\u0432\u0438\u0434\u0435\u0442\u044C \u0441\u043F\u0438\u0441\u043E\u043A"],
  ["\u5DE5\u4F5C\u533A\u300C${workspace.title}\u300D", "\u0420\u0430\u0431\u043E\u0447\u0430\u044F \u043E\u0431\u043B\u0430\u0441\u0442\u044C \xAB${workspace.title}\xBB"],
  [" \xB7 \u6A21\u5F0F ${preset}", " \xB7 \u0440\u0435\u0436\u0438\u043C ${preset}"],
  ["\u{1F517} \u5DF2\u521B\u5EFA\u65B0\u4F1A\u8BDD ${sessionId}\uFF08${shortSessionId(sessionId)}\uFF09\xB7 ${location}${presetNote}", "\u{1F517} \u0421\u043E\u0437\u0434\u0430\u043D\u0430 \u043D\u043E\u0432\u0430\u044F \u0441\u0435\u0441\u0441\u0438\u044F ${sessionId} (${shortSessionId(sessionId)}) \xB7 ${location}${presetNote}"],
  // console.ts — /archive, /delete, /rename, /fork, /curTasks
  ["\u26A0\uFE0F \u5DF2\u6539\u9009\u4F1A\u8BDD ${shortSessionId(resolved.id)}\uFF0C\u518D\u6B21\u53D1\u9001 /archive \u786E\u8BA4\u5F52\u6863\u3002", "\u26A0\uFE0F \u0412\u044B\u0431\u0440\u0430\u043D\u0430 \u0434\u0440\u0443\u0433\u0430\u044F \u0441\u0435\u0441\u0441\u0438\u044F ${shortSessionId(resolved.id)}; \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /archive \u0435\u0449\u0451 \u0440\u0430\u0437 \u0434\u043B\u044F \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F \u0430\u0440\u0445\u0438\u0432\u0430\u0446\u0438\u0438."],
  ["\u26A0\uFE0F \u786E\u8BA4\u5F52\u6863\u4F1A\u8BDD ${shortSessionId(resolved.id)}\uFF1F\u518D\u6B21\u53D1\u9001 /archive \u786E\u8BA4\uFF08\u5176\u5B83\u547D\u4EE4\u6216\u6587\u5B57\u53EF\u53D6\u6D88\uFF09\u3002", "\u26A0\uFE0F \u0410\u0440\u0445\u0438\u0432\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0441\u0435\u0441\u0441\u0438\u044E ${shortSessionId(resolved.id)}? \u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /archive \u0435\u0449\u0451 \u0440\u0430\u0437 \u0434\u043B\u044F \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F (\u0434\u0440\u0443\u0433\u0430\u044F \u043A\u043E\u043C\u0430\u043D\u0434\u0430 \u0438\u043B\u0438 \u0442\u0435\u043A\u0441\u0442 \u043E\u0442\u043C\u0435\u043D\u0438\u0442)."],
  ["\u{1F4E6} \u5DF2\u5F52\u6863\u4F1A\u8BDD ${shortSessionId(resolved.id)}\uFF08\u52A0\u5165\u5F52\u6863\u533A\uFF0C\u4ECE\u5217\u8868\u4E0E\u5DE5\u4F5C\u533A\u9690\u85CF\uFF09", "\u{1F4E6} \u0421\u0435\u0441\u0441\u0438\u044F ${shortSessionId(resolved.id)} \u0432 \u0430\u0440\u0445\u0438\u0432\u0435 (\u0441\u043A\u0440\u044B\u0442\u0430 \u0438\u0437 \u0441\u043F\u0438\u0441\u043A\u0430 \u0438 \u0440\u0430\u0431\u043E\u0447\u0435\u0439 \u043E\u0431\u043B\u0430\u0441\u0442\u0438)"],
  ["\u70B9\u4E0B\u65B9\u6309\u94AE\u5220\u9664\u5BF9\u5E94\u4F1A\u8BDD\uFF08\u5220\u9664\u540E\u4ECE\u5217\u8868\u9690\u85CF\uFF09\uFF1A", "\u041D\u0430\u0436\u043C\u0438\u0442\u0435 \u043A\u043D\u043E\u043F\u043A\u0443 \u043D\u0438\u0436\u0435, \u0447\u0442\u043E\u0431\u044B \u0443\u0434\u0430\u043B\u0438\u0442\u044C \u0441\u0435\u0441\u0441\u0438\u044E (\u043F\u043E\u0441\u043B\u0435 \u0443\u0434\u0430\u043B\u0435\u043D\u0438\u044F \u043E\u043D\u0430 \u0441\u043A\u0440\u044B\u0442\u0430 \u0438\u0437 \u0441\u043F\u0438\u0441\u043A\u0430):"],
  ["\u{1F5D1} \u5DF2\u5220\u9664\u4F1A\u8BDD ${shortSessionId(resolved.id)}\uFF08\u4ECE\u5217\u8868\u4E0E\u5DE5\u4F5C\u533A\u9690\u85CF\uFF09", "\u{1F5D1} \u0421\u0435\u0441\u0441\u0438\u044F ${shortSessionId(resolved.id)} \u0443\u0434\u0430\u043B\u0435\u043D\u0430 (\u0441\u043A\u0440\u044B\u0442\u0430 \u0438\u0437 \u0441\u043F\u0438\u0441\u043A\u0430 \u0438 \u0440\u0430\u0431\u043E\u0447\u0435\u0439 \u043E\u0431\u043B\u0430\u0441\u0442\u0438)"],
  ["\u5F53\u524D\u65E0\u6FC0\u6D3B\u4F1A\u8BDD\u3002\u8BF7\u5148\u7ED1\u5B9A\u4F1A\u8BDD\uFF08\u5982 /attach\uFF09\uFF0C\u518D\u53D1 /rename \u91CD\u547D\u540D\u3002", "\u041D\u0435\u0442 \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0439 \u0441\u0435\u0441\u0441\u0438\u0438. \u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u043F\u0440\u0438\u0432\u044F\u0436\u0438\u0442\u0435 \u0441\u0435\u0441\u0441\u0438\u044E (\u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440, /attach), \u0437\u0430\u0442\u0435\u043C \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /rename."],
  ["/rename\uFF1A\u8BF7\u518D\u6B21\u8F93\u5165\u6807\u9898\uFF0C\u5F53\u524D\u4F1A\u8BDD\u5C06\u91CD\u547D\u540D\u4E3A\uFF08\u5373\u91CD\u547D\u540D\u5F53\u524D\u7ED1\u5B9A\u4F1A\u8BDD\uFF09\u3002", "/rename: \u0432\u0432\u0435\u0434\u0438\u0442\u0435 \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A \u0435\u0449\u0451 \u0440\u0430\u0437 \u2014 \u0431\u0443\u0434\u0435\u0442 \u043F\u0435\u0440\u0435\u0438\u043C\u0435\u043D\u043E\u0432\u0430\u043D\u0430 \u0442\u0435\u043A\u0443\u0449\u0430\u044F \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043D\u043D\u0430\u044F \u0441\u0435\u0441\u0441\u0438\u044F."],
  ["\u{1F500} \u5DF2\u5206\u53C9\u4F1A\u8BDD ${shortSessionId(resolved.id)}\uFF1A\u65B0\u4F1A\u8BDD ${childId}\uFF08${shortSessionId(childId)}\uFF09\uFF0C\u5DF2\u7ED1\u5B9A\u5230\u65B0\u4F1A\u8BDD\u3002", "\u{1F500} \u0421\u0435\u0441\u0441\u0438\u044F ${shortSessionId(resolved.id)} \u0440\u0430\u0437\u0434\u0435\u043B\u0435\u043D\u0430: \u043D\u043E\u0432\u0430\u044F \u0441\u0435\u0441\u0441\u0438\u044F ${childId} (${shortSessionId(childId)}), \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043D\u0430 \u043A \u043D\u0435\u0439."],
  ["\u8FD8\u6CA1\u6709\u7ED1\u5B9A\u4F1A\u8BDD\u3002\u53D1 /attach\uFF08\u6216 /new \u521B\u5EFA\uFF09\u7ED1\u5B9A\u4E00\u4E2A\u4F1A\u8BDD\u540E\uFF0C\u7528 /curTasks \u67E5\u770B\u5B83\u7684\u4EFB\u52A1\u5217\u8868\u3002", "\u0421\u0435\u0441\u0441\u0438\u044F \u0435\u0449\u0451 \u043D\u0435 \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043D\u0430. \u041F\u0440\u0438\u0432\u044F\u0436\u0438\u0442\u0435 \u0441\u0435\u0441\u0441\u0438\u044E \u043A\u043E\u043C\u0430\u043D\u0434\u043E\u0439 /attach (\u0438\u043B\u0438 \u0441\u043E\u0437\u0434\u0430\u0439\u0442\u0435 \u0447\u0435\u0440\u0435\u0437 /new), \u0437\u0430\u0442\u0435\u043C \u0441\u043C\u043E\u0442\u0440\u0438\u0442\u0435 \u0435\u0451 \u0437\u0430\u0434\u0430\u0447\u0438 \u043A\u043E\u043C\u0430\u043D\u0434\u043E\u0439 /curTasks."],
  ["\u5F53\u524D\u4F1A\u8BDD\u6682\u65E0\u4EFB\u52A1\u5217\u8868\u3002", "\u0423 \u0442\u0435\u043A\u0443\u0449\u0435\u0439 \u0441\u0435\u0441\u0441\u0438\u0438 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442 \u0441\u043F\u0438\u0441\u043A\u0430 \u0437\u0430\u0434\u0430\u0447."],
  // console.ts — /preset
  ["\u6CA1\u6709\u627E\u5230\u6A21\u5F0F ${rawTarget}\u3002\u53D1\u9001 /preset \u67E5\u770B\u53EF\u9009\u6A21\u5F0F\u3002", "\u0420\u0435\u0436\u0438\u043C ${rawTarget} \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D. \u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /preset, \u0447\u0442\u043E\u0431\u044B \u0443\u0432\u0438\u0434\u0435\u0442\u044C \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B\u0435 \u0440\u0435\u0436\u0438\u043C\u044B."],
  ["\u6682\u5B58\u6A21\u5F0F\u300C${label}\u300D\uFF1A\u4E0B\u4E00\u6B21 /new \u521B\u5EFA\u4F1A\u8BDD\u65F6\u751F\u6548\u3002", "\u0420\u0435\u0436\u0438\u043C \xAB${label}\xBB \u043E\u0442\u043B\u043E\u0436\u0435\u043D: \u043F\u0440\u0438\u043C\u0435\u043D\u0438\u0442\u0441\u044F \u043F\u0440\u0438 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u043C /new."],
  ["\u2705 \u5DF2\u5207\u6362\u4F1A\u8BDD\u6A21\u5F0F\u4E3A\u300C${label}\u300D\u3002", "\u2705 \u0420\u0435\u0436\u0438\u043C \u0441\u0435\u0441\u0441\u0438\u0438 \u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0451\u043D \u043D\u0430 \xAB${label}\xBB."],
  ["\u5F53\u524D\u4F1A\u8BDD\u5DF2\u5F00\u59CB\uFF0C\u6A21\u5F0F\u5DF2\u56FA\u5B9A\u3002\u5DF2\u6682\u5B58\u300C${label}\u300D\uFF1A\u4E0B\u4E00\u6B21 /new \u521B\u5EFA\u4F1A\u8BDD\u65F6\u751F\u6548\u3002", "\u0422\u0435\u043A\u0443\u0449\u0430\u044F \u0441\u0435\u0441\u0441\u0438\u044F \u0443\u0436\u0435 \u043D\u0430\u0447\u0430\u0442\u0430, \u0440\u0435\u0436\u0438\u043C \u0437\u0430\u0444\u0438\u043A\u0441\u0438\u0440\u043E\u0432\u0430\u043D. \xAB${label}\xBB \u043E\u0442\u043B\u043E\u0436\u0435\u043D: \u043F\u0440\u0438\u043C\u0435\u043D\u0438\u0442\u0441\u044F \u043F\u0440\u0438 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u043C /new."],
  ["\u6B64\u90E8\u7F72\u672A\u914D\u7F6E\u9884\u8BBE\u6A21\u5F0F\u3002", "\u0412 \u044D\u0442\u043E\u0439 \u0443\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0435 \u043F\u0440\u0435\u0441\u0435\u0442\u044B \u043D\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D\u044B."],
  ["\u{1F39B} \u9009\u62E9\u4F1A\u8BDD\u6A21\u5F0F\uFF1A\n\n\u70B9\u6309\u94AE\u9009\u62E9\uFF0C\u6216\u53D1\u9001 /preset <\u6A21\u5F0F\u540D> \u76F4\u63A5\u6307\u5B9A\u3002\u7ED1\u5B9A\u4F1A\u8BDD\u672A\u5F00\u59CB\u65F6\u7ACB\u5373\u751F\u6548\uFF1B\u5DF2\u5F00\u59CB\u6216\u672A\u7ED1\u5B9A\u65F6\u6682\u5B58\u7ED9\u4E0B\u4E00\u6B21 /new\u3002", "\u{1F39B} \u0412\u044B\u0431\u043E\u0440 \u0440\u0435\u0436\u0438\u043C\u0430 \u0441\u0435\u0441\u0441\u0438\u0438:\n\n\u041D\u0430\u0436\u043C\u0438\u0442\u0435 \u043A\u043D\u043E\u043F\u043A\u0443 \u0438\u043B\u0438 \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /preset <\u0438\u043C\u044F \u0440\u0435\u0436\u0438\u043C\u0430>. \u0414\u043B\u044F \u043D\u0435\u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043D\u043D\u043E\u0439 \u0441\u0435\u0441\u0441\u0438\u0438 \u043F\u0440\u0438\u043C\u0435\u043D\u0438\u0442\u0441\u044F \u0441\u0440\u0430\u0437\u0443; \u0435\u0441\u043B\u0438 \u0441\u0435\u0441\u0441\u0438\u044F \u043D\u0430\u0447\u0430\u0442\u0430 \u0438\u043B\u0438 \u043D\u0435 \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043D\u0430 \u2014 \u043E\u0442\u043B\u043E\u0436\u0438\u0442\u0441\u044F \u0434\u043E \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E /new."],
  ["\n\n\u5DF2\u6682\u5B58\uFF1A${staged?.name ?? staged?.id ?? state.nextPreset}\uFF08\u4E0B\u4E00\u6B21 /new \u751F\u6548\uFF09", "\n\n\u041E\u0442\u043B\u043E\u0436\u0435\u043D\u043E: ${staged?.name ?? staged?.id ?? state.nextPreset} (\u043F\u0440\u0438\u043C\u0435\u043D\u0438\u0442\u0441\u044F \u043F\u0440\u0438 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u043C /new)"],
  // console.ts — misc replies and /start help
  ["\u6CA1\u6709\u6253\u5F00\u7684\u4F1A\u8BDD\u3002\u5E26\u53C2\u6570\u4F7F\u7528 /${verb} <\u5E8F\u53F7|id> \u6307\u5B9A\u4F1A\u8BDD\u3002", "\u041E\u0442\u043A\u0440\u044B\u0442\u044B\u0445 \u0441\u0435\u0441\u0441\u0438\u0439 \u043D\u0435\u0442. \u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u0441\u0435\u0441\u0441\u0438\u044E \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u043E\u043C: /${verb} <\u043D\u043E\u043C\u0435\u0440|id>."],
  ["\u5E8F\u53F7 ${index} \u8D85\u51FA\u8303\u56F4\uFF1A\u5148 /attach \u5237\u65B0\u5217\u8868", "\u041D\u043E\u043C\u0435\u0440 ${index} \u0432\u043D\u0435 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D\u0430: \u043E\u0431\u043D\u043E\u0432\u0438\u0442\u0435 \u0441\u043F\u0438\u0441\u043E\u043A \u043A\u043E\u043C\u0430\u043D\u0434\u043E\u0439 /attach"],
  ["\u7F3A\u5C11\u4F1A\u8BDD\u53C2\u6570\uFF08<\u5E8F\u53F7|id>\uFF09\u3002", "\u041D\u0435 \u0443\u043A\u0430\u0437\u0430\u043D \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442 \u0441\u0435\u0441\u0441\u0438\u0438 (<\u043D\u043E\u043C\u0435\u0440|id>)."],
  ["\u{1F916} dsh \u4F1A\u8BDD\u9065\u63A7\u53F0", "\u{1F916} \u041F\u0443\u043B\u044C\u0442 \u0441\u0435\u0441\u0441\u0438\u0439 dsh"],
  ["/attach [\u5E8F\u53F7|id|none|arc] \u2014 \u7ED1\u5B9A\u4F1A\u8BDD\u5E76\u663E\u793A\u6700\u8FD1 ${ATTACH_ROUNDS} \u8F6E\u5BF9\u8BDD\uFF1A\u65E0\u53C2\u6570\u9009\u5DE5\u4F5C\u533A/\u672A\u5206\u7EC4/\u5F52\u6863\uFF1Bnone=\u672A\u5206\u7EC4\uFF1Barc=\u5F52\u6863\uFF1B\u5E8F\u53F7=\u5F53\u524D\u8303\u56F4\u91CC\u7684\u4F1A\u8BDD", "/attach [\u043D\u043E\u043C\u0435\u0440|id|none|arc] \u2014 \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u0442\u044C \u0441\u0435\u0441\u0441\u0438\u044E \u0438 \u043F\u043E\u043A\u0430\u0437\u0430\u0442\u044C \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0435 ${ATTACH_ROUNDS} \u0440\u0430\u0443\u043D\u0434\u0430 \u0434\u0438\u0430\u043B\u043E\u0433\u0430: \u0431\u0435\u0437 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u043E\u0432 \u2014 \u0432\u044B\u0431\u043E\u0440 \u0440\u0430\u0431\u043E\u0447\u0435\u0439 \u043E\u0431\u043B\u0430\u0441\u0442\u0438/\u0431\u0435\u0437 \u0433\u0440\u0443\u043F\u043F\u044B/\u0430\u0440\u0445\u0438\u0432\u0430; none \u2014 \u0431\u0435\u0437 \u0433\u0440\u0443\u043F\u043F\u044B; arc \u2014 \u0430\u0440\u0445\u0438\u0432; \u043D\u043E\u043C\u0435\u0440 \u2014 \u0441\u0435\u0441\u0441\u0438\u044F \u0438\u0437 \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E \u0441\u043F\u0438\u0441\u043A\u0430"],
  ["/create \u2014 \u521B\u5EFA\u4F1A\u8BDD\u83DC\u5355\uFF1A\u4E0B\u4E00\u7EA7\u4E3A /new\uFF08\u65B0\u5EFA\uFF09\u4E0E /fork\uFF08\u5206\u53C9\uFF09", "/create \u2014 \u043C\u0435\u043D\u044E \u0441\u043E\u0437\u0434\u0430\u043D\u0438\u044F \u0441\u0435\u0441\u0441\u0438\u0438: \u0434\u0430\u043B\u0435\u0435 /new (\u043D\u043E\u0432\u0430\u044F) \u0438 /fork (\u0444\u043E\u0440\u043A)"],
  ["/operate \u2014 \u64CD\u4F5C\u4F1A\u8BDD\u83DC\u5355\uFF1A\u4E0B\u4E00\u7EA7\u4E3A /archive\uFF08\u5F52\u6863\uFF09\u3001/stop\uFF08\u505C\u6B62\uFF09\u3001/curTasks\uFF08\u4EFB\u52A1\u5217\u8868\uFF09", "/operate \u2014 \u043C\u0435\u043D\u044E \u043E\u043F\u0435\u0440\u0430\u0446\u0438\u0439 \u0441 \u0441\u0435\u0441\u0441\u0438\u0435\u0439: \u0434\u0430\u043B\u0435\u0435 /archive (\u0430\u0440\u0445\u0438\u0432), /stop (\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0430), /curTasks (\u0437\u0430\u0434\u0430\u0447\u0438)"],
  ["/new [\u8DEF\u5F84|\u5E8F\u53F7|none] \u2014 \u521B\u5EFA\u4F1A\u8BDD\uFF1A\u65E0\u53C2\u6570\u5F39\u51FA\u5DE5\u4F5C\u533A\u9009\uFF1Bnone=\u672A\u5206\u7C7B\uFF1B\u5E8F\u53F7=\u5DE5\u4F5C\u533A\uFF1B\u8DEF\u5F84=\u670D\u52A1\u5668\u76EE\u5F55\u81EA\u52A8\u6CE8\u518C", "/new [\u043F\u0443\u0442\u044C|\u043D\u043E\u043C\u0435\u0440|none] \u2014 \u0441\u043E\u0437\u0434\u0430\u0442\u044C \u0441\u0435\u0441\u0441\u0438\u044E: \u0431\u0435\u0437 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u043E\u0432 \u2014 \u0432\u044B\u0431\u043E\u0440 \u0440\u0430\u0431\u043E\u0447\u0435\u0439 \u043E\u0431\u043B\u0430\u0441\u0442\u0438; none \u2014 \u0431\u0435\u0437 \u043E\u0431\u043B\u0430\u0441\u0442\u0438; \u043D\u043E\u043C\u0435\u0440 \u2014 \u0440\u0430\u0431\u043E\u0447\u0430\u044F \u043E\u0431\u043B\u0430\u0441\u0442\u044C; \u043F\u0443\u0442\u044C \u2014 \u043A\u0430\u0442\u0430\u043B\u043E\u0433 \u043D\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u0435 (\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u0443\u0435\u0442\u0441\u044F \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438)"],
  ["/fork [\u5E8F\u53F7|id] \u2014 \u5206\u53C9\u4F1A\u8BDD\uFF1A\u4ECE\u6700\u540E\u4E00\u4E2A\u5DF2\u5B8C\u6210\u56DE\u5408\u5F00\u65B0\u4F1A\u8BDD\u5E76\u7ED1\u5B9A\uFF08\u65E0\u53C2\u6570\u4F5C\u7528\u4E8E\u5F53\u524D\u7ED1\u5B9A\uFF09", "/fork [\u043D\u043E\u043C\u0435\u0440|id] \u2014 \u0444\u043E\u0440\u043A \u0441\u0435\u0441\u0441\u0438\u0438: \u043D\u043E\u0432\u0430\u044F \u0441\u0435\u0441\u0441\u0438\u044F \u0441 \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0435\u0433\u043E \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043D\u043D\u043E\u0433\u043E \u0440\u0430\u0443\u043D\u0434\u0430 (\u0431\u0435\u0437 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u043E\u0432 \u2014 \u0442\u0435\u043A\u0443\u0449\u0430\u044F \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043D\u043D\u0430\u044F)"],
  ["/archive [\u5E8F\u53F7|id] \u2014 \u5F52\u6863\u4F1A\u8BDD\u52A0\u5165\u5F52\u6863\u533A\uFF08\u65E0\u53C2\u6570\u4F5C\u7528\u4E8E\u5F53\u524D\u4F1A\u8BDD\uFF1B\u9700\u518D\u6B21\u53D1\u9001 /archive \u786E\u8BA4\uFF09", "/archive [\u043D\u043E\u043C\u0435\u0440|id] \u2014 \u043F\u0435\u0440\u0435\u043D\u0435\u0441\u0442\u0438 \u0441\u0435\u0441\u0441\u0438\u044E \u0432 \u0430\u0440\u0445\u0438\u0432 (\u0431\u0435\u0437 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u043E\u0432 \u2014 \u0442\u0435\u043A\u0443\u0449\u0430\u044F; \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u043D\u044B\u043C /archive)"],
  ["/delete [\u5E8F\u53F7|id] \u2014 \u5220\u9664\uFF08\u5F52\u6863\uFF09\u4F1A\u8BDD\uFF0C\u65E0\u53C2\u6570\u5F39\u51FA\u9009\u62E9", "/delete [\u043D\u043E\u043C\u0435\u0440|id] \u2014 \u0443\u0434\u0430\u043B\u0438\u0442\u044C (\u0430\u0440\u0445\u0438\u0432\u0438\u0440\u043E\u0432\u0430\u0442\u044C) \u0441\u0435\u0441\u0441\u0438\u044E; \u0431\u0435\u0437 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u043E\u0432 \u2014 \u0432\u044B\u0431\u043E\u0440 \u0438\u0437 \u0441\u043F\u0438\u0441\u043A\u0430"],
  ["/stop \u2014 \u505C\u6B62\u8FDB\u884C\u4E2D\u7684\u56DE\u5408\uFF08\u4F5C\u7528\u4E8E\u5F53\u524D\u7ED1\u5B9A\u4F1A\u8BDD\uFF1B\u672A\u7ED1\u5B9A\u4F1A\u8BDD\u65F6\u70B9\u4E0B\u65B9\u6309\u94AE\u9009\u62E9\uFF09", "/stop \u2014 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C \u0442\u0435\u043A\u0443\u0449\u0438\u0439 \u0440\u0430\u0443\u043D\u0434 (\u0434\u043B\u044F \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043D\u043D\u043E\u0439 \u0441\u0435\u0441\u0441\u0438\u0438; \u0435\u0441\u043B\u0438 \u0441\u0435\u0441\u0441\u0438\u044F \u043D\u0435 \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043D\u0430 \u2014 \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043A\u043D\u043E\u043F\u043A\u043E\u0439 \u043D\u0438\u0436\u0435)"],
  ["/status [\u5E8F\u53F7|id] \u2014 \u4F1A\u8BDD\u8BE6\u60C5\uFF08\u65E0\u53C2\u6570\u4F5C\u7528\u4E8E\u5F53\u524D\u4F1A\u8BDD\uFF1B\u672A\u7ED1\u5B9A\u4F1A\u8BDD\u65F6\u70B9\u4E0B\u65B9\u6309\u94AE\u9009\u62E9\uFF09", "/status [\u043D\u043E\u043C\u0435\u0440|id] \u2014 \u0434\u0435\u0442\u0430\u043B\u0438 \u0441\u0435\u0441\u0441\u0438\u0438 (\u0431\u0435\u0437 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u043E\u0432 \u2014 \u0442\u0435\u043A\u0443\u0449\u0430\u044F; \u0435\u0441\u043B\u0438 \u0441\u0435\u0441\u0441\u0438\u044F \u043D\u0435 \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043D\u0430 \u2014 \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043A\u043D\u043E\u043F\u043A\u043E\u0439 \u043D\u0438\u0436\u0435)"],
  ["/model [\u6A21\u578B\u540D] \u2014 \u8BBE\u7F6E\u5168\u5C40\u9ED8\u8BA4\u6A21\u578B\uFF08\u65E0\u53C2\u6570\u5F39\u51FA\u6A21\u578B\u952E\u76D8\u9009\u62E9\uFF09", "/model [\u0438\u043C\u044F \u043C\u043E\u0434\u0435\u043B\u0438] \u2014 \u0437\u0430\u0434\u0430\u0442\u044C \u0433\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u0443\u044E \u043C\u043E\u0434\u0435\u043B\u044C \u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E (\u0431\u0435\u0437 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u043E\u0432 \u2014 \u0432\u044B\u0431\u043E\u0440 \u0438\u0437 \u043A\u043B\u0430\u0432\u0438\u0430\u0442\u0443\u0440\u044B)"],
  ["/rename [\u6807\u9898] \u2014 \u91CD\u547D\u540D\u4F1A\u8BDD\uFF1A\u65E0\u53C2\u6570\u4EA4\u4E92\u8F93\u5165\u6807\u9898\uFF08\u4F5C\u7528\u4E8E\u5F53\u524D\u7ED1\u5B9A\u4F1A\u8BDD\uFF09\uFF1B<\u5E8F\u53F7|id> <\u6807\u9898> \u6307\u5B9A\u4F1A\u8BDD", "/rename [\u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A] \u2014 \u043F\u0435\u0440\u0435\u0438\u043C\u0435\u043D\u043E\u0432\u0430\u0442\u044C \u0441\u0435\u0441\u0441\u0438\u044E: \u0431\u0435\u0437 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u043E\u0432 \u2014 \u0432\u0432\u043E\u0434 \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043A\u0430 (\u0434\u043B\u044F \u0442\u0435\u043A\u0443\u0449\u0435\u0439 \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043D\u043D\u043E\u0439); <\u043D\u043E\u043C\u0435\u0440|id> <\u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A> \u2014 \u0443\u043A\u0430\u0437\u0430\u0442\u044C \u0441\u0435\u0441\u0441\u0438\u044E"],
  ["/curTasks \u2014 \u67E5\u770B\u5F53\u524D\u4F1A\u8BDD\u7684\u4EFB\u52A1\u5217\u8868\uFF08\u4E0E Web \u4FA7\u680F\u4EFB\u52A1\u540C\u6E90\uFF09", "/curTasks \u2014 \u0441\u043F\u0438\u0441\u043E\u043A \u0437\u0430\u0434\u0430\u0447 \u0442\u0435\u043A\u0443\u0449\u0435\u0439 \u0441\u0435\u0441\u0441\u0438\u0438 (\u0442\u043E\u0442 \u0436\u0435 \u0438\u0441\u0442\u043E\u0447\u043D\u0438\u043A, \u0447\u0442\u043E \u0438 \u0437\u0430\u0434\u0430\u0447\u0438 \u0432 \u0432\u0435\u0431-\u043F\u0430\u043D\u0435\u043B\u0438)"],
  ["/preset [\u6A21\u5F0F\u540D|\u5E8F\u53F7] \u2014 \u9009\u62E9\u4F1A\u8BDD\u6A21\u5F0F\uFF08PTC/\u6807\u51C6/\u6781\u7B80/\u521B\u9020\u9884\u8BBE\uFF09\uFF1A\u65E0\u53C2\u6570\u5F39\u51FA\u9884\u8BBE\u952E\u76D8\uFF1B\u5DF2\u5F00\u59CB\u4F1A\u8BDD\u4F1A\u6682\u5B58\u5230\u4E0B\u4E00\u6B21 /new", "/preset [\u0438\u043C\u044F \u0440\u0435\u0436\u0438\u043C\u0430|\u043D\u043E\u043C\u0435\u0440] \u2014 \u0432\u044B\u0431\u0440\u0430\u0442\u044C \u0440\u0435\u0436\u0438\u043C \u0441\u0435\u0441\u0441\u0438\u0438 (\u043F\u0440\u0435\u0441\u0435\u0442\u044B PTC/\u0441\u0442\u0430\u043D\u0434\u0430\u0440\u0442\u043D\u044B\u0439/\u043C\u0438\u043D\u0438\u043C\u0430\u043B\u044C\u043D\u044B\u0439/\u0442\u0432\u043E\u0440\u0447\u0435\u0441\u043A\u0438\u0439): \u0431\u0435\u0437 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u043E\u0432 \u2014 \u043A\u043B\u0430\u0432\u0438\u0430\u0442\u0443\u0440\u0430 \u043F\u0440\u0435\u0441\u0435\u0442\u043E\u0432; \u0434\u043B\u044F \u043D\u0430\u0447\u0430\u0442\u043E\u0439 \u0441\u0435\u0441\u0441\u0438\u0438 \u043E\u0442\u043B\u043E\u0436\u0438\u0442\u0441\u044F \u0434\u043E \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E /new"],
  ["/close \u2014 \u6536\u8D77\u5FEB\u6377\u952E\u76D8\uFF08\u9700\u518D\u6B21\u53D1\u9001 /close \u786E\u8BA4\uFF1B\u4F1A\u8BDD\u7ED1\u5B9A\u4E0D\u53D8\uFF09", "/close \u2014 \u0441\u043A\u0440\u044B\u0442\u044C \u043A\u043B\u0430\u0432\u0438\u0430\u0442\u0443\u0440\u0443 (\u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u043D\u044B\u043C /close; \u043F\u0440\u0438\u0432\u044F\u0437\u043A\u0430 \u0441\u0435\u0441\u0441\u0438\u0438 \u043D\u0435 \u0438\u0437\u043C\u0435\u043D\u0438\u0442\u0441\u044F)"],
  ["\u4F1A\u8BDD/\u5DE5\u4F5C\u533A\u5217\u8868\u4E0B\u65B9\u4F1A\u51FA\u73B0\u5FEB\u6377\u952E\u76D8\uFF1A\u70B9\u6309\u94AE = \u81EA\u52A8\u53D1\u9001\u5BF9\u5E94\u547D\u4EE4\uFF0C\u65E0\u9700\u590D\u5236 id\u3002", "\u041F\u043E\u0434 \u0441\u043F\u0438\u0441\u043A\u043E\u043C \u0441\u0435\u0441\u0441\u0438\u0439 \u0438 \u0440\u0430\u0431\u043E\u0447\u0438\u0445 \u043E\u0431\u043B\u0430\u0441\u0442\u0435\u0439 \u043F\u043E\u044F\u0432\u0438\u0442\u0441\u044F \u043A\u043B\u0430\u0432\u0438\u0430\u0442\u0443\u0440\u0430: \u043D\u0430\u0436\u0430\u0442\u0438\u0435 \u043A\u043D\u043E\u043F\u043A\u0438 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u0435\u0442 \u043A\u043E\u043C\u0430\u043D\u0434\u0443 \u2014 \u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u0442\u044C id \u043D\u0435 \u043D\u0443\u0436\u043D\u043E."],
  ["/ \u547D\u4EE4\u83DC\u5355\u4ECE /keyboard \u5F00\u59CB\uFF08\u4E00\u952E\u5524\u9192\u952E\u76D8\u533A\uFF09\uFF0C\u63A5\u7740 /attach\uFF08\u7ED1\u5B9A\u5165\u53E3\uFF09\uFF0C\u5176\u4F59\u53EA\u4FDD\u7559\u952E\u76D8\u4E0A\u6CA1\u6709\u7684\u547D\u4EE4\uFF1A/status\u3001/model\u3001/delete\u3001/rename\u3001/preset\u3001/start\u3002", "\u041C\u0435\u043D\u044E \u043A\u043E\u043C\u0430\u043D\u0434 \u043D\u0430\u0447\u0438\u043D\u0430\u0435\u0442\u0441\u044F \u0441 /keyboard (\u0432\u043A\u043B\u044E\u0447\u0430\u0435\u0442 \u043A\u043B\u0430\u0432\u0438\u0430\u0442\u0443\u0440\u0443), \u0437\u0430\u0442\u0435\u043C /attach (\u043F\u0440\u0438\u0432\u044F\u0437\u043A\u0430); \u043E\u0441\u0442\u0430\u043B\u044C\u043D\u044B\u0435 \u043A\u043E\u043C\u0430\u043D\u0434\u044B \u0442\u043E\u043B\u044C\u043A\u043E \u0442\u0435, \u043A\u043E\u0442\u043E\u0440\u044B\u0445 \u043D\u0435\u0442 \u043D\u0430 \u043A\u043B\u0430\u0432\u0438\u0430\u0442\u0443\u0440\u0435: /status, /model, /delete, /rename, /preset, /start."],
  ["\u8FD0\u884C /attach\u3001/status\u3001/stop \u7B49\u4E0D\u5E26\u952E\u76D8\u7684\u547D\u4EE4\u540E\uFF0C\u5FEB\u6377\u952E\u76D8\u4F1A\u56DE\u5230\u5E38\u7528\u64CD\u4F5C\u884C\uFF08/create /archive /attach /close\uFF09\u3002", "\u041F\u043E\u0441\u043B\u0435 \u043A\u043E\u043C\u0430\u043D\u0434 \u0431\u0435\u0437 \u043A\u043B\u0430\u0432\u0438\u0430\u0442\u0443\u0440\u044B (/attach, /status, /stop \u0438 \u0442. \u043F.) \u043A\u043B\u0430\u0432\u0438\u0430\u0442\u0443\u0440\u0430 \u0432\u043E\u0437\u0432\u0440\u0430\u0449\u0430\u0435\u0442\u0441\u044F \u043A \u0447\u0430\u0441\u0442\u044B\u043C \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044F\u043C (/create /archive /attach /close)."],
  ["\u7ED1\u5B9A\u4F1A\u8BDD\u540E\uFF0Cagent \u7684\u56DE\u590D\u4F1A\u5B9E\u65F6\u63A8\u9001\u5230\u8FD9\u91CC\u3002", "\u041F\u043E\u0441\u043B\u0435 \u043F\u0440\u0438\u0432\u044F\u0437\u043A\u0438 \u0441\u0435\u0441\u0441\u0438\u0438 \u043E\u0442\u0432\u0435\u0442\u044B \u0430\u0433\u0435\u043D\u0442\u0430 \u0431\u0443\u0434\u0443\u0442 \u043F\u0440\u0438\u0445\u043E\u0434\u0438\u0442\u044C \u0441\u044E\u0434\u0430 \u0432 \u0440\u0435\u0430\u043B\u044C\u043D\u043E\u043C \u0432\u0440\u0435\u043C\u0435\u043D\u0438."],
  ["\u4EE5 / \u5F00\u5934\u7684\u6D88\u606F\u662F\u547D\u4EE4\uFF1B\u8981\u7528 / \u5F00\u5934\u7684\u5185\u5BB9\u53D1\u7ED9 harness\uFF0C", "\u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F, \u043D\u0430\u0447\u0438\u043D\u0430\u044E\u0449\u0438\u0435\u0441\u044F \u0441 /, \u2014 \u044D\u0442\u043E \u043A\u043E\u043C\u0430\u043D\u0434\u044B; \u0447\u0442\u043E\u0431\u044B \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u0432 harness \u0442\u0435\u043A\u0441\u0442, \u043D\u0430\u0447\u0438\u043D\u0430\u044E\u0449\u0438\u0439\u0441\u044F \u0441 /,"],
  ["\u8BF7\u5728\u524D\u9762\u52A0 \\ \u8F6C\u4E49\uFF08\u5982 \\/model\uFF09\u3002", "\u043F\u043E\u0441\u0442\u0430\u0432\u044C\u0442\u0435 \u043F\u0435\u0440\u0435\u0434 \u043D\u0438\u043C \\ (\u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440, \\/model)."],
  // render.ts — headers, legend, age, tokens
  ["/new none \xB7 \u672A\u5206\u7C7B", "/new none \xB7 \u0431\u0435\u0437 \u043E\u0431\u043B\u0430\u0441\u0442\u0438"],
  ["\u{1F7E2} \u6267\u884C\u4E2D \xB7 \u2705 \u5DF2\u5B8C\u6210 \xB7 \u26AA \u672A\u5F00\u59CB", "\u{1F7E2} \u0412\u044B\u043F\u043E\u043B\u043D\u044F\u0435\u0442\u0441\u044F \xB7 \u2705 \u0417\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u043E \xB7 \u26AA \u041D\u0435 \u043D\u0430\u0447\u0430\u0442\u043E"],
  ["\n\n\u23F3 \u56DE\u590D\u4E2D\u2026", "\n\n\u23F3 \u041E\u0442\u0432\u0435\u0447\u0430\u0435\u0442\u2026"],
  ["\u521A\u521A", "\u0442\u043E\u043B\u044C\u043A\u043E \u0447\u0442\u043E"],
  ["${minutes} \u5206\u949F\u524D", "${minutes} \u043C\u0438\u043D. \u043D\u0430\u0437\u0430\u0434"],
  ["${hours} \u5C0F\u65F6\u524D", "${hours} \u0447. \u043D\u0430\u0437\u0430\u0434"],
  ["${Math.floor(hours / 24)} \u5929\u524D", "${Math.floor(hours / 24)} \u0434\u043D. \u043D\u0430\u0437\u0430\u0434"],
  ["\u7F13\u5B58\u547D\u4E2D ${hitRate}%", "\u041F\u043E\u043F\u0430\u0434\u0430\u043D\u0438\u0435 \u0432 \u043A\u044D\u0448 ${hitRate}%"],
  ["\u7F13\u5B58\u5199 ${compactTokenCount(usage.cacheWrite)}", "\u0417\u0430\u043F\u0438\u0441\u044C \u0432 \u043A\u044D\u0448 ${compactTokenCount(usage.cacheWrite)}"],
  ["\n\n<pre>\u26A1 \u672C\u8F6E: ${parts.join(' \xB7 ')}</pre>", "\n\n<pre>\u26A1 \u0420\u0430\u0443\u043D\u0434: ${parts.join(' \xB7 ')}</pre>"],
  // render.ts — session and workspace rows
  ["\uFF08\u65E0\u76EE\u5F55\uFF09", "(\u043D\u0435\u0442 \u043A\u0430\u0442\u0430\u043B\u043E\u0433\u0430)"],
  ["\uFF08\u7A7A\u767D\u4F1A\u8BDD\uFF0C\u8FD8\u6CA1\u6709\u6D88\u606F\uFF09", "(\u043F\u0443\u0441\u0442\u0430\u044F \u0441\u0435\u0441\u0441\u0438\u044F, \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442)"],
  ["\u{1F527} \u5DE5\u5177\u8C03\u7528\u4E2D: ${pending}", "\u{1F527} \u0412\u044B\u0437\u043E\u0432 \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0430: ${pending}"],
  ["\uFF08\u6682\u65E0\u8F93\u51FA\uFF09", "(\u0432\u044B\u0432\u043E\u0434\u0430 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442)"],
  ["${index}) \u{1F4C1} ${truncate(workspace.title, SESSION_TITLE_MAX)}\n   ${workspace.path} \xB7 ${workspace.sessionIds.length} \u4E2A\u4F1A\u8BDD", "${index}) \u{1F4C1} ${truncate(workspace.title, SESSION_TITLE_MAX)}\n   ${workspace.path} \xB7 \u0441\u0435\u0441\u0441\u0438\u0439: ${workspace.sessionIds.length}"],
  ["\u{1F4CB} \u4EFB\u52A1 ${done} \u5DF2\u5B8C\u6210 \xB7 ${active} \u8FDB\u884C\u4E2D \xB7 ${pending} \u5F85\u5904\u7406\n\n${body}", "\u{1F4CB} \u0417\u0430\u0434\u0430\u0447\u0438: ${done} \u0433\u043E\u0442\u043E\u0432\u043E \xB7 ${active} \u0432 \u0440\u0430\u0431\u043E\u0442\u0435 \xB7 ${pending} \u0432 \u043E\u0447\u0435\u0440\u0435\u0434\u0438\n\n${body}"],
  ["\u672A\u5206\u7EC4", "\u0411\u0435\u0437 \u0433\u0440\u0443\u043F\u043F\u044B"],
  ["\u5F52\u6863", "\u0410\u0440\u0445\u0438\u0432"],
  // render.ts — question cards
  ["\u2705 \u63D0\u4EA4\u56DE\u7B54", "\u2705 \u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u043E\u0442\u0432\u0435\u0442"],
  ["\u{1F6AB} \u53D6\u6D88", "\u{1F6AB} \u041E\u0442\u043C\u0435\u043D\u0430"],
  ["\u270D\uFE0F \u81EA\u5B9A\u4E49\u56DE\u7B54", "\u270D\uFE0F \u0421\u0432\u043E\u0439 \u043E\u0442\u0432\u0435\u0442"],
  ["\u270D\uFE0F \u91CD\u65B0\u8F93\u5165\u56DE\u7B54", "\u270D\uFE0F \u0412\u0432\u0435\u0441\u0442\u0438 \u043E\u0442\u0432\u0435\u0442 \u0437\u0430\u043D\u043E\u0432\u043E"],
  ["\uFF08\u53EF\u591A\u9009\uFF09", "(\u043C\u043E\u0436\u043D\u043E \u043D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u043E)"],
  ["\n\n\u5168\u90E8\u56DE\u7B54\u540E\u70B9\u300C\u2705 \u63D0\u4EA4\u56DE\u7B54\u300D\u3002", "\n\n\u041E\u0442\u0432\u0435\u0442\u0438\u0432 \u043D\u0430 \u0432\u0441\u0435 \u0432\u043E\u043F\u0440\u043E\u0441\u044B, \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \xAB\u2705 \u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u043E\u0442\u0432\u0435\u0442\xBB."],
  ["\u270D\uFE0F \u91CD\u8F93 Q${questionIndex + 1}", "\u270D\uFE0F \u0417\u0430\u043D\u043E\u0432\u043E Q${questionIndex + 1}"],
  ["\u270D\uFE0F \u81EA\u5B9A\u4E49 Q${questionIndex + 1}", "\u270D\uFE0F \u0421\u0432\u043E\u0439 \u043E\u0442\u0432\u0435\u0442 Q${questionIndex + 1}"],
  // index.ts — access, command descriptions, question errors
  ["\u26D4 \u65E0\u6743\u8BBF\u95EE\u3002", "\u26D4 \u0414\u043E\u0441\u0442\u0443\u043F \u0437\u0430\u043F\u0440\u0435\u0449\u0451\u043D."],
  ["\u5524\u9192/\u5237\u65B0\u4E0B\u65B9\u952E\u76D8\u533A\uFF08\u6062\u590D\u5E38\u7528\u547D\u4EE4\u6309\u94AE\u4E0E\u8FD0\u884C\u4E2D\u4F1A\u8BDD\u7684\u5FEB\u6377\u7ED1\u5B9A\uFF09", "\u041F\u043E\u043A\u0430\u0437\u0430\u0442\u044C/\u043E\u0431\u043D\u043E\u0432\u0438\u0442\u044C \u043A\u043B\u0430\u0432\u0438\u0430\u0442\u0443\u0440\u0443 \u043D\u0438\u0436\u0435 (\u0432\u0435\u0440\u043D\u0443\u0442\u044C \u043A\u043D\u043E\u043F\u043A\u0438 \u0447\u0430\u0441\u0442\u044B\u0445 \u043A\u043E\u043C\u0430\u043D\u0434 \u0438 \u0431\u044B\u0441\u0442\u0440\u0443\u044E \u043F\u0440\u0438\u0432\u044F\u0437\u043A\u0443 \u0437\u0430\u043F\u0443\u0449\u0435\u043D\u043D\u044B\u0445 \u0441\u0435\u0441\u0441\u0438\u0439)"],
  ["\u9009\u62E9\u4F1A\u8BDD\u5E76\u7ED1\u5B9A\uFF08<\u5E8F\u53F7|id|none|arc>\uFF1B\u4F1A\u8BDD\u5217\u8868\u65F6\u952E\u76D8\u533A\u53EF\u76F4\u63A5\u70B9\u9009\uFF09", "\u0412\u044B\u0431\u0440\u0430\u0442\u044C \u0438 \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u0442\u044C \u0441\u0435\u0441\u0441\u0438\u044E (<\u043D\u043E\u043C\u0435\u0440|id|none|arc>; \u0432 \u0441\u043F\u0438\u0441\u043A\u0435 \u0441\u0435\u0441\u0441\u0438\u0439 \u043C\u043E\u0436\u043D\u043E \u043D\u0430\u0436\u0430\u0442\u044C \u043A\u043D\u043E\u043F\u043A\u0443)"],
  ["\u67E5\u770B\u4F1A\u8BDD\u8BE6\u60C5", "\u0414\u0435\u0442\u0430\u043B\u0438 \u0441\u0435\u0441\u0441\u0438\u0438"],
  ["\u8BBE\u7F6E\u5168\u5C40\u9ED8\u8BA4\u6A21\u578B\uFF08\u65E0\u53C2\u6570\u5F39\u51FA\u6A21\u578B\u5217\u8868\uFF09", "\u0417\u0430\u0434\u0430\u0442\u044C \u0433\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u0443\u044E \u043C\u043E\u0434\u0435\u043B\u044C \u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E (\u0431\u0435\u0437 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u043E\u0432 \u2014 \u0441\u043F\u0438\u0441\u043E\u043A \u043C\u043E\u0434\u0435\u043B\u0435\u0439)"],
  ["\u5220\u9664\uFF08\u5F52\u6863\uFF09\u4F1A\u8BDD <\u5E8F\u53F7|id>\uFF0C\u65E0\u53C2\u6570\u5F39\u51FA\u9009\u62E9", "\u0423\u0434\u0430\u043B\u0438\u0442\u044C (\u0430\u0440\u0445\u0438\u0432\u0438\u0440\u043E\u0432\u0430\u0442\u044C) \u0441\u0435\u0441\u0441\u0438\u044E <\u043D\u043E\u043C\u0435\u0440|id>; \u0431\u0435\u0437 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u043E\u0432 \u2014 \u0432\u044B\u0431\u043E\u0440 \u0438\u0437 \u0441\u043F\u0438\u0441\u043A\u0430"],
  ["\u91CD\u547D\u540D\u4F1A\u8BDD <\u6807\u9898>", "\u041F\u0435\u0440\u0435\u0438\u043C\u0435\u043D\u043E\u0432\u0430\u0442\u044C \u0441\u0435\u0441\u0441\u0438\u044E <\u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A>"],
  ["\u9009\u62E9\u4F1A\u8BDD\u6A21\u5F0F\uFF08PTC/\u6807\u51C6/\u6781\u7B80/\u521B\u9020\u7B49\u9884\u8BBE\uFF09<\u6A21\u5F0F\u540D|\u5E8F\u53F7>", "\u0412\u044B\u0431\u0440\u0430\u0442\u044C \u0440\u0435\u0436\u0438\u043C \u0441\u0435\u0441\u0441\u0438\u0438 (\u043F\u0440\u0435\u0441\u0435\u0442\u044B PTC/\u0441\u0442\u0430\u043D\u0434\u0430\u0440\u0442\u043D\u044B\u0439/\u043C\u0438\u043D\u0438\u043C\u0430\u043B\u044C\u043D\u044B\u0439/\u0442\u0432\u043E\u0440\u0447\u0435\u0441\u043A\u0438\u0439 \u0438 \u0434\u0440.) <\u0438\u043C\u044F \u0440\u0435\u0436\u0438\u043C\u0430|\u043D\u043E\u043C\u0435\u0440>"],
  ["\u663E\u793A\u5E2E\u52A9\u4E0E\u5168\u90E8\u547D\u4EE4", "\u041F\u043E\u043A\u0430\u0437\u0430\u0442\u044C \u0441\u043F\u0440\u0430\u0432\u043A\u0443 \u0438 \u0432\u0441\u0435 \u043A\u043E\u043C\u0430\u043D\u0434\u044B"],
  ["\u63D0\u95EE\u56DE\u7B54\u88AB\u62D2\u7EDD\uFF08${response.reason}\uFF09", "\u041E\u0442\u0432\u0435\u0442 \u043D\u0430 \u0432\u043E\u043F\u0440\u043E\u0441 \u043E\u0442\u043A\u043B\u043E\u043D\u0451\u043D (${response.reason})"],
  ["\u63D0\u95EE\u53D6\u6D88\u5931\u8D25\uFF08${response.reason}\uFF09", "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u0442\u043C\u0435\u043D\u0438\u0442\u044C \u0432\u043E\u043F\u0440\u043E\u0441 (${response.reason})"],
  ["\u5411 agent \u53D1\u6D88\u606F\uFF0C\u6216 /start \u67E5\u770B\u547D\u4EE4", "\u041D\u0430\u043F\u0438\u0448\u0438\u0442\u0435 \u0430\u0433\u0435\u043D\u0442\u0443 \u0438\u043B\u0438 \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /start, \u0447\u0442\u043E\u0431\u044B \u0443\u0432\u0438\u0434\u0435\u0442\u044C \u043A\u043E\u043C\u0430\u043D\u0434\u044B"],
  ["${DENIED_REPLY} \u5982\u9700\u8BBF\u95EE\uFF0C\u8BF7\u5C06 chat id ${chatId} \u52A0\u5165 allowChatIds \u767D\u540D\u5355\u3002", "${DENIED_REPLY} \u0414\u043B\u044F \u0434\u043E\u0441\u0442\u0443\u043F\u0430 \u0434\u043E\u0431\u0430\u0432\u044C\u0442\u0435 chat id ${chatId} \u0432 \u0431\u0435\u043B\u044B\u0439 \u0441\u043F\u0438\u0441\u043E\u043A allowChatIds."],
  // fragments — runtime text with already-interpolated values
  ["\u8BF7\u76F4\u63A5\u8F93\u5165\u5BF9\u300C", "\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043E\u0442\u0432\u0435\u0442 \u043D\u0430 \xAB"],
  ["\u300D\u7684\u56DE\u7B54\uFF08\u53D1\u9001\u6587\u672C\u5373\u53EF\uFF09\u3002", "\xBB \u0442\u0435\u043A\u0441\u0442\u043E\u043C (\u043F\u0440\u043E\u0441\u0442\u043E \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435)."],
  ["\u8FD8\u6709\u95EE\u9898\u300C", "\u041E\u0441\u0442\u0430\u043B\u0441\u044F \u0432\u043E\u043F\u0440\u043E\u0441 \xAB"],
  ["\u300D\u672A\u56DE\u7B54\uFF1A\u9009\u62E9\u9009\u9879\u6216\u70B9\u300C", "\xBB: \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0432\u0430\u0440\u0438\u0430\u043D\u0442 \u0438\u043B\u0438 \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \xAB"],
  ["\u5DF2\u8BB0\u5F55\u5BF9\u300C", "\u041E\u0442\u0432\u0435\u0442 \u043D\u0430 \xAB"],
  ["\u300D\u7684\u56DE\u7B54\uFF0C\u70B9\u300C", "\xBB \u0437\u0430\u043F\u0438\u0441\u0430\u043D; \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \xAB"],
  ["\u5DF2\u91CD\u547D\u540D\u4E3A ", "\u041F\u0435\u0440\u0435\u0438\u043C\u0435\u043D\u043E\u0432\u0430\u043D\u043E \u0432 "],
  ["\u5DF2\u52A0\u5165\u961F\u5217\uFF1A", "\u0414\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u043E \u0432 \u043E\u0447\u0435\u0440\u0435\u0434\u044C: "],
  ["\u672A\u77E5\u547D\u4EE4 /", "\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043A\u043E\u043C\u0430\u043D\u0434\u0430 /"],
  ["\u3002\u53D1\u9001 /start \u67E5\u770B\u53EF\u7528\u547D\u4EE4\u3002", ". \u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /start, \u0447\u0442\u043E\u0431\u044B \u0443\u0432\u0438\u0434\u0435\u0442\u044C \u0441\u043F\u0438\u0441\u043E\u043A \u043A\u043E\u043C\u0430\u043D\u0434."],
  ["\u5E8F\u53F7 ", "\u041D\u043E\u043C\u0435\u0440 "],
  ["\u5DE5\u4F5C\u533A\u5E8F\u53F7 ", "\u041D\u043E\u043C\u0435\u0440 \u0440\u0430\u0431\u043E\u0447\u0435\u0439 \u043E\u0431\u043B\u0430\u0441\u0442\u0438 "],
  [" \u8D85\u51FA\u8303\u56F4\uFF1A\u5148 /attach \u5237\u65B0\u5217\u8868", " \u0432\u043D\u0435 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D\u0430: \u043E\u0431\u043D\u043E\u0432\u0438\u0442\u0435 \u0441\u043F\u0438\u0441\u043E\u043A \u043A\u043E\u043C\u0430\u043D\u0434\u043E\u0439 /attach"],
  [" \u8D85\u51FA\u8303\u56F4\uFF1A\u5148 /attach \u5237\u65B0\u8303\u56F4\u5217\u8868", " \u0432\u043D\u0435 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D\u0430: \u043E\u0431\u043D\u043E\u0432\u0438\u0442\u0435 \u0441\u043F\u0438\u0441\u043E\u043A \u043A\u043E\u043C\u0430\u043D\u0434\u043E\u0439 /attach"],
  [" \u8D85\u51FA\u8303\u56F4\uFF1A\u53D1\u9001 /new \u91CD\u65B0\u770B\u770B\u5DE5\u4F5C\u533A\u5217\u8868", " \u0432\u043D\u0435 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D\u0430: \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /new, \u0447\u0442\u043E\u0431\u044B \u0441\u043D\u043E\u0432\u0430 \u0443\u0432\u0438\u0434\u0435\u0442\u044C \u0441\u043F\u0438\u0441\u043E\u043A"],
  ["\u{1F517} \u5DF2\u7ED1\u5B9A ", "\u{1F517} \u041F\u0440\u0438\u0432\u044F\u0437\u0430\u043D\u0430 "],
  ["\u6700\u8FD1 ", "\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0435 "],
  ["\u9009\u62E9\u4F1A\u8BDD\u8303\u56F4\uFF1A\u70B9\u4E0B\u65B9\u7684\u8303\u56F4\u6309\u94AE\uFF08\u6216 ", "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043E\u0431\u043B\u0430\u0441\u0442\u044C \u0441\u0435\u0441\u0441\u0438\u0439: \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \u043A\u043D\u043E\u043F\u043A\u0443 \u043D\u0438\u0436\u0435 (\u0438\u043B\u0438 "],
  ["\uFF09\uFF0C\u6216\u76F4\u63A5 /attach <\u4F1A\u8BDDid>\u3002", "), \u043B\u0438\u0431\u043E \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /attach <id \u0441\u0435\u0441\u0441\u0438\u0438>."],
  ["\uFF08\u6682\u65E0\u4F1A\u8BDD\uFF09", " (\u0441\u0435\u0441\u0441\u0438\u0439 \u043D\u0435\u0442)"],
  ["\u5DE5\u4F5C\u533A\u300C", "\u0420\u0430\u0431\u043E\u0447\u0430\u044F \u043E\u0431\u043B\u0430\u0441\u0442\u044C \xAB"],
  ["\u300D\u7684\u4F1A\u8BDD\uFF1A", "\xBB \u2014 \u0441\u0435\u0441\u0441\u0438\u0438:"],
  ["\u4F1A\u8BDD ", "\u0421\u0435\u0441\u0441\u0438\u044F "],
  [" \u4E0D\u5B58\u5728\u3002", " \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430."],
  ["\u7248\u672C: ", "\u0412\u0435\u0440\u0441\u0438\u044F: "],
  ["\u76EE\u5F55: ", "\u041A\u0430\u0442\u0430\u043B\u043E\u0433: "],
  ["\u66F4\u65B0: ", "\u041E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u043E: "],
  ["\u9884\u8BBE: ", "\u041F\u0440\u0435\u0441\u0435\u0442: "],
  ["\u6807\u9898: ", "\u0417\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A: "],
  ["\u6D88\u606F: \u7528\u6237 ", "\u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F: \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044C "],
  [" \xB7 \u52A9\u624B ", " \xB7 \u0430\u0441\u0441\u0438\u0441\u0442\u0435\u043D\u0442 "],
  [" \xB7 \u5DE5\u5177\u8C03\u7528 ", " \xB7 \u0432\u044B\u0437\u043E\u0432\u044B \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u043E\u0432 "],
  ["\u4E0A\u4E0B\u6587 ~", "\u041A\u043E\u043D\u0442\u0435\u043A\u0441\u0442: ~"],
  ["\uFF08\u8FD1 ", " (\u0437\u0430 \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0435 "],
  ["\u6CA1\u6709\u627E\u5230\u6A21\u578B ", "\u041C\u043E\u0434\u0435\u043B\u044C \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430: "],
  ["\u3002\u53D1\u9001 /model \u67E5\u770B\u53EF\u914D\u7F6E\u6A21\u578B\u5217\u8868\u3002", ". \u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /model, \u0447\u0442\u043E\u0431\u044B \u0443\u0432\u0438\u0434\u0435\u0442\u044C \u0441\u043F\u0438\u0441\u043E\u043A \u043C\u043E\u0434\u0435\u043B\u0435\u0439."],
  ["\u5DF2\u8BBE\u7F6E\u5168\u5C40\u9ED8\u8BA4\u6A21\u578B ", "\u0413\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u0430\u044F \u043C\u043E\u0434\u0435\u043B\u044C \u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E: "],
  ["\u90E8\u5206\u6A21\u578B\u52A0\u8F7D\u5931\u8D25\uFF1A", "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0447\u0430\u0441\u0442\u044C \u043C\u043E\u0434\u0435\u043B\u0435\u0439:"],
  ["\u8FD8\u6709 ", "\u0415\u0449\u0451 "],
  ["\u672A\u663E\u793A\u3002", " \u043D\u0435 \u043F\u043E\u043A\u0430\u0437\u0430\u043D\u044B."],
  ["\u4EFB\u52A1 ", "\u0417\u0430\u0434\u0430\u0447\u0438: "],
  [" \xB7 \u6A21\u5F0F ", " \xB7 \u0440\u0435\u0436\u0438\u043C "],
  ["\u{1F517} \u5DF2\u521B\u5EFA\u65B0\u4F1A\u8BDD ", "\u{1F517} \u0421\u043E\u0437\u0434\u0430\u043D\u0430 \u043D\u043E\u0432\u0430\u044F \u0441\u0435\u0441\u0441\u0438\u044F "],
  ["\u26A0\uFE0F \u5DF2\u6539\u9009\u4F1A\u8BDD ", "\u26A0\uFE0F \u0412\u044B\u0431\u0440\u0430\u043D\u0430 \u0434\u0440\u0443\u0433\u0430\u044F \u0441\u0435\u0441\u0441\u0438\u044F "],
  ["\uFF0C\u518D\u6B21\u53D1\u9001 /archive \u786E\u8BA4\u5F52\u6863\u3002", "; \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /archive \u0435\u0449\u0451 \u0440\u0430\u0437 \u0434\u043B\u044F \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F \u0430\u0440\u0445\u0438\u0432\u0430\u0446\u0438\u0438."],
  ["\u26A0\uFE0F \u786E\u8BA4\u5F52\u6863\u4F1A\u8BDD ", "\u26A0\uFE0F \u0410\u0440\u0445\u0438\u0432\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0441\u0435\u0441\u0441\u0438\u044E "],
  ["\uFF1F\u518D\u6B21\u53D1\u9001 /archive \u786E\u8BA4\uFF08\u5176\u5B83\u547D\u4EE4\u6216\u6587\u5B57\u53EF\u53D6\u6D88\uFF09\u3002", "? \u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /archive \u0435\u0449\u0451 \u0440\u0430\u0437 \u0434\u043B\u044F \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F (\u0434\u0440\u0443\u0433\u0430\u044F \u043A\u043E\u043C\u0430\u043D\u0434\u0430 \u0438\u043B\u0438 \u0442\u0435\u043A\u0441\u0442 \u043E\u0442\u043C\u0435\u043D\u0438\u0442)."],
  ["\u{1F4E6} \u5DF2\u5F52\u6863\u4F1A\u8BDD ", "\u{1F4E6} \u0421\u0435\u0441\u0441\u0438\u044F "],
  ["\uFF08\u52A0\u5165\u5F52\u6863\u533A\uFF0C\u4ECE\u5217\u8868\u4E0E\u5DE5\u4F5C\u533A\u9690\u85CF\uFF09", " \u0432 \u0430\u0440\u0445\u0438\u0432\u0435 (\u0441\u043A\u0440\u044B\u0442\u0430 \u0438\u0437 \u0441\u043F\u0438\u0441\u043A\u0430 \u0438 \u0440\u0430\u0431\u043E\u0447\u0435\u0439 \u043E\u0431\u043B\u0430\u0441\u0442\u0438)"],
  ["\u{1F5D1} \u5DF2\u5220\u9664\u4F1A\u8BDD ", "\u{1F5D1} \u0421\u0435\u0441\u0441\u0438\u044F "],
  ["\uFF08\u4ECE\u5217\u8868\u4E0E\u5DE5\u4F5C\u533A\u9690\u85CF\uFF09", " \u0443\u0434\u0430\u043B\u0435\u043D\u0430 (\u0441\u043A\u0440\u044B\u0442\u0430 \u0438\u0437 \u0441\u043F\u0438\u0441\u043A\u0430 \u0438 \u0440\u0430\u0431\u043E\u0447\u0435\u0439 \u043E\u0431\u043B\u0430\u0441\u0442\u0438)"],
  ["\u{1F500} \u5DF2\u5206\u53C9\u4F1A\u8BDD ", "\u{1F500} \u0421\u0435\u0441\u0441\u0438\u044F "],
  ["\uFF1A\u65B0\u4F1A\u8BDD ", " \u0440\u0430\u0437\u0434\u0435\u043B\u0435\u043D\u0430: \u043D\u043E\u0432\u0430\u044F \u0441\u0435\u0441\u0441\u0438\u044F "],
  ["\uFF0C\u5DF2\u7ED1\u5B9A\u5230\u65B0\u4F1A\u8BDD\u3002", ", \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043D\u0430 \u043A \u043D\u0435\u0439."],
  ["\u6682\u5B58\u6A21\u5F0F\u300C", "\u0420\u0435\u0436\u0438\u043C \xAB"],
  ["\u300D\uFF1A\u4E0B\u4E00\u6B21 /new \u521B\u5EFA\u4F1A\u8BDD\u65F6\u751F\u6548\u3002", "\xBB \u043E\u0442\u043B\u043E\u0436\u0435\u043D: \u043F\u0440\u0438\u043C\u0435\u043D\u0438\u0442\u0441\u044F \u043F\u0440\u0438 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u043C /new."],
  ["\u2705 \u5DF2\u5207\u6362\u4F1A\u8BDD\u6A21\u5F0F\u4E3A\u300C", "\u2705 \u0420\u0435\u0436\u0438\u043C \u0441\u0435\u0441\u0441\u0438\u0438 \u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0451\u043D \u043D\u0430 \xAB"],
  ["\u5F53\u524D\u4F1A\u8BDD\u5DF2\u5F00\u59CB\uFF0C\u6A21\u5F0F\u5DF2\u56FA\u5B9A\u3002\u5DF2\u6682\u5B58\u300C", "\u0422\u0435\u043A\u0443\u0449\u0430\u044F \u0441\u0435\u0441\u0441\u0438\u044F \u0443\u0436\u0435 \u043D\u0430\u0447\u0430\u0442\u0430, \u0440\u0435\u0436\u0438\u043C \u0437\u0430\u0444\u0438\u043A\u0441\u0438\u0440\u043E\u0432\u0430\u043D. \xAB"],
  ["\n\n\u5DF2\u6682\u5B58\uFF1A", "\n\n\u041E\u0442\u043B\u043E\u0436\u0435\u043D\u043E: "],
  ["\uFF08\u4E0B\u4E00\u6B21 /new \u751F\u6548\uFF09", " (\u043F\u0440\u0438\u043C\u0435\u043D\u0438\u0442\u0441\u044F \u043F\u0440\u0438 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u043C /new)"],
  ["\u6CA1\u6709\u6253\u5F00\u7684\u4F1A\u8BDD\u3002\u5E26\u53C2\u6570\u4F7F\u7528 /", "\u041E\u0442\u043A\u0440\u044B\u0442\u044B\u0445 \u0441\u0435\u0441\u0441\u0438\u0439 \u043D\u0435\u0442. \u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u0441\u0435\u0441\u0441\u0438\u044E \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u043E\u043C: /"],
  [" <\u5E8F\u53F7|id> \u6307\u5B9A\u4F1A\u8BDD\u3002", " <\u043D\u043E\u043C\u0435\u0440|id>."],
  ["\u5DF2\u5B8C\u6210", "\u0433\u043E\u0442\u043E\u0432\u043E"],
  ["\u8FDB\u884C\u4E2D", "\u0432 \u0440\u0430\u0431\u043E\u0442\u0435"],
  ["\u5F85\u5904\u7406", "\u0432 \u043E\u0447\u0435\u0440\u0435\u0434\u0438"],
  ["\u300D", "\xBB"],
  ["\u300C", "\xAB"],
  ["\uFF08", " ("],
  ["\uFF09", ")"],
  ["\uFF1A", ":"],
  ["\u3002", "."],
  ["\uFF0C", ", "],
  ["\u3001", ", "],
  ["\uFF1F", "?"],
  ["\uFF01", "!"],
  ["\u300D\u5B8C\u6210\u3002", "\xBB."],
  [" \u8F6E\u5BF9\u8BDD", " \u0440\u0430\u0443\u043D\u0434\u0430 \u0434\u0438\u0430\u043B\u043E\u0433\u0430"],
  [" \u5206\u949F\u524D", " \u043C\u0438\u043D. \u043D\u0430\u0437\u0430\u0434"],
  [" \u5C0F\u65F6\u524D", " \u0447. \u043D\u0430\u0437\u0430\u0434"],
  [" \u5929\u524D", " \u0434\u043D. \u043D\u0430\u0437\u0430\u0434"],
  [" \u4E2A\u4F1A\u8BDD", " \u0441\u0435\u0441\u0441\u0438\u0439"],
  [" \u5B57\u7B26\uFF08\u8FD1 ", " \u0441\u0438\u043C\u0432. (\u0437\u0430 \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0435 "],
  [" \u6761\u6D88\u606F\uFF09", " \u0441\u043E\u043E\u0431\u0449.)"],
  [" \u4E2A\u6A21\u578B\u672A\u663E\u793A\u3002", " \u043C\u043E\u0434\u0435\u043B\u0435\u0439 \u043D\u0435 \u043F\u043E\u043A\u0430\u0437\u0430\u043D\u043E."],
  ["\u6CA1\u6709\u627E\u5230\u6A21\u5F0F ", "\u0420\u0435\u0436\u0438\u043C \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D: "],
  ["\u3002\u53D1\u9001 /preset \u67E5\u770B\u53EF\u9009\u6A21\u5F0F\u3002", ". \u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /preset, \u0447\u0442\u043E\u0431\u044B \u0443\u0432\u0438\u0434\u0435\u0442\u044C \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B\u0435 \u0440\u0435\u0436\u0438\u043C\u044B."],
  ["[\u5E8F\u53F7|id|none|arc]", "[\u043D\u043E\u043C\u0435\u0440|id|none|arc]"],
  [" \u2014 \u7ED1\u5B9A\u4F1A\u8BDD\u5E76\u663E\u793A\u6700\u8FD1 ", " \u2014 \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u0442\u044C \u0441\u0435\u0441\u0441\u0438\u044E \u0438 \u043F\u043E\u043A\u0430\u0437\u0430\u0442\u044C \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0435 "],
  ["\uFF1A\u65E0\u53C2\u6570\u9009\u5DE5\u4F5C\u533A/\u672A\u5206\u7EC4/\u5F52\u6863\uFF1Bnone=\u672A\u5206\u7EC4\uFF1Barc=\u5F52\u6863\uFF1B\u5E8F\u53F7=\u5F53\u524D\u8303\u56F4\u91CC\u7684\u4F1A\u8BDD", ": \u0431\u0435\u0437 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u043E\u0432 \u2014 \u0432\u044B\u0431\u043E\u0440 \u0440\u0430\u0431\u043E\u0447\u0435\u0439 \u043E\u0431\u043B\u0430\u0441\u0442\u0438/\u0431\u0435\u0437 \u0433\u0440\u0443\u043F\u043F\u044B/\u0430\u0440\u0445\u0438\u0432\u0430; none \u2014 \u0431\u0435\u0437 \u0433\u0440\u0443\u043F\u043F\u044B; arc \u2014 \u0430\u0440\u0445\u0438\u0432; \u043D\u043E\u043C\u0435\u0440 \u2014 \u0441\u0435\u0441\u0441\u0438\u044F \u0438\u0437 \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E \u0441\u043F\u0438\u0441\u043A\u0430"],
  ["\u7F13\u5B58\u547D\u4E2D ", "\u041F\u043E\u043F\u0430\u0434\u0430\u043D\u0438\u0435 \u0432 \u043A\u044D\u0448 "],
  ["\u7F13\u5B58\u5199 ", "\u0417\u0430\u043F\u0438\u0441\u044C \u0432 \u043A\u044D\u0448 "],
  ["\n\n<pre>\u26A1 \u672C\u8F6E: ", "\n\n<pre>\u26A1 \u0420\u0430\u0443\u043D\u0434: "],
  ["\u{1F527} \u5DE5\u5177\u8C03\u7528\u4E2D: ", "\u{1F527} \u0412\u044B\u0437\u043E\u0432 \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0430: "],
  ["\u270D\uFE0F \u91CD\u8F93 Q", "\u270D\uFE0F \u0417\u0430\u043D\u043E\u0432\u043E Q"],
  ["\u270D\uFE0F \u81EA\u5B9A\u4E49 Q", "\u270D\uFE0F \u0421\u0432\u043E\u0439 \u043E\u0442\u0432\u0435\u0442 Q"],
  ["\u63D0\u95EE\u56DE\u7B54\u88AB\u62D2\u7EDD\uFF08", "\u041E\u0442\u0432\u0435\u0442 \u043D\u0430 \u0432\u043E\u043F\u0440\u043E\u0441 \u043E\u0442\u043A\u043B\u043E\u043D\u0451\u043D ("],
  ["\u63D0\u95EE\u53D6\u6D88\u5931\u8D25\uFF08", "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u0442\u043C\u0435\u043D\u0438\u0442\u044C \u0432\u043E\u043F\u0440\u043E\u0441 ("],
  [" \u5982\u9700\u8BBF\u95EE\uFF0C\u8BF7\u5C06 chat id ", " \u0414\u043B\u044F \u0434\u043E\u0441\u0442\u0443\u043F\u0430 \u0434\u043E\u0431\u0430\u0432\u044C\u0442\u0435 chat id "],
  [" \u52A0\u5165 allowChatIds \u767D\u540D\u5355\u3002", " \u0432 \u0431\u0435\u043B\u044B\u0439 \u0441\u043F\u0438\u0441\u043E\u043A allowChatIds."]
];
var orderedPhrases = [...RUSSIAN_PHRASES].sort((left, right) => right[0].length - left[0].length);
function localize(text, locale) {
  if (locale !== "ru" || text === "") return text;
  let result = text;
  for (const [pattern, replacement] of RUSSIAN_PATTERNS) {
    result = typeof replacement === "string" ? result.replace(pattern, replacement) : result.replace(pattern, (...args) => replacement(...args));
  }
  for (const [from, to] of orderedPhrases) {
    if (from !== "" && result.includes(from)) result = result.split(from).join(to);
  }
  return result;
}
function localizeRows(rows, locale) {
  return rows.map((row) => row.map((button) => ({ ...button, text: localize(button.text, locale) })));
}

// src/console.ts
import { SessionId as SessionId2 } from "@deepseek-ai/dsh-session";

// src/render.ts
import { SessionId } from "@deepseek-ai/dsh-session";
var TELEGRAM_VERSION = "1.9.2";
var TELEGRAM_CHUNK_MAX = 3500;
var QUEUE_ACK_MAX = 200;
var SESSION_TITLE_MAX = 80;
var TOOL_ARGS_MAX = 80;
var REASONING_BRIEF_MAX = 120;
var HISTORY_DEFAULT_LIMIT = 20;
var STATUS_MAIN_MAX = 400;
var SESSION_KEYBOARD_MAX = 15;
var TELEGRAM_BUTTON_MAX = 60;
function fitButtonText(text, fixedLength) {
  const budget = Math.max(1, TELEGRAM_BUTTON_MAX - fixedLength);
  return Array.from(text).length > budget ? truncate(text, budget - 1) : text;
}
var WORKSPACE_KEYBOARD_MAX = 15;
var CREATE_UNGROUPED_LABEL = "/new none \xB7 \u672A\u5206\u7C7B";
var KEYBOARD_ACTION_ROWS = [
  ["/create", "/archive", "/attach"],
  ["/stop", "/close"]
];
var SESSION_STATE_LEGEND = "\u{1F7E2} \u6267\u884C\u4E2D \xB7 \u2705 \u5DF2\u5B8C\u6210 \xB7 \u26AA \u672A\u5F00\u59CB";
var STREAM_REPLYING_SUFFIX = "\n\n\u23F3 \u56DE\u590D\u4E2D\u2026";
var ASSISTANT_ROLE_GLYPH = "\u{1F916}";
function truncate(text, max) {
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max).join("")}\u2026` : text;
}
function timeAgo(timestamp, now) {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1e3));
  if (seconds < 60) return "\u521A\u521A";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} \u5206\u949F\u524D`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} \u5C0F\u65F6\u524D`;
  return `${Math.floor(hours / 24)} \u5929\u524D`;
}
function formatStartClock(ms, now) {
  const d = new Date(ms);
  const hhmmss = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  const ref = new Date(now);
  const sameDay = d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth() && d.getDate() === ref.getDate();
  if (sameDay) return hhmmss;
  const mmdd = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (d.getFullYear() === ref.getFullYear()) return `${mmdd} ${hhmmss}`;
  return `${d.getFullYear()}-${mmdd} ${hhmmss}`;
}
function startClockLabel(ms, now) {
  return `\uFF08${formatStartClock(ms, now)}\uFF09`;
}
function shortSessionId(id) {
  return id.length <= 12 ? id : `${id.slice(0, 8)}\u2026${id.slice(-2)}`;
}
function blockText(content) {
  let out = "";
  for (const block of content) {
    if (block.type === "text") out += block.text;
  }
  return out.trim();
}
function userMessageText(message) {
  return blockText(message.content);
}
function isWorkspaceInstructionSource(source) {
  return source.kind === "agent-instructions";
}
function assistantMessageText(message) {
  return blockText(message.content);
}
function toolArgBrief(raw) {
  let brief = raw;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const first = Object.values(parsed)[0];
      if (typeof first === "string") brief = first;
      else if (first !== void 0) brief = JSON.stringify(first);
    }
  } catch {
    brief = raw;
  }
  return truncate(brief, TOOL_ARGS_MAX);
}
function toolCallBrief(name2, raw) {
  return `${name2}(${toolArgBrief(raw)})`;
}
function reasoningBrief(text) {
  return truncate(text.replace(/\s+/g, " ").trim(), REASONING_BRIEF_MAX);
}
var REASONING_ACTION_LABEL = "\u{1F4AD} Think";
var TOOL_ACTION_LABEL = "\u{1F527}";
function messageActions(message, time) {
  const actions = [];
  for (const block of message.content) {
    if (block.type === "reasoning") {
      const brief = reasoningBrief(block.text);
      if (brief !== "") actions.push({ time, line: `${REASONING_ACTION_LABEL} \u2014 ${brief}` });
    } else if (block.type === "tool-call") {
      actions.push({ time, line: `${TOOL_ACTION_LABEL} ${block.name} \u2014 ${toolArgBrief(block.arguments)}` });
    }
  }
  return actions;
}
function turnEndLabel(reason) {
  switch (reason.kind) {
    case "completed":
      return "\u2705 done";
    case "aborted":
      return "\u23F9 stopped";
    case "blocked":
      return "\u26D4 blocked";
    case "error":
      return "\u274C failed";
    case "max-tokens":
      return "\u23F3 max tokens";
    case "interrupted":
      return "\u23F8 interrupted";
    default:
      return `\u23F9 ${reason.kind}`;
  }
}
function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function emptyRoundUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}
function accumulateRoundUsage(usage, step) {
  if (step === void 0) return;
  usage.input += step.inputTokens;
  usage.output += step.outputTokens;
  usage.cacheRead += step.cacheReadTokens ?? 0;
  usage.cacheWrite += step.cacheWriteTokens ?? 0;
}
function compactTokenCount(count) {
  if (count < 1e3) return String(count);
  const oneDecimal = Math.round(count / 1e3 * 10) / 10;
  return `${oneDecimal}k`;
}
function roundUsageFooter(usage) {
  const parts = [];
  if (usage.input > 0 || usage.output > 0) {
    parts.push(`\u2191${compactTokenCount(usage.input)} \u2193${compactTokenCount(usage.output)}`);
  }
  if (usage.cacheRead > 0) {
    const hitRate = Math.round(usage.cacheRead / (usage.cacheRead + usage.input) * 100);
    parts.push(`\u7F13\u5B58\u547D\u4E2D ${hitRate}%`);
  }
  if (usage.cacheWrite > 0) {
    parts.push(`\u7F13\u5B58\u5199 ${compactTokenCount(usage.cacheWrite)}`);
  }
  if (parts.length === 0) return "";
  return `

<pre>\u26A1 \u672C\u8F6E: ${parts.join(" \xB7 ")}</pre>`;
}
function lastTurnUsage(events) {
  let startIndex = -1;
  let endIndex = -1;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type === "turn/start") startIndex = index;
    else if (event?.type === "turn/end") endIndex = index;
  }
  if (startIndex === -1 || endIndex <= startIndex) return emptyRoundUsage();
  const usage = emptyRoundUsage();
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const event = events[index];
    if (event?.type === "assistant/message") accumulateRoundUsage(usage, event.data.usage);
  }
  return usage;
}
function openTurnUsage(events) {
  let startIndex = -1;
  let endIndex = -1;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type === "turn/start") startIndex = index;
    else if (event?.type === "turn/end") endIndex = index;
  }
  if (startIndex === -1 || endIndex > startIndex) return emptyRoundUsage();
  const usage = emptyRoundUsage();
  for (let index = startIndex + 1; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type === "assistant/message") accumulateRoundUsage(usage, event.data.usage);
  }
  return usage;
}
function latestTurnStartTime(events) {
  let time;
  for (const event of events) {
    if (event.type === "turn/start") time = event.time;
  }
  return time;
}
function sessionGlyph(summary) {
  return summary.running ? "\u{1F7E2}" : summary.blank ? "\u26AA" : "\u2705";
}
function sessionRow(index, summary, now) {
  const title = summary.projections?.values.title ?? "";
  const heading = title !== "" ? title : summary.cwd ?? shortSessionId(summary.sessionId);
  const cwd = summary.cwd ?? "\uFF08\u65E0\u76EE\u5F55\uFF09";
  const age = timeAgo(summary.updatedAt, now);
  return `${index}) ${sessionGlyph(summary)} ${heading}
   ${cwd} \xB7 ${age} \xB7 ${shortSessionId(summary.sessionId)}`;
}
function assistantTail(events, rounds) {
  const texts = [];
  for (const event of events) {
    if (event.type !== "assistant/message") continue;
    const text = assistantMessageText(event.data.message);
    if (text !== "") texts.push(text);
  }
  if (texts.length <= rounds) return texts;
  return texts.slice(texts.length - rounds);
}
function statusMainText(events) {
  if (events.length === 0) return "\uFF08\u7A7A\u767D\u4F1A\u8BDD\uFF0C\u8FD8\u6CA1\u6709\u6D88\u606F\uFF09";
  const openCalls = [];
  for (const event of events) {
    switch (event.type) {
      case "tool/call":
        openCalls.push(event.data.name);
        break;
      case "tool/result":
        openCalls.pop();
        break;
      case "turn/end":
        openCalls.length = 0;
        break;
      default:
        break;
    }
  }
  const pending = openCalls.at(-1);
  if (pending !== void 0) return `\u{1F527} \u5DE5\u5177\u8C03\u7528\u4E2D: ${pending}`;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event === void 0 || event.type !== "assistant/message") continue;
    const text = assistantMessageText(event.data.message);
    if (text === "") continue;
    return `\u{1F916} ${truncate(text, STATUS_MAIN_MAX)}`;
  }
  return "\uFF08\u6682\u65E0\u8F93\u51FA\uFF09";
}
function openToolCalls(events) {
  const open = [];
  for (const event of events) {
    switch (event.type) {
      case "tool/call":
        open.push(toolCallBrief(event.data.name, event.data.arguments));
        break;
      case "tool/result":
        open.pop();
        break;
      case "turn/end":
        open.length = 0;
        break;
      default:
        break;
    }
  }
  return open;
}
function turnOpen(events) {
  let started = false;
  for (const event of events) {
    if (event.type === "turn/start") started = true;
    else if (event.type === "turn/end") started = false;
  }
  return started || openToolCalls(events).length > 0;
}
function pendingAskBatches(events) {
  const decided = /* @__PURE__ */ new Set();
  for (const event of events) {
    if (event.type === "question/decided") decided.add(event.data.id);
  }
  const batches = [];
  for (const event of events) {
    if (event.type === "question/asked" && !decided.has(event.data.id)) {
      batches.push({ id: event.data.id, questions: event.data.questions });
    }
  }
  return batches;
}
function stepActions(events, maxActions = 20) {
  const actions = [];
  for (const event of events) {
    if (event.type === "assistant/message") actions.push(...messageActions(event.data.message, event.time));
  }
  return actions.slice(-maxActions);
}
function actionsHtml(actions, now) {
  if (actions.length === 0) return "";
  const lines = actions.map((action) => startClockLabel(action.time, now) + escapeHtml(action.line));
  return "<blockquote expandable>" + lines.join("\n") + "</blockquote>";
}
function stepActionsHtml(events, now, maxActions = 20) {
  return actionsHtml(stepActions(events, maxActions), now);
}
function chunkText(text, cap = TELEGRAM_CHUNK_MAX) {
  const points = Array.from(text);
  if (points.length <= cap) return [text];
  const chunks = [];
  let start = 0;
  while (start < points.length) {
    let end = Math.min(start + cap, points.length);
    if (end < points.length) {
      let lastNewline = -1;
      for (let cursor = end - 1; cursor > start && end - cursor <= 200; cursor--) {
        if (points[cursor] === "\n") {
          lastNewline = cursor;
          break;
        }
      }
      if (lastNewline !== -1) end = lastNewline + 1;
    }
    chunks.push(points.slice(start, end).join(""));
    start = end;
  }
  return chunks;
}
function stripStreamSuffix(text) {
  return text.endsWith(STREAM_REPLYING_SUFFIX) ? text.slice(0, -STREAM_REPLYING_SUFFIX.length) : text;
}
function statusStats(events) {
  let users = 0;
  let assistants = 0;
  let tools = 0;
  let chars = 0;
  for (const event of events) {
    switch (event.type) {
      case "user/message":
        if (isWorkspaceInstructionSource(event.data.source)) break;
        users++;
        chars += Array.from(userMessageText(event.data)).length;
        break;
      case "assistant/message":
        assistants++;
        chars += Array.from(assistantMessageText(event.data.message)).length;
        break;
      case "tool/call":
        tools++;
        chars += Array.from(event.data.arguments).length;
        break;
      default:
        break;
    }
  }
  return { users, assistants, tools, chars };
}
function sessionKeyboardRows(items, verb) {
  const rows = [...KEYBOARD_ACTION_ROWS.map((row) => [...row])];
  for (const [index, item] of items.slice(0, SESSION_KEYBOARD_MAX).entries()) {
    const title = item.projections?.values.title ?? item.cwd ?? shortSessionId(item.sessionId);
    rows.push([`/${verb} ${index + 1} \xB7 ${sessionGlyph(item)} ${fitButtonText(title, `/${verb} ${index + 1} \xB7 ${sessionGlyph(item)} `.length)}`]);
  }
  return rows;
}
function attachKeyboardRows(items) {
  const rows = [...KEYBOARD_ACTION_ROWS.map((row) => [...row])];
  for (const [index, item] of items.entries()) {
    const title = item.projections?.values.title ?? item.cwd ?? shortSessionId(item.sessionId);
    rows.push([`/attach ${index + 1} \xB7 ${sessionGlyph(item)} ${title}`]);
  }
  return rows;
}
function workspaceRow(index, workspace) {
  return `${index}) \u{1F4C1} ${truncate(workspace.title, SESSION_TITLE_MAX)}
   ${workspace.path} \xB7 ${workspace.sessionIds.length} \u4E2A\u4F1A\u8BDD`;
}
function workspaceKeyboardRows(workspaces) {
  const rows = [...KEYBOARD_ACTION_ROWS.map((row) => [...row])];
  for (const [index, workspace] of workspaces.slice(0, WORKSPACE_KEYBOARD_MAX).entries()) {
    rows.push([`/new ${index + 1} \xB7 ${fitButtonText(workspace.title, `/new ${index + 1} \xB7 `.length)}`]);
  }
  rows.push([CREATE_UNGROUPED_LABEL]);
  return rows;
}
var PRESET_KEYBOARD_MAX = 15;
function todoRow(index, item) {
  const glyph = item.status === "completed" ? "\u2705" : item.status === "in_progress" ? "\u{1F504}" : "\u2B1C";
  return `${index}) ${glyph} ${truncate(item.content, SESSION_TITLE_MAX)}`;
}
function renderTodoList(todos) {
  const done = todos.filter((item) => item.status === "completed").length;
  const active = todos.filter((item) => item.status === "in_progress").length;
  const pending = todos.length - done - active;
  const body = todos.map((item, index) => todoRow(index + 1, item)).join("\n");
  return `\u{1F4CB} \u4EFB\u52A1 ${done} \u5DF2\u5B8C\u6210 \xB7 ${active} \u8FDB\u884C\u4E2D \xB7 ${pending} \u5F85\u5904\u7406

${body}`;
}
function lastTodoWrite(events) {
  let latest = null;
  for (const event of events) {
    if (event.type === "todo/write") latest = event.data.todos;
  }
  return latest;
}
function presetKeyboardRows(presets) {
  const rows = [...KEYBOARD_ACTION_ROWS.map((row) => [...row])];
  for (const [index, preset] of presets.slice(0, PRESET_KEYBOARD_MAX).entries()) {
    const label = preset.name ?? preset.id;
    rows.push([`/preset ${index + 1} \xB7 ${fitButtonText(label, `/preset ${index + 1} \xB7 `.length)}`]);
  }
  return rows;
}
var ATTACH_CALLBACK_WORKSPACE = "atw";
var ATTACH_CALLBACK_UNGROUPED = "atn";
var ATTACH_CALLBACK_ARCHIVED = "ata";
var ATTACH_CALLBACK_SESSION = "ats";
function attachWorkspaceData(workspaceId) {
  return `${ATTACH_CALLBACK_WORKSPACE}:${workspaceId}`;
}
var ATTACH_UNGROUPED_DATA = `${ATTACH_CALLBACK_UNGROUPED}:1`;
var ATTACH_ARCHIVED_DATA = `${ATTACH_CALLBACK_ARCHIVED}:1`;
function attachSessionData(sessionId) {
  return `${ATTACH_CALLBACK_SESSION}:${sessionId}`;
}
function parseAttachCallback(data) {
  const [prefix, id, ...rest] = data.split(":");
  if (id === void 0 || id === "") return void 0;
  if (prefix === ATTACH_CALLBACK_WORKSPACE) {
    if (rest.length !== 0) return void 0;
    return { kind: "workspace", workspaceId: id };
  }
  if (prefix === ATTACH_CALLBACK_UNGROUPED || prefix === ATTACH_CALLBACK_ARCHIVED) {
    if (id !== "1" || rest.length !== 0) return void 0;
    return { kind: prefix === ATTACH_CALLBACK_UNGROUPED ? "ungrouped" : "archived" };
  }
  if (prefix === ATTACH_CALLBACK_SESSION) {
    if (rest.length !== 0) return void 0;
    return { kind: "session", sessionId: SessionId(id) };
  }
  return void 0;
}
function attachScopeButtons(workspaces, options) {
  const rows = [];
  for (const workspace of workspaces.slice(0, WORKSPACE_KEYBOARD_MAX)) {
    rows.push([{ text: `\u{1F4C1} ${fitButtonText(workspace.title, 3)}`, data: attachWorkspaceData(workspace.workspaceId) }]);
  }
  if (options.ungrouped) rows.push([{ text: "\u672A\u5206\u7EC4", data: ATTACH_UNGROUPED_DATA }]);
  if (options.archived) rows.push([{ text: "\u5F52\u6863", data: ATTACH_ARCHIVED_DATA }]);
  return rows;
}
function attachSessionButtons(items) {
  const rows = [];
  for (const item of items.slice(0, SESSION_KEYBOARD_MAX)) {
    const title = item.projections?.values.title ?? item.cwd ?? shortSessionId(item.sessionId);
    rows.push([{ text: `${sessionGlyph(item)} ${fitButtonText(title, `${sessionGlyph(item)} `.length)}`, data: attachSessionData(item.sessionId) }]);
  }
  return rows;
}
var SESSION_LIST_CALLBACK_STOP = "stp";
var SESSION_LIST_CALLBACK_STATUS = "sta";
function sessionStopData(sessionId) {
  return `${SESSION_LIST_CALLBACK_STOP}:${sessionId}`;
}
function sessionStatusData(sessionId) {
  return `${SESSION_LIST_CALLBACK_STATUS}:${sessionId}`;
}
function parseSessionListCallback(data) {
  const [prefix, id, ...rest] = data.split(":");
  if (id === void 0 || id === "") return void 0;
  if (rest.length !== 0) return void 0;
  if (prefix === SESSION_LIST_CALLBACK_STOP) return { kind: "stop", sessionId: SessionId(id) };
  if (prefix === SESSION_LIST_CALLBACK_STATUS) return { kind: "status", sessionId: SessionId(id) };
  return void 0;
}
function sessionActionButtons(items, verb) {
  const rows = [];
  for (const item of items.slice(0, SESSION_KEYBOARD_MAX)) {
    const title = item.projections?.values.title ?? item.cwd ?? shortSessionId(item.sessionId);
    const glyph = verb === "stop" ? "\u23F9" : "\u{1F4CA}";
    rows.push([{ text: `${glyph} ${sessionGlyph(item)} ${fitButtonText(title, `${glyph} ${sessionGlyph(item)} `.length)}`, data: verb === "stop" ? sessionStopData(item.sessionId) : sessionStatusData(item.sessionId) }]);
  }
  return rows;
}
var QUESTION_SUBMIT_LABEL = "\u2705 \u63D0\u4EA4\u56DE\u7B54";
var QUESTION_CANCEL_LABEL = "\u{1F6AB} \u53D6\u6D88";
var QUESTION_CUSTOM_LABEL = "\u270D\uFE0F \u81EA\u5B9A\u4E49\u56DE\u7B54";
var QUESTION_CUSTOM_DONE_LABEL = "\u270D\uFE0F \u91CD\u65B0\u8F93\u5165\u56DE\u7B54";
var QUESTION_CALLBACK_OPTION = "qo";
var QUESTION_CALLBACK_CUSTOM = "qt";
var QUESTION_CALLBACK_SUBMIT = "qs";
var QUESTION_CALLBACK_CANCEL = "qx";
function questionOptionData(rpcId, questionIndex, optionIndex) {
  return `${QUESTION_CALLBACK_OPTION}:${rpcId}:${questionIndex}:${optionIndex}`;
}
function questionCustomData(rpcId, questionIndex) {
  return `${QUESTION_CALLBACK_CUSTOM}:${rpcId}:${questionIndex}`;
}
function questionSubmitData(rpcId) {
  return `${QUESTION_CALLBACK_SUBMIT}:${rpcId}`;
}
function questionCancelData(rpcId) {
  return `${QUESTION_CALLBACK_CANCEL}:${rpcId}`;
}
function parseQuestionCallback(data) {
  const parts = data.split(":");
  const prefix = parts[0];
  const rpcId = parts[1];
  if (rpcId === void 0 || rpcId === "") return void 0;
  if (prefix === QUESTION_CALLBACK_OPTION) {
    if (parts.length !== 4) return void 0;
    const questionIndex = segmentIndex(parts[2]);
    const option = segmentIndex(parts[3]);
    if (questionIndex === void 0 || option === void 0) return void 0;
    return { kind: "option", rpcId, questionIndex, optionIndex: option };
  }
  if (prefix === QUESTION_CALLBACK_CUSTOM) {
    if (parts.length !== 3) return void 0;
    const questionIndex = segmentIndex(parts[2]);
    if (questionIndex === void 0) return void 0;
    return { kind: "custom", rpcId, questionIndex };
  }
  if (prefix === QUESTION_CALLBACK_SUBMIT) {
    if (parts.length !== 2) return void 0;
    return { kind: "submit", rpcId };
  }
  if (prefix === QUESTION_CALLBACK_CANCEL) {
    if (parts.length !== 2) return void 0;
    return { kind: "cancel", rpcId };
  }
  return void 0;
}
function segmentIndex(raw) {
  if (raw === void 0 || !/^\d+$/.test(raw)) return void 0;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : void 0;
}
function questionMessageText(questions) {
  const blocks = questions.map((question, index) => {
    const lines = [
      `\u2753 ${question.header ?? question.question}`,
      ...question.header === void 0 ? [] : [question.question],
      ...question.detail === void 0 ? [] : [question.detail],
      ...question.multiSelect === true ? ["\uFF08\u53EF\u591A\u9009\uFF09"] : []
    ];
    return questions.length > 1 ? `\u3010${index + 1}\u3011
${lines.join("\n")}` : lines.join("\n");
  });
  const footer = questions.length > 1 ? "\n\n\u5168\u90E8\u56DE\u7B54\u540E\u70B9\u300C\u2705 \u63D0\u4EA4\u56DE\u7B54\u300D\u3002" : "";
  return `${blocks.join("\n\n")}${footer}`;
}
function questionKeyboard(questions, selected, custom, rpcId) {
  const multiple = questions.length > 1;
  const rows = [];
  for (const [questionIndex, question] of questions.entries()) {
    for (const [optionIndex, option] of (question.options ?? []).entries()) {
      const picked = selected[questionIndex]?.includes(option.label) === true;
      rows.push([{
        text: `${picked ? "\u2705 " : ""}${multiple ? `${questionIndex + 1}. ` : ""}${option.label}`,
        data: questionOptionData(rpcId, questionIndex, optionIndex)
      }]);
    }
    const hasCustom = custom[questionIndex] !== void 0;
    rows.push([{
      text: multiple ? hasCustom ? `\u270D\uFE0F \u91CD\u8F93 Q${questionIndex + 1}` : `\u270D\uFE0F \u81EA\u5B9A\u4E49 Q${questionIndex + 1}` : hasCustom ? QUESTION_CUSTOM_DONE_LABEL : QUESTION_CUSTOM_LABEL,
      data: questionCustomData(rpcId, questionIndex)
    }]);
  }
  rows.push([{ text: QUESTION_SUBMIT_LABEL, data: questionSubmitData(rpcId) }]);
  rows.push([{ text: QUESTION_CANCEL_LABEL, data: questionCancelData(rpcId) }]);
  return rows;
}

// src/markdown.ts
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
var SAFE_LINK_SCHEME = /^https?:\/\//i;
var THEMATIC_BREAK = "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500";
function escapeHref(url) {
  return url.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function markdownToTelegramHtml(markdown) {
  const root = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const definitions = collectDefinitions(root);
  return root.children.map((node) => blockToHtml(node, definitions)).filter((text) => text !== "").join("\n\n");
}
function collectDefinitions(root) {
  const map = /* @__PURE__ */ new Map();
  for (const node of root.children) {
    if (node.type === "definition") map.set(node.identifier.toLowerCase(), node.url);
  }
  return map;
}
function blockToHtml(node, definitions) {
  switch (node.type) {
    case "paragraph":
      return inlineToHtml(node.children, definitions);
    case "heading":
      return "<b>" + inlineToHtml(node.children, definitions) + "</b>";
    case "thematicBreak":
      return THEMATIC_BREAK;
    case "blockquote":
      return "<blockquote>" + node.children.map((child) => blockToHtml(child, definitions)).filter((text) => text !== "").join("\n") + "</blockquote>";
    case "list":
      return listToHtml(node, definitions, 0);
    case "code":
      return codeBlockToHtml(node.value, node.lang);
    case "table":
      return tableToHtml(node, definitions);
    case "html":
      return escapeHtml(node.value);
    case "definition":
    case "footnoteDefinition":
      return "";
    /* v8 ignore next 2 -- merge-extensible block union: unknown node types render nothing. */
    default:
      return "";
  }
}
function inlineToHtml(nodes, definitions) {
  let out = "";
  for (const node of nodes) out += phrasingToHtml(node, definitions);
  return out;
}
function phrasingToHtml(node, definitions) {
  switch (node.type) {
    case "text":
      return escapeHtml(node.value);
    case "break":
      return "\n";
    case "strong":
      return "<b>" + inlineToHtml(node.children, definitions) + "</b>";
    case "emphasis":
      return "<i>" + inlineToHtml(node.children, definitions) + "</i>";
    case "delete":
      return "<s>" + inlineToHtml(node.children, definitions) + "</s>";
    case "inlineCode":
      return "<code>" + escapeHtml(node.value.replace(/\r?\n|\r/g, " ")) + "</code>";
    case "link":
      return linkToHtml(node.url, inlineToHtml(node.children, definitions));
    case "linkReference":
      return linkToHtml(resolveDefinition(definitions, node.identifier), inlineToHtml(node.children, definitions));
    case "image":
      return escapeHtml(imageAlt(node.alt, node.url));
    case "imageReference":
      return escapeHtml(imageAlt(node.alt, resolveDefinition(definitions, node.identifier)));
    case "html":
      return escapeHtml(node.value);
    case "footnoteReference":
      return escapeHtml("[^" + node.identifier + "]");
    /* v8 ignore next 2 -- merge-extensible phrasing union: unknown node types render nothing. */
    default:
      return "";
  }
}
function resolveDefinition(definitions, identifier) {
  return definitions.get(identifier.toLowerCase()) ?? "";
}
function linkToHtml(url, text) {
  if (text === "" || !SAFE_LINK_SCHEME.test(url)) return text;
  return '<a href="' + escapeHref(url) + '">' + text + "</a>";
}
function imageAlt(alt, url) {
  return alt === null || alt === void 0 || alt === "" ? url : alt;
}
function codeBlockToHtml(value, lang) {
  const escaped = escapeHtml(value);
  const language = /^[\w-]+/.exec(lang ?? "")?.[0];
  return language === void 0 ? "<pre>" + escaped + "</pre>" : '<pre><code class="language-' + language + '">' + escaped + "</code></pre>";
}
function tableToHtml(table, definitions) {
  return table.children.map((row, index) => {
    const line = row.children.map((cell) => inlineToHtml(cell.children, definitions)).join(" | ");
    return index === 0 ? "<b>" + line + "</b>" : line;
  }).join("\n");
}
function listToHtml(list, definitions, depth) {
  const indent = "  ".repeat(depth);
  const lines = [];
  let number = list.start ?? 1;
  for (const item of list.children) {
    const marker = typeof item.checked === "boolean" ? item.checked ? "\u2611" : "\u2610" : list.ordered === true ? String(number) + "." : "\u2022";
    const paragraphs = [];
    for (const child of item.children) {
      if (child.type === "list") continue;
      paragraphs.push(blockToHtml(child, definitions));
    }
    const first = paragraphs[0];
    lines.push(first === void 0 ? indent + marker : indent + marker + " " + first);
    for (let i = 1; i < paragraphs.length; i++) lines.push(indent + "  " + paragraphs[i]);
    for (const child of item.children) {
      if (child.type === "list") lines.push(listToHtml(child, definitions, depth + 1));
    }
    number++;
  }
  return lines.join("\n");
}

// src/console.ts
function interpretInput(text) {
  if (text.startsWith("\\")) return { kind: "prompt", text: text.slice(1) };
  if (!text.startsWith("/")) return { kind: "prompt", text };
  const [rawName, ...rest] = text.split(/\s+/);
  const withoutSuffix = (rawName ?? "").split("@")[0] ?? "";
  return { name: withoutSuffix.toLowerCase().slice(1), args: rest.join(" ") };
}
var TelegramConsole = class {
  #port;
  #transport;
  #now;
  #chats = /* @__PURE__ */ new Map();
  /**
   * One chat's in-flight event-push chain. Events bound to the same chat are
   * serialized so a later event never reads stream state mid-edit of an
   * earlier one (e.g. `turn/end` must see the assistant text its edit
   * finalized, not the empty stream of the still-in-flight edit).
   */
  #chains = /* @__PURE__ */ new Map();
  /**
   * @param port - session operations (ApiProxy adapter).
   * @param transport - outbound Telegram surface.
   * @param now - clock injection for relative timestamp rendering.
   */
  constructor(port, transport, now = () => Date.now()) {
    this.#port = port;
    this.#transport = transport;
    this.#now = now;
  }
  /**
   * Handle one allowed chat's incoming text message (commands and prompts).
   * @param chatId - the sender chat id.
   * @param text - the raw message text.
   * @returns after replies are dispatched.
   */
  async handleMessage(chatId, text) {
    const state = this.#state(chatId);
    const input = interpretInput(text);
    if ("kind" in input) {
      state.awaitingConfirm = void 0;
      if (state.awaitingRename) {
        await this.#handlePendingRename(chatId, state, input.text);
        return;
      }
      if (state.awaitingAskAnswer !== void 0) {
        await this.#handleAskCustomText(chatId, state, state.awaitingAskAnswer, input.text);
        return;
      }
      await this.#handlePrompt(chatId, state, input.text);
      return;
    }
    state.awaitingRename = false;
    state.awaitingAskAnswer = void 0;
    const command = input;
    try {
      await this.#handleCommand(chatId, state, command);
    } catch (error) {
      await this.#reply(chatId, `\u26D4 ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /**
   * Push one session event to every chat bound to that session. User
   * messages are never pushed — the chat sees the agent's side only, so
   * non-text blocks and tool noise are suppressed too. A turn streams on
   * one live message: `turn/start` opens a `🤔 thinking…` placeholder, assistant steps
   * edit it in place (spilling onto a fresh chunked message past the chunk
   * budget or after a failed edit), and `turn/end` closes it with the outcome
   * label only when the turn did not complete with a reply — a completed
   * reply finalizes its own message, while `aborted`/`error`/`interrupted` ends
   * append the label (an `error` end carries its structured failure reason),
   * and a failed label edit falls back to a fresh message so the outcome is
   * never lost.
   * @param sessionId - the emitting session.
   * @param event - the raw session event.
   * @returns after all targeted pushes dispatch.
   */
  async onSessionEvent(sessionId, event) {
    const pushes = [];
    for (const [chatId, state] of this.#chats) {
      if (state.sessionId !== sessionId) continue;
      const previous = this.#chains.get(chatId) ?? Promise.resolve();
      const push = previous.then(() => this.#pushEvent(chatId, state, sessionId, event));
      this.#chains.set(chatId, push.then(() => void 0, () => void 0));
      pushes.push(push);
    }
    const results = await Promise.allSettled(pushes);
    const failure = results.find((result) => result.status === "rejected");
    if (failure !== void 0) throw failure.reason;
  }
  /**
   * Push one session event to one bound chat. User messages are never pushed
   * — the chat sees the agent's side only, so non-text blocks and tool noise
   * are suppressed too. A turn streams on one live message: `turn/start` opens
   * a `🤔 thinking…` placeholder, assistant steps edit it in place (spilling
   * onto a fresh chunked message past the chunk budget or after a failed
   * edit), and `turn/end` closes it with the outcome label only when the turn
   * did not complete with a reply — a completed reply finalizes its own
   * message, while `aborted`/`error`/`interrupted` ends append the label (an
   * `error` end carries its structured failure reason), and a failed label
   * edit falls back to a fresh message so the outcome is never lost.
   * @param chatId - the bound chat.
   * @param state - the chat's console state.
   * @param sessionId - the emitting session.
   * @param event - the raw session event.
   * @returns after the push dispatches.
   */
  async #pushEvent(chatId, state, sessionId, event) {
    switch (event.type) {
      case "turn/start": {
        const messageId = await this.#transport.sendMessage(chatId, "\u{1F914} thinking\u2026");
        state.stream = { messageId, text: "" };
        state.turnUsage = emptyRoundUsage();
        state.turnActions = [];
        state.turnStartTime = event.time;
        state.typing = true;
        break;
      }
      case "assistant/message": {
        accumulateRoundUsage(state.turnUsage, event.data.usage);
        const text = blockText(event.data.message.content);
        if (text !== "") await this.#publishAssistant(chatId, state, text);
        state.turnActions.push(...messageActions(event.data.message, event.time));
        break;
      }
      case "turn/end": {
        const stream = state.stream;
        const reason = event.data.reason;
        const label = reason.kind === "completed" && stream !== void 0 && stream.text !== "" ? void 0 : turnOutcomeLabel(reason);
        const footer = roundUsageFooter(state.turnUsage);
        const toolHtml = actionsHtml(state.turnActions, this.#now());
        state.stream = void 0;
        state.typing = false;
        state.turnActions = [];
        state.turnStartTime = void 0;
        for (const [rpcId, pending] of [...state.pendingAsks]) {
          if (!pending.answered) continue;
          await this.#transport.editInlineKeyboard(chatId, pending.messageId, "\u2705 \u5DF2\u56DE\u7B54\u3002", []);
          state.pendingAsks.delete(rpcId);
        }
        if (footer === "" && toolHtml === "") {
          try {
            if (stream !== void 0) {
              await this.#transport.editMessage(
                chatId,
                stream.messageId,
                label === void 0 ? stream.text : stream.text === "" ? label : `${stream.text}
${label}`
              );
            } else {
              await this.#reply(chatId, label ?? "");
            }
          } catch (error) {
            if (stream === void 0) throw error;
            console.warn(`telegram: turn label edit failed, sending a fresh message instead: ${String(error)}`);
            if (label !== void 0) await this.#reply(chatId, label);
          }
          break;
        }
        let body;
        if (stream === void 0 || stream.text === "") {
          body = label ?? "";
        } else if (label === void 0) {
          body = stream.text;
        } else {
          body = `${stream.text}
${label}`;
        }
        const html = markdownToTelegramHtml(body) + (toolHtml === "" ? "" : "\n\n" + toolHtml) + footer;
        try {
          if (stream !== void 0) {
            await this.#transport.editMessageHtml(chatId, stream.messageId, html);
          } else {
            await this.#transport.sendMessageHtml(chatId, html);
          }
        } catch (error) {
          if (stream === void 0) throw error;
          console.warn(`telegram: turn footer edit failed, sending a fresh message instead: ${String(error)}`);
          await this.#transport.sendMessageHtml(chatId, html);
        }
        break;
      }
      default:
        break;
      case "question/asked": {
        await this.#renderAsk(chatId, state, sessionId, event.data.id, event.data.questions);
        break;
      }
      case "question/decided": {
        await this.#settleAsk(chatId, state, event.data.id, event.data.outcome);
        break;
      }
    }
  }
  /**
   * Drive the Telegram typing indicator for chats whose bound session runs a
   * turn. Called on a fixed interval by the entry.
   * @returns after every pending chat action dispatched.
   */
  async pumpTyping() {
    for (const [chatId, state] of this.#chats) {
      if (state.typing) {
        await this.#transport.sendChatAction(chatId, "typing");
      }
    }
  }
  #state(chatId) {
    let state = this.#chats.get(chatId);
    if (state === void 0) {
      state = {
        sessionId: void 0,
        rows: void 0,
        workspaces: void 0,
        attachScopes: false,
        keyboard: void 0,
        attachKeyboard: void 0,
        typing: false,
        stream: void 0,
        turnUsage: emptyRoundUsage(),
        turnActions: [],
        turnStartTime: void 0,
        awaitingRename: false,
        pendingAsks: /* @__PURE__ */ new Map(),
        awaitingAskAnswer: void 0,
        nextPreset: void 0,
        awaitingConfirm: void 0
      };
      this.#chats.set(chatId, state);
    }
    return state;
  }
  /**
   * Handle one allowed chat's inline-button tap. Two surfaces share the
   * same chat: the /attach picker buttons (workspace scopes, session binds)
   * and the rendered ask buttons. A tap on a stale or unknown button gets a
   * ⛔ reply; attach taps navigate or bind, and ask taps mutate the pending
   * ask (option pick, custom-answer arm, submit, cancel) and settle it
   * through the port.
   * @param chatId - the sender chat id.
   * @param data - the button's callback data.
   * @returns after the reply/edit for this tap dispatches.
   */
  async handleCallback(chatId, data) {
    const state = this.#state(chatId);
    const attach = parseAttachCallback(data);
    if (attach !== void 0) {
      try {
        switch (attach.kind) {
          case "session":
            await this.#performAttach(chatId, state, attach.sessionId);
            break;
          case "workspace":
            await this.#attachWorkspaceSessions(chatId, state, attach.workspaceId);
            break;
          case "ungrouped":
            await this.#attachUngrouped(chatId, state);
            break;
          case "archived":
            await this.#attachArchived(chatId, state);
            break;
        }
      } catch (error) {
        await this.#reply(chatId, `\u26D4 ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    const list = parseSessionListCallback(data);
    if (list !== void 0) {
      try {
        if (list.kind === "stop") {
          await this.#port.stopSession(list.sessionId);
          await this.#reply(chatId, "\u23F9 \u5DF2\u8BF7\u6C42\u505C\u6B62\u3002");
        } else {
          const details = await this.#statusDetails(chatId, list.sessionId);
          if (details !== void 0) await this.#reply(chatId, details);
        }
      } catch (error) {
        await this.#reply(chatId, `\u26D4 ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    const parsed = parseQuestionCallback(data);
    if (parsed === void 0) {
      await this.#reply(chatId, "\u26D4 \u672A\u77E5\u6309\u94AE\u3002");
      return;
    }
    const pending = state.pendingAsks.get(parsed.rpcId);
    if (pending === void 0 || pending.answered) {
      await this.#reply(chatId, "\u26D4 \u8BE5\u63D0\u95EE\u5DF2\u5931\u6548\uFF08\u53EF\u80FD\u5DF2\u5728\u522B\u5904\u56DE\u7B54\uFF09\u3002");
      return;
    }
    try {
      switch (parsed.kind) {
        case "option": {
          await this.#tapOption(chatId, pending, parsed.questionIndex, parsed.optionIndex);
          break;
        }
        case "custom": {
          await this.#armCustom(chatId, state, pending, parsed.questionIndex);
          break;
        }
        case "submit": {
          await this.#submitAsk(chatId, pending);
          break;
        }
        case "cancel": {
          await this.#cancelAsk(chatId, state, pending);
          break;
        }
      }
    } catch (error) {
      await this.#reply(chatId, `\u26D4 ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /**
   * Render one ask batch for one chat: one message with the questions text
   * and the option/action keyboard, plus the chat's answer-collection state.
   * @param chatId - the target chat.
   * @param state - the chat's console state.
   * @param sessionId - the session owning the ask (the chat's binding).
   * @param rpcId - the host question id.
   * @param questions - the questions of the ask batch.
   * @returns after the keyboard message dispatches.
   */
  async #renderAsk(chatId, state, sessionId, rpcId, questions) {
    const messageId = await this.#transport.sendInlineKeyboard(
      chatId,
      questionMessageText(questions),
      questionKeyboard(questions, questions.map(() => []), questions.map(() => void 0), rpcId)
    );
    state.pendingAsks.set(rpcId, {
      rpcId,
      sessionId,
      messageId,
      questions,
      selected: questions.map(() => []),
      custom: questions.map(() => void 0),
      answered: false
    });
  }
  /**
   * Finalize one rendered ask when the host settles it (answered elsewhere,
   * cancelled, or answered here): a cancelled ask is dropped immediately,
   * while an answered ask shows the in-progress label and stays registered
   * until the owning turn closes — the agent's reply is only complete then,
   * so the keyboard is finalized by {@link onSessionEvent}'s turn/end arm.
   * @param chatId - the chat holding the message.
   * @param state - the chat's console state.
   * @param rpcId - the settled question id.
   * @param outcome - the settlement outcome.
   * @returns after the edit dispatches.
   */
  async #settleAsk(chatId, state, rpcId, outcome) {
    const pending = state.pendingAsks.get(rpcId);
    if (pending === void 0) return;
    if (state.awaitingAskAnswer?.rpcId === rpcId) state.awaitingAskAnswer = void 0;
    if (outcome === "cancelled") {
      await this.#transport.editInlineKeyboard(
        chatId,
        pending.messageId,
        "\u{1F6AB} \u5DF2\u53D6\u6D88\u3002",
        []
      );
      state.pendingAsks.delete(rpcId);
      return;
    }
    await this.#transport.editInlineKeyboard(
      chatId,
      pending.messageId,
      "\u23F3 \u56DE\u7B54\u4E2D\u2026",
      []
    );
    pending.answered = true;
  }
  /** Re-render one pending ask's keyboard from the collected answer state. */
  async #refreshAskKeyboard(chatId, pending) {
    await this.#transport.editInlineKeyboard(
      chatId,
      pending.messageId,
      questionMessageText(pending.questions),
      questionKeyboard(pending.questions, pending.selected, pending.custom, pending.rpcId)
    );
  }
  /**
   * Handle one option-button tap. A single-select ask of exactly one question
   * answers immediately with the tapped option; any other tap collects the
   * selection (multi-select toggles, single-select replaces) and re-renders
   * the keyboard for the user to finish with submit.
   * @param chatId - the sender chat id.
   * @param state - the chat's console state.
   * @param pending - the live pending ask.
   * @param questionIndex - the tapped question.
   * @param optionIndex - the tapped option.
   * @returns after the answer or keyboard refresh dispatches.
   */
  async #tapOption(chatId, pending, questionIndex, optionIndex) {
    const question = pending.questions[questionIndex];
    const option = question?.options?.[optionIndex];
    if (question === void 0 || option === void 0) {
      await this.#reply(chatId, "\u26D4 \u8BE5\u63D0\u95EE\u5DF2\u5931\u6548\uFF08\u9009\u9879\u5DF2\u66F4\u65B0\uFF0C\u8BF7\u91CD\u9009\uFF09\u3002");
      return;
    }
    const isMulti = question.multiSelect === true;
    const selected = pending.selected[questionIndex];
    if (selected === void 0) return;
    if (isMulti) {
      const at = selected.indexOf(option.label);
      if (at === -1) selected.push(option.label);
      else selected.splice(at, 1);
    } else {
      pending.selected[questionIndex] = [option.label];
      pending.custom[questionIndex] = void 0;
    }
    if (!isMulti && pending.questions.length === 1) {
      await this.#submitAsk(chatId, pending);
      return;
    }
    await this.#refreshAskKeyboard(chatId, pending);
  }
  /**
   * Arm the custom-answer flow for one question: the next non-command text
   * in the chat becomes its custom answer instead of a prompt. For
   * single-select questions the collected option is dropped, keeping the
   * answer shape valid (a single-select answer may not carry both).
   * @param chatId - the sender chat id.
   * @param state - the chat's console state.
   * @param pending - the live pending ask.
   * @param questionIndex - the question to answer in free text.
   * @returns after the hint reply dispatches.
   */
  async #armCustom(chatId, state, pending, questionIndex) {
    const question = pending.questions[questionIndex];
    if (question === void 0) return;
    if (question.multiSelect !== true) pending.selected[questionIndex] = [];
    state.awaitingRename = false;
    state.awaitingAskAnswer = { rpcId: pending.rpcId, questionIndex };
    await this.#reply(chatId, `\u270D\uFE0F \u8BF7\u76F4\u63A5\u8F93\u5165\u5BF9\u300C${truncate(question.question, 60)}\u300D\u7684\u56DE\u7B54\uFF08\u53D1\u9001\u6587\u672C\u5373\u53EF\uFF09\u3002`);
  }
  /**
   * Submit the collected answer batch for one ask. Every question must carry
   * at least one picked option or a captured custom answer; the host rejects
   * incomplete batches, so the submit is blocked here with a hint instead.
   * @param chatId - the sender chat id.
   * @param state - the chat's console state.
   * @param pending - the live pending ask.
   * @returns after the answer settles or the incompleteness hint dispatches.
   */
  async #submitAsk(chatId, pending) {
    const answers = pending.questions.map((question, index) => {
      const custom = pending.custom[index]?.trim();
      const selected = pending.selected[index];
      if (custom !== void 0 && custom !== "") {
        return { id: question.id, selected: question.multiSelect === true ? selected ?? [] : [], custom };
      }
      if (selected !== void 0 && selected.length > 0) {
        return { id: question.id, selected };
      }
      return void 0;
    });
    const incomplete = pending.questions.findIndex((_, index) => answers[index] === void 0);
    if (incomplete !== -1) {
      const question = pending.questions[incomplete];
      if (question === void 0) return;
      await this.#reply(
        chatId,
        `\u26D4 \u8FD8\u6709\u95EE\u9898\u300C${truncate(question.question, 40)}\u300D\u672A\u56DE\u7B54\uFF1A\u9009\u62E9\u9009\u9879\u6216\u70B9\u300C\u270D\uFE0F \u81EA\u5B9A\u4E49\u56DE\u7B54\u300D\u3002`
      );
      return;
    }
    await this.#port.answerQuestion(pending.rpcId, pending.sessionId, {
      answers
    });
  }
  /**
   * Cancel one pending ask (the host rejects it as cancelled; the turn's tool
   * call fails closed). The decided event finalizes the rendered message.
   * @param chatId - the sender chat id.
   * @param state - the chat's console state.
   * @param pending - the live pending ask.
   * @returns after the cancel dispatches.
   */
  async #cancelAsk(chatId, state, pending) {
    await this.#port.cancelQuestion(pending.rpcId);
    if (state.awaitingAskAnswer?.rpcId === pending.rpcId) state.awaitingAskAnswer = void 0;
    await this.#reply(chatId, "\u{1F6AB} \u5DF2\u53D6\u6D88\u8BE5\u63D0\u95EE\u3002");
  }
  /**
   * Consume one free-text message as the custom answer of an armed question:
   * record it (blank text cancels the arm) and let the user finish with
   * submit. A binding change or a `/` command clears the arm before this
   * path can run.
   * @param chatId - the sender chat id.
   * @param state - the chat's console state.
   * @param awaiting - the armed question (rpcId + index).
   * @param text - the raw incoming text.
   * @returns after the answer record or cancel dispatches.
   */
  async #handleAskCustomText(chatId, state, awaiting, text) {
    state.awaitingAskAnswer = void 0;
    const pending = state.pendingAsks.get(awaiting.rpcId);
    if (pending === void 0) {
      await this.#reply(chatId, "\u26D4 \u8BE5\u63D0\u95EE\u5DF2\u5931\u6548\uFF08\u53EF\u80FD\u5DF2\u5728\u522B\u5904\u56DE\u7B54\uFF09\u3002");
      return;
    }
    const question = pending.questions[awaiting.questionIndex];
    if (question === void 0) return;
    const custom = text.trim();
    if (custom === "") {
      await this.#reply(chatId, "\u21A9\uFE0F \u5DF2\u53D6\u6D88\u81EA\u5B9A\u4E49\u56DE\u7B54\u3002");
      return;
    }
    if (question.multiSelect !== true) pending.selected[awaiting.questionIndex] = [];
    pending.custom[awaiting.questionIndex] = custom;
    await this.#refreshAskKeyboard(chatId, pending);
    await this.#reply(chatId, `\u2705 \u5DF2\u8BB0\u5F55\u5BF9\u300C${truncate(question.question, 40)}\u300D\u7684\u56DE\u7B54\uFF0C\u70B9\u300C\u2705 \u63D0\u4EA4\u56DE\u7B54\u300D\u5B8C\u6210\u3002`);
  }
  /** Drop every rendered ask and the custom-answer arm (the binding changed). */
  #clearAsks(state) {
    state.pendingAsks.clear();
    state.awaitingAskAnswer = void 0;
  }
  /**
   * Consume one free-text title a bare `/rename` is awaiting: apply it to the
   * bound session and confirm, cancel on blank text, and report when the
   * binding vanished meanwhile. Any non-command text counts as the title —
   * including backslash-escaped input, which never interprets as a command.
   * The pending flag clears before the first reply.
   * @param chatId - the sender chat id.
   * @param state - the chat's console state.
   * @param text - the candidate title text.
   * @returns after the rename or cancel dispatches.
   */
  async #handlePendingRename(chatId, state, text) {
    state.awaitingRename = false;
    const title = text.trim();
    if (title === "") {
      await this.#reply(chatId, "\u21A9\uFE0F \u5DF2\u53D6\u6D88\u91CD\u547D\u540D\u3002");
      return;
    }
    const sessionId = state.sessionId;
    if (sessionId === void 0) {
      await this.#reply(chatId, "\u26D4 \u5F53\u524D\u65E0\u6FC0\u6D3B\u4F1A\u8BDD\uFF0C\u65E0\u6CD5\u91CD\u547D\u540D\u3002\u8BF7\u5148\u7ED1\u5B9A\u4F1A\u8BDD\uFF08\u5982 /attach\uFF09\u3002");
      return;
    }
    try {
      const accepted = await this.#port.renameSession(sessionId, title);
      await this.#reply(chatId, `\u2705 \u5DF2\u91CD\u547D\u540D\u4E3A ${accepted}`);
    } catch (error) {
      await this.#reply(chatId, `\u26D4 ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /**
   * Forward one free-text prompt to the bound session.
   * @param chatId - the sender chat id.
   * @param state - the chat's console state.
   * @param text - the prompt text.
   * @returns after the forward dispatches (a refusal reply on failure).
   */
  async #handlePrompt(chatId, state, text) {
    const sessionId = state.sessionId;
    if (sessionId === void 0) {
      await this.#reply(chatId, "\u8FD8\u6CA1\u6709\u7ED1\u5B9A\u4F1A\u8BDD\u3002\u53D1 /attach\uFF08\u65E0\u53C2\u6570\u5148\u9009\u5DE5\u4F5C\u533A/\u672A\u5206\u7EC4/\u5F52\u6863\uFF09\u9009\u62E9\u5E76\u7ED1\u5B9A\u4E00\u4E2A\u4F1A\u8BDD\u3002");
      return;
    }
    if (text.trim() === "") return;
    try {
      if (state.typing) {
        await this.#port.sendPrompt(sessionId, "steer", text);
        return;
      }
      await this.#port.sendPrompt(sessionId, "queue", text);
      await this.#reply(chatId, `\u{1F4E5} \u5DF2\u52A0\u5165\u961F\u5217\uFF1A${truncate(text, QUEUE_ACK_MAX)}`);
    } catch (error) {
      await this.#reply(chatId, `\u26D4 ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async #handleCommand(chatId, state, command) {
    if (state.awaitingConfirm !== void 0 && state.awaitingConfirm.command !== command.name) {
      state.awaitingConfirm = void 0;
    }
    switch (command.name) {
      case "start":
        await this.#resetActionRows(chatId, state);
        await this.#reply(chatId, HELP_TEXT);
        return;
      case "attach":
        await this.#commandAttach(chatId, state, command.args);
        return;
      case "keyboard":
        await this.#commandKeyboard(chatId, state);
        return;
      case "close":
        return this.#commandClose(chatId, state);
      case "stop":
        await this.#commandStop(chatId, state, command.args);
        return;
      case "status":
        await this.#commandStatus(chatId, state, command.args);
        return;
      case "model":
        await this.#commandModel(chatId, state, command.args);
        return;
      case "create":
        return this.#commandCreate(chatId, state);
      case "operate":
        return this.#commandOperate(chatId, state);
      case "new":
        await this.#commandNew(chatId, state, command.args);
        return;
      case "rename":
        await this.#commandRename(chatId, state, command.args);
        return;
      case "fork":
        await this.#commandFork(chatId, state, command.args);
        return;
      case "archive":
        await this.#commandArchive(chatId, state, command.args);
        return;
      case "delete":
        await this.#commandDelete(chatId, state, command.args);
        return;
      case "curtasks":
        await this.#commandCurTasks(chatId, state);
        return;
      case "preset":
        await this.#commandPreset(chatId, state, command.args);
        return;
      default:
        await this.#reply(chatId, `\u672A\u77E5\u547D\u4EE4 /${command.name}\u3002\u53D1\u9001 /start \u67E5\u770B\u53EF\u7528\u547D\u4EE4\u3002`);
    }
  }
  /**
   * Print the visible session list with a reply keyboard whose session
   * buttons carry finished `/delete <n> · <title>` commands — tapping sends
   * the command verbatim, so a parameterless invocation never dead-ends on a
   * missing-argument error. Updates `state.rows` and clears the /attach
   * scope-picker state, so a following numeric `/attach <n>` resolves inside
   * this list; an empty list degrades to a hint. Records the list as the
   * chat's visible keyboard, so a delete or rename re-emits it with the same
   * hint. (/stop and /status never reach here — their lists are inline.)
   * @param chatId - the target chat.
   * @param state - the chat's console state.
   * @param hint - the header line above the list.
   * @returns after the keyboard message dispatches.
   */
  async #sessionListKeyboard(chatId, state, hint) {
    const items = await this.#port.listSessions();
    const visible = items.filter((item) => !item.blank && item.origin !== "subagent");
    state.rows = visible;
    state.attachScopes = false;
    state.attachKeyboard = void 0;
    if (visible.length === 0) {
      state.keyboard = void 0;
      await this.#reply(chatId, "\u5F53\u524D\u6CA1\u6709\u53EF\u7528\u4F1A\u8BDD\u3002\u7528 /new \u521B\u5EFA\u4E00\u4E2A\u3002");
      return;
    }
    state.keyboard = { kind: "sessions", hint, recipe: { list: "full" } };
    const now = this.#now();
    const body = visible.slice(0, SESSION_KEYBOARD_MAX).map((item, index) => sessionRow(index + 1, item, now)).join("\n");
    await this.#transport.sendReplyKeyboard(chatId, `${hint}

${body}`, sessionKeyboardRows(visible, "delete"));
  }
  /**
   * Print the visible session list as an inline keyboard whose buttons carry
   * callback actions — `/stop` stops the tapped session, `/status` shows its
   * details — the `/attach`-picker interaction, so the reply keyboard area
   * stays untouched. Updates `state.rows` so the typed `/status <n>` path
   * keeps working; an empty list degrades to a hint.
   * @param chatId - the target chat.
   * @param state - the chat's console state.
   * @param hint - the header line above the list.
   * @param verb - the action the buttons carry (`stop` or `status`).
   * @returns after the keyboard message dispatches.
   */
  async #sessionListInline(chatId, state, hint, verb) {
    const items = await this.#port.listSessions();
    const visible = items.filter((item) => !item.blank && item.origin !== "subagent");
    state.rows = visible;
    state.attachScopes = false;
    if (visible.length === 0) {
      state.keyboard = void 0;
      await this.#reply(chatId, "\u5F53\u524D\u6CA1\u6709\u53EF\u7528\u4F1A\u8BDD\u3002\u7528 /new \u521B\u5EFA\u4E00\u4E2A\u3002");
      return;
    }
    const now = this.#now();
    const body = visible.slice(0, SESSION_KEYBOARD_MAX).map((item, index) => sessionRow(index + 1, item, now)).join("\n");
    await this.#transport.sendInlineKeyboard(
      chatId,
      `${hint}

${body}

${SESSION_STATE_LEGEND}`,
      sessionActionButtons(visible, verb)
    );
  }
  /**
   * Print the workspace list with a reply keyboard whose buttons carry
   * `/new <n> · <title>` (create a session inside that workspace) plus the
   * ungrouped-create row — a parameterless creation flow that never needs an
   * id. Updates `state.workspaces` for `/new <n>` selectors; an empty
   * registry degrades to a hint.
   * @param chatId - the target chat.
   * @param state - the chat's console state.
   * @param hint - the header line above the list.
   * @returns after the keyboard message dispatches.
   */
  async #workspaceListKeyboard(chatId, state, hint) {
    const items = await this.#port.listWorkspaces();
    state.workspaces = [...items];
    state.attachKeyboard = void 0;
    if (items.length === 0) {
      state.keyboard = void 0;
      await this.#reply(chatId, "\u8FD8\u6CA1\u6709\u5DE5\u4F5C\u533A\u3002\u53D1 /new <\u670D\u52A1\u5668\u76EE\u5F55\u8DEF\u5F84> \u65B0\u5EFA\u5DE5\u4F5C\u533A\u5E76\u521B\u5EFA\u4F1A\u8BDD\uFF0C\u6216 /new none \u521B\u5EFA\u672A\u5206\u7C7B\u4F1A\u8BDD\u3002");
      return;
    }
    state.keyboard = { kind: "workspaces" };
    const body = items.slice(0, WORKSPACE_KEYBOARD_MAX).map((item, index) => workspaceRow(index + 1, item)).join("\n");
    await this.#transport.sendReplyKeyboard(chatId, `${hint}

${body}`, workspaceKeyboardRows(items));
  }
  /**
   * Resolve a bare index as a 1-based row of the last workspace-keyboard
   * output (opened by a bare `/new`).
   * @param state - the chat's console state.
   * @param raw - the numeric selector.
   * @returns the workspace row, or undefined when the index is stale.
   */
  #resolveWorkspace(state, raw) {
    if (!/^\d+$/.test(raw)) return void 0;
    return state.workspaces?.at(Number(raw) - 1);
  }
  /**
   * The sessions the /attach scopes surface, partitioned once: archived
   * membership wins over workspace accounting (an archived session stays
   * hidden from its workspace group), then the owning workspace, then
   * ungrouped. Display order follows the session list (updatedAt descending).
   * @returns the partition for the /attach scope flow.
   */
  async #partitionSessions() {
    const [items, archivedIds, workspaces] = await Promise.all([
      this.#port.listSessions(),
      this.#port.listArchivedSessionIds(),
      this.#port.listWorkspaces()
    ]);
    const visible = items.filter((item) => !item.blank && item.origin !== "subagent");
    const archived = new Set(archivedIds);
    const archivedList = [];
    const ungrouped = [];
    const byWorkspace = /* @__PURE__ */ new Map();
    for (const item of visible) {
      if (archived.has(item.sessionId)) {
        archivedList.push(item);
        continue;
      }
      const workspace = workspaces.find((entry) => entry.sessionIds.includes(item.sessionId));
      if (workspace === void 0) {
        ungrouped.push(item);
        continue;
      }
      const bucket = byWorkspace.get(workspace.workspaceId);
      if (bucket === void 0) byWorkspace.set(workspace.workspaceId, [item]);
      else bucket.push(item);
    }
    return { workspaces, archived: archivedList, ungrouped, byWorkspace };
  }
  /**
   * Bind this chat to the target session and show its last {@link ATTACH_ROUNDS}
   * user/assistant exchanges. A bare invocation opens the scope picker as
   * inline buttons (workspaces, ungrouped, archived) and installs the attach
   * keyboard (running sessions, then the five most recently completed) beside
   * it; `none` lists the ungrouped sessions, `arc` (or `archived`) the
   * archived ones, and picking a workspace or a session is a tap on the
   * picker's inline buttons. While the attach keyboard is installed a numeric
   * `/attach <n>` binds its rows (typed or tapped alike); with no attach
   * keyboard up a number still selects the workspace row, and otherwise the
   * target resolves inside the last visible session list. The history read
   * happens before the binding changes, so a bad id never displaces an open
   * session.
   * @param chatId - the target chat.
   * @param state - the chat's console state.
   * @param args - the argument text.
   * @returns after the bind or list reply dispatches.
   */
  async #commandAttach(chatId, state, args) {
    await this.#resetActionRows(chatId, state);
    const [rawTarget] = splitArgs(args);
    if (rawTarget === "") {
      await this.#attachScopePicker(chatId, state);
      return;
    }
    if (rawTarget === "none") {
      await this.#attachUngrouped(chatId, state);
      return;
    }
    if (rawTarget === "arc" || rawTarget === "archived") {
      await this.#attachArchived(chatId, state);
      return;
    }
    if (/^\d+$/.test(rawTarget) && state.attachKeyboard !== void 0) {
      const row = state.attachKeyboard.at(Number(rawTarget) - 1);
      if (row === void 0) {
        await this.#reply(chatId, `\u5E8F\u53F7 ${rawTarget} \u8D85\u51FA\u8303\u56F4\uFF1A\u5148 /attach \u5237\u65B0\u5217\u8868`);
        return;
      }
      await this.#performAttach(chatId, state, row.sessionId);
      return;
    }
    if (state.attachScopes && /^\d+$/.test(rawTarget)) {
      const workspace = state.workspaces?.at(Number(rawTarget) - 1);
      if (workspace === void 0) {
        await this.#reply(chatId, `\u5DE5\u4F5C\u533A\u5E8F\u53F7 ${rawTarget} \u8D85\u51FA\u8303\u56F4\uFF1A\u5148 /attach \u5237\u65B0\u8303\u56F4\u5217\u8868`);
        return;
      }
      await this.#attachWorkspaceSessions(chatId, state, workspace.workspaceId);
      return;
    }
    const resolved = this.#resolveTarget(state, rawTarget);
    if ("miss" in resolved) {
      await this.#reply(chatId, resolved.miss);
      return;
    }
    await this.#performAttach(chatId, state, resolved.id);
  }
  /**
   * Bind this chat to one session and show its attach preview: the last
   * {@link ATTACH_ROUNDS} assistant replies (user messages never render),
   * the in-progress marker while the turn is still open, and any
   * unanswered ask re-rendered as an answerable keyboard. A finished session
   * (its latest turn has ended) closes the preview with the same token-usage
   * footer a streamed turn ends with — the `assistant/message` usage of its
   * last completed turn. The binding also reconciles the chat's live-stream
   * state with the attached history: an open turn drives the typing
   * indicator and seeds the turn usage/footer clock, a closed one stops any
   * leftover typing and drops a stale stream from a previous binding. Shared
   * by the typed `/attach <id>` path and the inline session buttons.
   * @param chatId - the target chat.
   * @param state - the chat's console state.
   * @param sessionId - the session to bind.
   * @returns after the preview dispatches.
   */
  async #performAttach(chatId, state, sessionId) {
    const events = await this.#port.readHistory(sessionId, ATTACH_READ_LIMIT);
    const open = turnOpen(events);
    state.sessionId = sessionId;
    this.#clearAsks(state);
    state.stream = void 0;
    state.turnActions = [];
    state.typing = open;
    state.turnStartTime = open ? latestTurnStartTime(events) : void 0;
    state.turnUsage = open ? openTurnUsage(events) : emptyRoundUsage();
    const replies = assistantTail(events, ATTACH_ROUNDS);
    const preview = replies.length === 0 ? "\uFF08\u7A7A\u767D\u4F1A\u8BDD\uFF09" : replies.map((text) => `${ASSISTANT_ROLE_GLYPH} ${text}`).join("\n");
    const header = `\u{1F517} \u5DF2\u7ED1\u5B9A ${sessionId}\uFF08${shortSessionId(sessionId)}\uFF09

\u6700\u8FD1 ${ATTACH_ROUNDS} \u8F6E\u5BF9\u8BDD\uFF1A`;
    for (const chunk of chunkText(`${header}
${preview}`)) {
      await this.#transport.sendMessageHtml(chatId, markdownToTelegramHtml(chunk));
    }
    if (open) {
      const toolHtml = stepActionsHtml(events, this.#now(), ATTACH_ACTION_LIMIT);
      if (toolHtml !== "") {
        await this.#transport.sendMessageHtml(chatId, "\u{1F527} \u8FDB\u884C\u4E2D\uFF1A\n" + toolHtml);
      } else {
        await this.#transport.sendMessageHtml(chatId, "\u23F3 \u8FDB\u884C\u4E2D\u2026");
      }
    }
    for (const batch of pendingAskBatches(events)) {
      await this.#renderAsk(chatId, state, sessionId, batch.id, batch.questions);
    }
    if (!open) {
      const footer = roundUsageFooter(lastTurnUsage(events));
      if (footer !== "") {
        await this.#transport.sendMessageHtml(chatId, footer);
      }
    }
  }
  /** The scope picker: workspaces first, then ungrouped and archived when non-empty. */
  async #attachScopePicker(chatId, state) {
    const { workspaces, ungrouped, archived } = await this.#partitionSessions();
    state.workspaces = [...workspaces];
    state.rows = void 0;
    state.attachScopes = true;
    state.keyboard = { kind: "scopes" };
    const body = workspaces.length === 0 ? "\u8FD8\u6CA1\u6709\u5DE5\u4F5C\u533A\u3002" : workspaces.slice(0, WORKSPACE_KEYBOARD_MAX).map((item, index) => workspaceRow(index + 1, item)).join("\n");
    const scopes = [
      ...ungrouped.length > 0 ? ["/attach none\uFF08\u672A\u5206\u7EC4\uFF09"] : [],
      ...archived.length > 0 ? ["/attach arc\uFF08\u5F52\u6863\uFF09"] : []
    ];
    const header = scopes.length === 0 ? "\u9009\u62E9\u4F1A\u8BDD\u8303\u56F4\uFF1A\u70B9\u4E0B\u65B9\u7684\u8303\u56F4\u6309\u94AE\uFF0C\u6216\u76F4\u63A5 /attach <\u4F1A\u8BDDid>\u3002" : `\u9009\u62E9\u4F1A\u8BDD\u8303\u56F4\uFF1A\u70B9\u4E0B\u65B9\u7684\u8303\u56F4\u6309\u94AE\uFF08\u6216 ${scopes.join("\u3001")}\uFF09\uFF0C\u6216\u76F4\u63A5 /attach <\u4F1A\u8BDDid>\u3002`;
    await this.#attachKeyboardInstall(chatId, state);
    await this.#transport.sendInlineKeyboard(
      chatId,
      `${header}

${body}`,
      attachScopeButtons(workspaces, { ungrouped: ungrouped.length > 0, archived: archived.length > 0 })
    );
  }
  /**
   * List one scope's sessions with inline bind buttons; the numbered rows
   * keep the typed `/attach <n>` path working alongside the taps. Records
   * the list as the chat's visible keyboard with its re-emission recipe, so
   * a delete or rename re-emits the same scoped list; an empty scope
   * degrades to a hint.
   * @param chatId - the target chat.
   * @param state - the chat's console state.
   * @param hint - the header line above the list.
   * @param items - the scope's session summaries in display order.
   * @param recipe - the keyboard's re-emission recipe.
   * @returns after the keyboard message dispatches.
   */
  async #attachList(chatId, state, hint, items, recipe) {
    state.rows = [...items];
    state.attachScopes = false;
    if (items.length === 0) {
      state.keyboard = void 0;
      await this.#reply(chatId, `${hint}\uFF08\u6682\u65E0\u4F1A\u8BDD\uFF09`);
      return;
    }
    state.keyboard = { kind: "sessions", hint, recipe };
    const now = this.#now();
    const body = items.slice(0, SESSION_KEYBOARD_MAX).map((item, index) => sessionRow(index + 1, item, now)).join("\n");
    await this.#transport.sendInlineKeyboard(
      chatId,
      `${hint}

${body}

${SESSION_STATE_LEGEND}`,
      attachSessionButtons(items)
    );
    if (state.attachKeyboard === void 0) {
      await this.#attachKeyboardInstall(chatId, state);
    }
  }
  /**
   * The /attach keyboard's fixed content: every running session (no count
   * cap), then the five most recently completed ones, mixed globally across
   * scopes. Blank, subagent-internal, and archived sessions stay out of the
   * keyboard (an archived session surfaces only through the /attach arc
   * scope), so the keyboard mirrors the non-archived scope lists.
   * @returns the keyboard's session summaries in display order.
   */
  async #attachKeyboardItems() {
    const [items, archivedIds] = await Promise.all([
      this.#port.listSessions(),
      this.#port.listArchivedSessionIds()
    ]);
    const archived = new Set(archivedIds);
    const visible = items.filter((item) => !item.blank && item.origin !== "subagent" && !archived.has(item.sessionId));
    const running = visible.filter((item) => item.running);
    const completed = visible.filter((item) => !item.running).sort((a, b) => b.updatedAt - a.updatedAt);
    return [...running, ...completed.slice(0, ATTACH_KEYBOARD_RECENT)];
  }
  /**
   * Install the /attach keyboard: the shared action rows plus one bind button
   * per highlight (running sessions, then the five most recently completed,
   * archived excluded), so the keyboard area always shows just those
   * sessions. The inline scope lists stay the chat-text surface (unchanged),
   * and the keyboard's own rows back the numeric `/attach <n>` selector while
   * it is installed — typed and tapped alike, because the install also
   * records the list as the session-list `state.rows` (the last session list
   * output), so every numeric selector resolves against the same fresh list.
   * @param chatId - the target chat.
   * @param state - the chat's console state (records the keyboard's rows).
   * @returns after the keyboard message dispatches.
   */
  async #attachKeyboardInstall(chatId, state) {
    const items = await this.#attachKeyboardItems();
    if (items.length === 0) return;
    state.attachKeyboard = items;
    state.rows = items;
    await this.#transport.sendReplyKeyboard(
      chatId,
      "\u{1F517} \u5FEB\u6377\u7ED1\u5B9A\uFF1A\u8FD0\u884C\u4E2D\u7684\u5168\u90E8\u4F1A\u8BDD\uFF0C\u52A0\u6700\u8FD1\u5B8C\u6210\u7684 5 \u4E2A\u3002\u70B9\u6309\u94AE\u76F4\u63A5\u7ED1\u5B9A\uFF08\u6216 /attach <\u5E8F\u53F7>\uFF09\u3002",
      attachKeyboardRows(items)
    );
  }
  async #attachUngrouped(chatId, state) {
    const { ungrouped } = await this.#partitionSessions();
    await this.#attachList(chatId, state, "\u672A\u5206\u7EC4\u4F1A\u8BDD\uFF1A", ungrouped, { list: "ungrouped" });
  }
  async #attachArchived(chatId, state) {
    const { archived } = await this.#partitionSessions();
    await this.#attachList(chatId, state, "\u5F52\u6863\u4F1A\u8BDD\uFF1A", archived, { list: "archived" });
  }
  async #attachWorkspaceSessions(chatId, state, workspaceId) {
    const { workspaces, byWorkspace } = await this.#partitionSessions();
    const workspace = workspaces.find((item) => item.workspaceId === workspaceId);
    if (workspace === void 0) {
      await this.#reply(chatId, "\u26D4 \u8BE5\u5DE5\u4F5C\u533A\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0 /attach\u3002");
      return;
    }
    await this.#attachList(
      chatId,
      state,
      `\u5DE5\u4F5C\u533A\u300C${workspace.title}\u300D\u7684\u4F1A\u8BDD\uFF1A`,
      byWorkspace.get(workspaceId) ?? [],
      { list: "workspace", workspaceId }
    );
  }
  /**
   * Dismiss the chat's reply keyboard behind a second confirmation: the first
   * `/close` arms, the second executes. The session binding stays — prompts
   * keep flowing to the bound session, and only the tappable command surface
   * goes away; any other command or free text cancels the arm.
   * @param chatId - the target chat.
   * @param state - the chat's console state (clears the visible-keyboard tracking).
   * @returns after the confirmation or dismissal message dispatches.
   */
  async #commandClose(chatId, state) {
    if (state.awaitingConfirm?.command === "close") {
      state.awaitingConfirm = void 0;
      state.keyboard = void 0;
      state.attachKeyboard = void 0;
      await this.#transport.removeKeyboard(chatId, "\u5DF2\u6536\u8D77\u5FEB\u6377\u952E\u76D8\uFF0C\u4F1A\u8BDD\u7ED1\u5B9A\u4E0D\u53D8\u3002");
      return;
    }
    state.awaitingConfirm = { command: "close" };
    await this.#reply(chatId, "\u26A0\uFE0F \u786E\u8BA4\u6536\u8D77\u5FEB\u6377\u952E\u76D8\uFF1F\u518D\u6B21\u53D1\u9001 /close \u786E\u8BA4\uFF08\u4F1A\u8BDD\u7ED1\u5B9A\u4E0D\u53D8\uFF1B\u5176\u5B83\u547D\u4EE4\u6216\u6587\u5B57\u53EF\u53D6\u6D88\uFF09\u3002");
  }
  /**
   * Reset a stale reply keyboard to the shared action rows when a command
   * whose own surface is not a reply keyboard runs, so picker rows (a
   * previous `/model`, `/preset`, `/new`, `/create`, or `/operate` list)
   * never linger in the input row. Live session lists — the `/delete`
   * reply list and the inline `/attach` lists — and the inline scope
   * picker stay untouched: the list-refresh path re-emits them, and no
   * keyboard pops where none is showing.
   * @param chatId - the target chat.
   * @param state - the chat's console state.
   * @returns after the keyboard message dispatches, if one does.
   */
  /**
   * Re-show the reply-keyboard area on demand (`/keyboard`): a chat with the
   * attach keyboard installed gets it re-installed with a fresh running-first
   * list (same refresh a bare `/attach` flow performs); any other chat gets
   * the shared action rows — so the keyboard area can always be brought back
   * after `/close` dismissed it or a picker replaced it.
   * @param chatId - the target chat.
   * @param state - the chat's console state.
   * @returns after the keyboard message dispatches.
   */
  async #commandKeyboard(chatId, state) {
    state.keyboard = { kind: "home" };
    if (state.attachKeyboard !== void 0) {
      await this.#attachKeyboardInstall(chatId, state);
      return;
    }
    await this.#transport.sendReplyKeyboard(chatId, "\u5DF2\u6253\u5F00\u952E\u76D8\u533A\u3002", KEYBOARD_ACTION_ROWS.map((row) => [...row]));
  }
  async #resetActionRows(chatId, state) {
    const keyboard = state.keyboard;
    if (keyboard === void 0) return;
    if (keyboard.kind === "home" || keyboard.kind === "sessions" || keyboard.kind === "scopes") return;
    state.keyboard = { kind: "home" };
    await this.#transport.sendReplyKeyboard(chatId, "\u{1F4CC} \u5FEB\u6377\u952E\u76D8\u5DF2\u56DE\u5230\u5E38\u7528\u64CD\u4F5C\u3002", KEYBOARD_ACTION_ROWS.map((row) => [...row]));
  }
  async #commandStop(chatId, state, args) {
    await this.#resetActionRows(chatId, state);
    const [rawTarget] = splitArgs(args);
    if (rawTarget !== "") {
      await this.#reply(chatId, "\u26D4 /stop \u4E0D\u9700\u8981\u53C2\u6570\uFF1A\u5B83\u505C\u6B62\u5F53\u524D\u7ED1\u5B9A\u7684\u4F1A\u8BDD\u3002");
      return;
    }
    const bound = state.sessionId;
    if (bound === void 0) {
      await this.#sessionListInline(chatId, state, "\u6CA1\u6709\u6253\u5F00\u4F1A\u8BDD\u3002\u70B9\u4E0B\u65B9\u6309\u94AE\u505C\u6B62\u5BF9\u5E94\u4F1A\u8BDD\uFF1A", "stop");
      return;
    }
    try {
      await this.#port.stopSession(bound);
      await this.#reply(chatId, "\u23F9 \u5DF2\u8BF7\u6C42\u505C\u6B62\u3002");
    } catch (error) {
      await this.#reply(chatId, `\u26D4 ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async #commandStatus(chatId, state, args) {
    await this.#resetActionRows(chatId, state);
    const [rawTarget] = splitArgs(args);
    if (rawTarget === "") {
      const bound = state.sessionId;
      if (bound === void 0) {
        await this.#sessionListInline(chatId, state, "\u6CA1\u6709\u6253\u5F00\u4F1A\u8BDD\u3002\u70B9\u4E0B\u65B9\u6309\u94AE\u67E5\u770B\u4F1A\u8BDD\u8BE6\u60C5\uFF1A", "status");
        return;
      }
      const details2 = await this.#statusDetails(chatId, bound);
      if (details2 !== void 0) await this.#reply(chatId, details2);
      return;
    }
    const resolved = this.#resolveTarget(state, rawTarget);
    if ("miss" in resolved) {
      await this.#reply(chatId, resolved.miss);
      return;
    }
    const details = await this.#statusDetails(chatId, resolved.id);
    if (details !== void 0) await this.#reply(chatId, details);
  }
  /**
   * Render one session's status lines, or a user-facing miss when it
   * vanished. The reply leads with the console version
   * ({@link TELEGRAM_VERSION}); the main line is the session's latest activity
   * from the history
   * tail (last assistant text, or the pending tool call when one is open, or
   * a hint for a blank page); the running state and metadata rows follow as
   * auxiliary lines, and the tail is a usage block — the history page's
   * user/assistant/tool counts and its display-character estimate
   * ({@link statusStats}, bounded by {@link HISTORY_DEFAULT_LIMIT} messages),
   * whose scope the printed message count makes explicit.
   */
  async #statusDetails(chatId, id) {
    const items = await this.#port.listSessions();
    const summaryItem = items.find((item) => item.sessionId === id);
    if (summaryItem === void 0) {
      await this.#reply(chatId, `\u4F1A\u8BDD ${shortSessionId(id)} \u4E0D\u5B58\u5728\u3002`);
      return void 0;
    }
    const events = await this.#port.readHistory(id, HISTORY_DEFAULT_LIMIT);
    const now = this.#now();
    const title = summaryItem.projections?.values.title;
    const stats = statusStats(events);
    return [
      `\u7248\u672C: ${TELEGRAM_VERSION}`,
      `\u{1F4CA} ${shortSessionId(summaryItem.sessionId)}`,
      summaryItem.running ? "\u{1F7E2} \u8FD0\u884C\u4E2D" : "\u26AA \u7A7A\u95F2",
      "",
      statusMainText(events),
      "",
      `\u76EE\u5F55: ${summaryItem.cwd ?? "\uFF08\u672A\u8BB0\u5F55\uFF09"}`,
      `\u66F4\u65B0: ${timeAgo(summaryItem.updatedAt, now)}`,
      `\u9884\u8BBE: ${summaryItem.agentPreset ?? "\u9ED8\u8BA4"}`,
      ...title === void 0 || title === null ? [] : [`\u6807\u9898: ${truncate(title, 80)}`],
      `\u6D88\u606F: \u7528\u6237 ${stats.users} \xB7 \u52A9\u624B ${stats.assistants} \xB7 \u5DE5\u5177\u8C03\u7528 ${stats.tools}`,
      `\u4E0A\u4E0B\u6587 ~${stats.chars} \u5B57\u7B26\uFF08\u8FD1 ${stats.users + stats.assistants} \u6761\u6D88\u606F\uFF09`
    ].join("\n");
  }
  /**
   * Set the global default model every future Agent starts from — no bound
   * session required. A bare invocation replaces the reply keyboard with the
   * configured model list (one `/model <provider>/<model-id>` button per
   * model); a named argument resolves by exact provider/model route first,
   * then by id or display-name prefix. A successful set confirms on a message
   * that dismisses the keyboard.
   * @param chatId - the target chat.
   * @param state - the chat's console state (clears the visible-keyboard tracking on confirm).
   * @param args - the argument text.
   * @returns after the picker or the set reply dispatches.
   */
  async #commandModel(chatId, state, args) {
    const name2 = args.trim();
    if (name2 === "") {
      await this.#modelListKeyboard(chatId, state);
      return;
    }
    const catalog = await this.#port.listGlobalModels();
    const match = this.#findModel(catalog, name2);
    if (match === void 0) {
      await this.#reply(chatId, `\u6CA1\u6709\u627E\u5230\u6A21\u578B ${name2}\u3002\u53D1\u9001 /model \u67E5\u770B\u53EF\u914D\u7F6E\u6A21\u578B\u5217\u8868\u3002`);
      return;
    }
    try {
      await this.#port.setGlobalDefaultModel(match.provider, match.model);
      state.keyboard = void 0;
      await this.#transport.removeKeyboard(chatId, `\u2705 \u5DF2\u8BBE\u7F6E\u5168\u5C40\u9ED8\u8BA4\u6A21\u578B ${match.providerName}/${match.modelName}`);
    } catch (error) {
      await this.#reply(chatId, `\u26D4 ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /**
   * Replace the reply keyboard with one button per configured model; tapping
   * one sends `/model <provider>/<model-id>` verbatim, so the tap applies
   * through the same named path and the keyboard dismisses on confirm.
   * @param chatId - the target chat.
   * @param state - the chat's console state (records the model picker as visible).
   * @returns after the keyboard message dispatches.
   */
  async #modelListKeyboard(chatId, state) {
    const catalog = await this.#port.listGlobalModels();
    const buttons = catalog.groups.flatMap((group) => group.models.map((model) => `/model ${group.id}/${model.id}`));
    if (buttons.length === 0) {
      state.keyboard = void 0;
      state.attachKeyboard = void 0;
      await this.#reply(chatId, "\u6682\u65E0\u53EF\u7528\u6A21\u578B\u3002");
      return;
    }
    state.keyboard = { kind: "model" };
    state.attachKeyboard = void 0;
    let text = "\u{1F39B} \u8BBE\u7F6E\u5168\u5C40\u9ED8\u8BA4\u6A21\u578B\uFF1A\n\n\u70B9\u6309\u94AE\u9009\u62E9\uFF0C\u6216\u53D1\u9001 /model <\u6A21\u578B\u540D> \u76F4\u63A5\u6307\u5B9A\u3002";
    if (buttons.length > MODEL_KEYBOARD_LIMIT) {
      text += `

\u8FD8\u6709 ${buttons.length - MODEL_KEYBOARD_LIMIT} \u4E2A\u6A21\u578B\u672A\u663E\u793A\u3002`;
    }
    if (catalog.failures.length > 0) {
      text += `

\u26A0\uFE0F \u90E8\u5206\u6A21\u578B\u52A0\u8F7D\u5931\u8D25\uFF1A
${catalog.failures.map((failure) => `${failure.name}\uFF08${failure.message}\uFF09`).join("\n")}`;
    }
    await this.#transport.sendReplyKeyboard(chatId, text, buttons.slice(0, MODEL_KEYBOARD_LIMIT).map((button) => [button]));
  }
  /**
   * The creation sub-menu: a reply keyboard with the two ways to start a
   * session — `/new` (fresh, workspace/ungrouped/path) and `/fork` (from the
   * bound session's last completed turn). Tapping either sends its command
   * verbatim, so the existing `/new` and `/fork` handlers run unchanged.
   * @param chatId - the target chat.
   * @param state - the chat's console state.
   * @returns after the menu dispatches.
   */
  async #commandCreate(chatId, state) {
    state.keyboard = { kind: "create" };
    state.attachKeyboard = void 0;
    await this.#transport.sendReplyKeyboard(
      chatId,
      "\u521B\u5EFA\u4F1A\u8BDD\uFF1A\u9009\u62E9\u4E00\u79CD\u65B9\u5F0F\u3002\n\n\xB7 /new \u2014 \u65B0\u5EFA\u4F1A\u8BDD\uFF08\u9009\u5DE5\u4F5C\u533A / \u672A\u5206\u7C7B / \u8DEF\u5F84\uFF09\n\xB7 /fork \u2014 \u5206\u53C9\u5F53\u524D\u4F1A\u8BDD\uFF08\u4ECE\u6700\u540E\u4E00\u4E2A\u5DF2\u5B8C\u6210\u56DE\u5408\uFF09",
      [["/new", "/fork"]]
    );
  }
  /**
   * The operation sub-menu: a reply keyboard with the current-session actions
   * — `/archive` (archive into the archived scope), `/stop` (cancel the active
   * turn), and `/curTasks` (print the todo list). Tapping any sends its
   * command verbatim, so the existing handlers run unchanged.
   * @param chatId - the target chat.
   * @param state - the chat's console state.
   * @returns after the menu dispatches.
   */
  async #commandOperate(chatId, state) {
    state.keyboard = { kind: "operate" };
    state.attachKeyboard = void 0;
    await this.#transport.sendReplyKeyboard(
      chatId,
      "\u64CD\u4F5C\u4F1A\u8BDD\uFF1A\u9009\u62E9\u4E00\u9879\u3002\n\n\xB7 /archive \u2014 \u5F52\u6863\u5F53\u524D\u4F1A\u8BDD\n\xB7 /stop \u2014 \u505C\u6B62\u8FDB\u884C\u4E2D\u7684\u56DE\u5408\n\xB7 /curTasks \u2014 \u67E5\u770B\u4EFB\u52A1\u5217\u8868",
      [["/archive"], ["/stop"], ["/curTasks"]]
    );
  }
  /**
   * Create a session inside a workspace, ungrouped, or from a server
   * directory path. Without arguments the workspace keyboard opens: one
   * `/new <n> · <title>` button per workspace plus the ungrouped-create row.
   * `none` creates an ungrouped session (deployment default directory), a
   * bare index targets the last workspace-keyboard row, and anything else
   * names a directory path the host registers as a workspace (idempotently)
   * before creating the session inside it.
   * @param chatId - the target chat.
   * @param state - the chat's console state (cleared caches on success).
   * @param args - the argument text.
   * @returns after the create reply dispatches.
   */
  async #commandNew(chatId, state, args) {
    const [rawTarget] = splitArgs(args);
    if (rawTarget === "") {
      await this.#workspaceListKeyboard(chatId, state, "\u5728\u54EA\u4E2A\u5DE5\u4F5C\u533A\u521B\u5EFA\u4F1A\u8BDD\uFF1F\u70B9\u6309\u94AE\u5373\u53EF\uFF0C\u6216 /new <\u670D\u52A1\u5668\u76EE\u5F55\u8DEF\u5F84> \u65B0\u5EFA\u5DE5\u4F5C\u533A\u3002");
      return;
    }
    try {
      const preset = state.nextPreset;
      let sessionId;
      let location;
      let presetNote = "";
      if (rawTarget === "none") {
        sessionId = await this.#port.createSession(preset === void 0 ? void 0 : { agentPreset: preset });
        location = "\u672A\u5206\u7C7B";
      } else if (/^\d+$/.test(rawTarget)) {
        const workspace = this.#resolveWorkspace(state, rawTarget);
        if (workspace === void 0) {
          await this.#reply(chatId, `\u5DE5\u4F5C\u533A\u5E8F\u53F7 ${rawTarget} \u8D85\u51FA\u8303\u56F4\uFF1A\u53D1\u9001 /new \u91CD\u65B0\u770B\u770B\u5DE5\u4F5C\u533A\u5217\u8868`);
          return;
        }
        sessionId = await this.#port.createSession(
          preset === void 0 ? { workspaceId: workspace.workspaceId } : { workspaceId: workspace.workspaceId, agentPreset: preset }
        );
        location = `\u5DE5\u4F5C\u533A\u300C${workspace.title}\u300D`;
      } else {
        const workspace = await this.#port.createWorkspace(rawTarget);
        sessionId = await this.#port.createSession(
          preset === void 0 ? { workspaceId: workspace.workspaceId } : { workspaceId: workspace.workspaceId, agentPreset: preset }
        );
        location = `\u5DE5\u4F5C\u533A\u300C${workspace.title}\u300D`;
      }
      if (preset !== void 0) {
        state.nextPreset = void 0;
        presetNote = ` \xB7 \u6A21\u5F0F ${preset}`;
      }
      state.sessionId = sessionId;
      state.rows = void 0;
      state.workspaces = void 0;
      state.attachScopes = false;
      state.keyboard = void 0;
      state.attachKeyboard = void 0;
      state.typing = false;
      this.#clearAsks(state);
      await this.#reply(
        chatId,
        `\u{1F517} \u5DF2\u521B\u5EFA\u65B0\u4F1A\u8BDD ${sessionId}\uFF08${shortSessionId(sessionId)}\uFF09\xB7 ${location}${presetNote}`
      );
    } catch (error) {
      await this.#reply(chatId, `\u26D4 ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /**
   * Archive the bound session (or a selector target) into the archived scope
   * — the same durable hide as /delete, aimed at the open session — behind a
   * second confirmation: the first `/archive <target>` arms the target, the
   * second executes it; a different selector re-arms instead of silently
   * switching, and any other command or free text cancels. Archiving the
   * bound session unbinds the chat. A successful archive re-emits the
   * visible session list keyboard, so the archived row disappears without a
   * manual refresh.
   * @param chatId - the target chat.
   * @param state - the chat's console state.
   * @param args - the argument text (empty archives the bound session).
   * @returns after the confirmation, archive reply, or list refresh dispatch.
   */
  async #commandArchive(chatId, state, args) {
    await this.#resetActionRows(chatId, state);
    const [rawTarget] = splitArgs(args);
    const resolved = this.#resolveArgOrBound(state, rawTarget, "archive");
    if ("miss" in resolved) {
      await this.#reply(chatId, resolved.miss);
      return;
    }
    const pending = state.awaitingConfirm;
    if (pending?.command === "archive") {
      if (pending.sessionId !== resolved.id) {
        state.awaitingConfirm = { command: "archive", sessionId: resolved.id };
        await this.#reply(chatId, `\u26A0\uFE0F \u5DF2\u6539\u9009\u4F1A\u8BDD ${shortSessionId(resolved.id)}\uFF0C\u518D\u6B21\u53D1\u9001 /archive \u786E\u8BA4\u5F52\u6863\u3002`);
        return;
      }
      state.awaitingConfirm = void 0;
    } else {
      state.awaitingConfirm = { command: "archive", sessionId: resolved.id };
      await this.#reply(chatId, `\u26A0\uFE0F \u786E\u8BA4\u5F52\u6863\u4F1A\u8BDD ${shortSessionId(resolved.id)}\uFF1F\u518D\u6B21\u53D1\u9001 /archive \u786E\u8BA4\uFF08\u5176\u5B83\u547D\u4EE4\u6216\u6587\u5B57\u53EF\u53D6\u6D88\uFF09\u3002`);
      return;
    }
    try {
      await this.#port.archiveSession(resolved.id);
      if (state.sessionId === resolved.id) {
        state.sessionId = void 0;
        state.typing = false;
        state.stream = void 0;
        this.#clearAsks(state);
      }
      await this.#reply(chatId, `\u{1F4E6} \u5DF2\u5F52\u6863\u4F1A\u8BDD ${shortSessionId(resolved.id)}\uFF08\u52A0\u5165\u5F52\u6863\u533A\uFF0C\u4ECE\u5217\u8868\u4E0E\u5DE5\u4F5C\u533A\u9690\u85CF\uFF09`);
      await this.#refreshSessionList(chatId, state);
    } catch (error) {
      await this.#reply(chatId, `\u26D4 ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /**
   * Archive (delete) one session: bare invocation opens the session keyboard
   * with `delete` buttons, a selector archives the target directly. Deleting
   * the bound session unbinds the chat. The session stays durable
   * (regained only by host-side restore), hidden from every grouping surface.
   * A successful archive re-emits the visible session list keyboard, so the
   * deleted row disappears without a manual refresh.
   * @param chatId - the target chat.
   * @param state - the chat's console state.
   * @param args - the argument text.
   * @returns after the archive reply and any list refresh dispatch.
   */
  async #commandDelete(chatId, state, args) {
    const [rawTarget] = splitArgs(args);
    if (rawTarget === "") {
      await this.#sessionListKeyboard(chatId, state, "\u70B9\u4E0B\u65B9\u6309\u94AE\u5220\u9664\u5BF9\u5E94\u4F1A\u8BDD\uFF08\u5220\u9664\u540E\u4ECE\u5217\u8868\u9690\u85CF\uFF09\uFF1A");
      return;
    }
    await this.#resetActionRows(chatId, state);
    const resolved = this.#resolveTarget(state, rawTarget);
    if ("miss" in resolved) {
      await this.#reply(chatId, resolved.miss);
      return;
    }
    try {
      await this.#port.archiveSession(resolved.id);
      if (state.sessionId === resolved.id) {
        state.sessionId = void 0;
        state.typing = false;
        state.stream = void 0;
        this.#clearAsks(state);
      }
      await this.#reply(chatId, `\u{1F5D1} \u5DF2\u5220\u9664\u4F1A\u8BDD ${shortSessionId(resolved.id)}\uFF08\u4ECE\u5217\u8868\u4E0E\u5DE5\u4F5C\u533A\u9690\u85CF\uFF09`);
      await this.#refreshSessionList(chatId, state);
    } catch (error) {
      await this.#reply(chatId, `\u26D4 ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /**
   * Rename a session. A bare invocation with a bound session enters the
   * pending-rename state — the next non-command text becomes the title —
   * and reports the absence of a binding otherwise. With args, the first
   * token doubles as the target selector only when it parses as one;
   * the title keeps all remaining text. A successful rename re-emits the
   * visible session list keyboard, so the new title shows on the buttons
   * without a manual refresh.
   * @param chatId - the target chat.
   * @param state - the chat's console state.
   * @param args - the argument text.
   * @returns after the rename, prompt, or miss reply dispatches.
   */
  async #commandRename(chatId, state, args) {
    await this.#resetActionRows(chatId, state);
    const raw = args.trim();
    if (raw === "") {
      const bound = state.sessionId;
      if (bound === void 0) {
        await this.#reply(chatId, "\u5F53\u524D\u65E0\u6FC0\u6D3B\u4F1A\u8BDD\u3002\u8BF7\u5148\u7ED1\u5B9A\u4F1A\u8BDD\uFF08\u5982 /attach\uFF09\uFF0C\u518D\u53D1 /rename \u91CD\u547D\u540D\u3002");
        return;
      }
      state.awaitingRename = true;
      state.awaitingAskAnswer = void 0;
      await this.#reply(chatId, "/rename\uFF1A\u8BF7\u518D\u6B21\u8F93\u5165\u6807\u9898\uFF0C\u5F53\u524D\u4F1A\u8BDD\u5C06\u91CD\u547D\u540D\u4E3A\uFF08\u5373\u91CD\u547D\u540D\u5F53\u524D\u7ED1\u5B9A\u4F1A\u8BDD\uFF09\u3002");
      return;
    }
    const space = raw.search(/\s+/);
    const firstToken = space === -1 ? "" : raw.slice(0, space);
    const rest = space === -1 ? "" : raw.slice(space + 1);
    const rawTarget = rest !== "" && this.#looksLikeSelector(firstToken) ? firstToken : "";
    const title = rawTarget === "" ? raw : rest;
    const resolved = this.#resolveArgOrBound(state, rawTarget, "rename");
    if ("miss" in resolved) {
      await this.#reply(chatId, resolved.miss);
      return;
    }
    try {
      const accepted = await this.#port.renameSession(resolved.id, title);
      await this.#reply(chatId, `\u2705 \u5DF2\u91CD\u547D\u540D\u4E3A ${accepted}`);
      await this.#refreshSessionList(chatId, state);
    } catch (error) {
      await this.#reply(chatId, `\u26D4 ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /**
   * Fork one session from its last completed turn and bind this chat to the
   * child — the same shape as /new binding a fresh session, so the fork is
   * immediately the open conversation. A bare invocation forks the bound
   * session; a selector forks that target.
   * @param chatId - the target chat.
   * @param state - the chat's console state.
   * @param args - the argument text.
   * @returns after the fork reply dispatches.
   */
  async #commandFork(chatId, state, args) {
    await this.#resetActionRows(chatId, state);
    const [rawTarget] = splitArgs(args);
    const resolved = this.#resolveArgOrBound(state, rawTarget, "fork");
    if ("miss" in resolved) {
      await this.#reply(chatId, resolved.miss);
      return;
    }
    try {
      const childId = await this.#port.forkSession(resolved.id);
      state.sessionId = childId;
      state.rows = void 0;
      state.workspaces = void 0;
      state.attachScopes = false;
      state.keyboard = void 0;
      state.typing = false;
      state.stream = void 0;
      this.#clearAsks(state);
      await this.#reply(
        chatId,
        `\u{1F500} \u5DF2\u5206\u53C9\u4F1A\u8BDD ${shortSessionId(resolved.id)}\uFF1A\u65B0\u4F1A\u8BDD ${childId}\uFF08${shortSessionId(childId)}\uFF09\uFF0C\u5DF2\u7ED1\u5B9A\u5230\u65B0\u4F1A\u8BDD\u3002`
      );
    } catch (error) {
      await this.#reply(chatId, `\u26D4 ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /**
   * Print the bound session's todo list (the agent's own task list via
   * `todo/write`, the same source the web sidebar's task summary reads).
   * Unbound or empty degrade to a hint; no binding is created here.
   * @param chatId - the target chat.
   * @param state - the chat's console state.
   * @returns after the list (or its degrade hint) dispatches.
   */
  async #commandCurTasks(chatId, state) {
    await this.#resetActionRows(chatId, state);
    const sessionId = state.sessionId;
    if (sessionId === void 0) {
      await this.#reply(chatId, "\u8FD8\u6CA1\u6709\u7ED1\u5B9A\u4F1A\u8BDD\u3002\u53D1 /attach\uFF08\u6216 /new \u521B\u5EFA\uFF09\u7ED1\u5B9A\u4E00\u4E2A\u4F1A\u8BDD\u540E\uFF0C\u7528 /curTasks \u67E5\u770B\u5B83\u7684\u4EFB\u52A1\u5217\u8868\u3002");
      return;
    }
    try {
      const todos = await this.#port.listTodos(sessionId);
      if (todos === null || todos.length === 0) {
        await this.#reply(chatId, "\u5F53\u524D\u4F1A\u8BDD\u6682\u65E0\u4EFB\u52A1\u5217\u8868\u3002");
        return;
      }
      await this.#reply(chatId, renderTodoList(todos));
    } catch (error) {
      await this.#reply(chatId, `\u26D4 ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /**
   * Choose the agent mode (preset) for a session. Bare invocation opens the
   * preset picker keyboard; a selector (index or id) applies the preset to
   * the bound session when it is still blank — the host refuses otherwise,
   * and the refusal replies and stages the choice for the next `/new`.
   * @param chatId - the target chat.
   * @param state - the chat's console state.
   * @param args - the argument text.
   * @returns after the picker, apply reply, or staging reply dispatches.
   */
  async #commandPreset(chatId, state, args) {
    const [rawTarget] = splitArgs(args);
    if (rawTarget === "") {
      await this.#presetListKeyboard(chatId, state);
      return;
    }
    const presets = await this.#port.listPresets();
    const chosen = /^\d+$/.test(rawTarget) ? presets.at(Number(rawTarget) - 1) : presets.find((preset) => preset.id === rawTarget);
    if (chosen === void 0) {
      await this.#reply(chatId, `\u6CA1\u6709\u627E\u5230\u6A21\u5F0F ${rawTarget}\u3002\u53D1\u9001 /preset \u67E5\u770B\u53EF\u9009\u6A21\u5F0F\u3002`);
      return;
    }
    const label = chosen.name ?? chosen.id;
    await this.#applyPreset(chatId, state, chosen.id, label);
  }
  /**
   * Apply one preset to the bound session, or stage it for the next /new
   * when no session is bound or the bound one already started (the host
   * refuses a started session's recomposition).
   * @param chatId - the target chat.
   * @param state - the chat's console state (stages into nextPreset on refusal).
   * @param presetId - the preset to apply.
   * @param label - the preset display label (name or id).
   * @returns after the apply or staging reply dispatches.
   */
  async #applyPreset(chatId, state, presetId, label) {
    const sessionId = state.sessionId;
    if (sessionId === void 0) {
      state.nextPreset = presetId;
      await this.#reply(chatId, `\u6682\u5B58\u6A21\u5F0F\u300C${label}\u300D\uFF1A\u4E0B\u4E00\u6B21 /new \u521B\u5EFA\u4F1A\u8BDD\u65F6\u751F\u6548\u3002`);
      return;
    }
    try {
      await this.#port.selectPreset(sessionId, presetId);
      await this.#reply(chatId, `\u2705 \u5DF2\u5207\u6362\u4F1A\u8BDD\u6A21\u5F0F\u4E3A\u300C${label}\u300D\u3002`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("\uFF08agent-preset-locked\uFF09")) {
        state.nextPreset = presetId;
        await this.#reply(
          chatId,
          `\u5F53\u524D\u4F1A\u8BDD\u5DF2\u5F00\u59CB\uFF0C\u6A21\u5F0F\u5DF2\u56FA\u5B9A\u3002\u5DF2\u6682\u5B58\u300C${label}\u300D\uFF1A\u4E0B\u4E00\u6B21 /new \u521B\u5EFA\u4F1A\u8BDD\u65F6\u751F\u6548\u3002`
        );
        return;
      }
      await this.#reply(chatId, `\u26D4 ${message}`);
    }
  }
  /**
   * Replace the reply keyboard with one button per deployment preset (PTC,
   * standard, minimal, cordis…); tapping one sends `/preset <n> · <name>`
   * verbatim, so the tap applies through the same named path.
   * @param chatId - the target chat.
   * @param state - the chat's console state (records the picker as visible).
   * @returns after the keyboard message dispatches.
   */
  async #presetListKeyboard(chatId, state) {
    const presets = await this.#port.listPresets();
    if (presets.length === 0) {
      state.keyboard = void 0;
      state.attachKeyboard = void 0;
      await this.#reply(chatId, "\u6B64\u90E8\u7F72\u672A\u914D\u7F6E\u9884\u8BBE\u6A21\u5F0F\u3002");
      return;
    }
    state.keyboard = { kind: "presets" };
    state.attachKeyboard = void 0;
    let text = "\u{1F39B} \u9009\u62E9\u4F1A\u8BDD\u6A21\u5F0F\uFF1A\n\n\u70B9\u6309\u94AE\u9009\u62E9\uFF0C\u6216\u53D1\u9001 /preset <\u6A21\u5F0F\u540D> \u76F4\u63A5\u6307\u5B9A\u3002\u7ED1\u5B9A\u4F1A\u8BDD\u672A\u5F00\u59CB\u65F6\u7ACB\u5373\u751F\u6548\uFF1B\u5DF2\u5F00\u59CB\u6216\u672A\u7ED1\u5B9A\u65F6\u6682\u5B58\u7ED9\u4E0B\u4E00\u6B21 /new\u3002";
    if (state.nextPreset !== void 0) {
      const staged = presets.find((preset) => preset.id === state.nextPreset);
      text += `

\u5DF2\u6682\u5B58\uFF1A${staged?.name ?? staged?.id ?? state.nextPreset}\uFF08\u4E0B\u4E00\u6B21 /new \u751F\u6548\uFF09`;
    }
    await this.#transport.sendReplyKeyboard(chatId, text, presetKeyboardRows(presets));
  }
  /**
   * Re-emit the session list keyboard this chat currently shows, after a
   * delete or rename changed the listed sessions: the same hint and the same
   * listed scope re-render from the registry, so visible rows never go
   * stale, and a list emptied by the change degrades to its send path's
   * empty hint. A no-op when the visible keyboard is not a session list (or
   * none is tracked).
   * @param chatId - the target chat.
   * @param state - the chat's console state.
   * @returns after the re-emitted keyboard (or its degrade hint) dispatches.
   */
  async #refreshSessionList(chatId, state) {
    const keyboard = state.keyboard;
    if (keyboard?.kind !== "sessions") return;
    switch (keyboard.recipe.list) {
      case "full":
        await this.#sessionListKeyboard(chatId, state, keyboard.hint);
        return;
      case "ungrouped":
        await this.#attachUngrouped(chatId, state);
        return;
      case "archived":
        await this.#attachArchived(chatId, state);
        return;
      case "workspace": {
        const { byWorkspace } = await this.#partitionSessions();
        await this.#attachList(chatId, state, keyboard.hint, byWorkspace.get(keyboard.recipe.workspaceId) ?? [], keyboard.recipe);
        return;
      }
    }
  }
  /**
   * First catalog entry that names `name`, scanning providers in order. An
   * exact `provider/model` route wins over prefix matching, so a keyboard
   * tap resolves to the model its button advertised even when another model
   * id shares its prefix.
   * @param catalog - the host-wide model catalog.
   * @param name - the user-typed route or prefix.
   * @returns the matched route with display names, or undefined.
   */
  #findModel(catalog, name2) {
    const needle = name2.toLowerCase();
    const slash = needle.indexOf("/");
    if (slash !== -1) {
      const providerId = needle.slice(0, slash);
      const modelId = needle.slice(slash + 1);
      const group = catalog.groups.find((candidate) => candidate.id.toLowerCase() === providerId);
      const model = group?.models.find((candidate) => candidate.id.toLowerCase() === modelId);
      if (group !== void 0 && model !== void 0) {
        return { provider: group.id, providerName: group.name, model: model.id, modelName: model.name };
      }
    }
    for (const group of catalog.groups) {
      for (const model of group.models) {
        if (model.id.toLowerCase().startsWith(needle) || model.name.toLowerCase().startsWith(needle)) {
          return { provider: group.id, providerName: group.name, model: model.id, modelName: model.name };
        }
      }
    }
    return void 0;
  }
  /**
   * Whether a token parses as a session selector: a bare integer (a 1-based
   * index into the last session list output) or a UUID-shaped session id.
   * @param token - the candidate selector token.
   * @returns whether the token should be read as a selector.
   */
  #looksLikeSelector(token) {
    if (/^\d+$/.test(token)) return true;
    return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(token);
  }
  /**
   * Resolve a selector for a command that may fall back to the bound session:
   * a bare integer is a 1-based index into the last session list output,
   * anything else is taken as a session id; an empty argument uses the open
   * binding when one exists.
   * @param state - the chat's console state.
   * @param raw - the argument text.
   * @param verb - the command name for the empty-argument hint.
   * @returns the resolved session id, or a user-facing miss message.
   */
  #resolveArgOrBound(state, raw, verb) {
    if (raw.trim() === "") {
      if (state.sessionId !== void 0) return { ok: true, id: state.sessionId };
      return { miss: `\u6CA1\u6709\u6253\u5F00\u7684\u4F1A\u8BDD\u3002\u5E26\u53C2\u6570\u4F7F\u7528 /${verb} <\u5E8F\u53F7|id> \u6307\u5B9A\u4F1A\u8BDD\u3002` };
    }
    return this.#resolveTarget(state, raw);
  }
  /**
   * Resolve a selector: a bare integer is a 1-based index into the last
   * session list output, anything else is taken as a session id.
   * @param state - the chat's console state.
   * @param raw - the argument text.
   * @returns the resolved session id, or a user-facing miss message.
   */
  #resolveTarget(state, raw) {
    if (/^\d+$/.test(raw)) {
      const index = Number(raw);
      const row = state.rows?.at(index - 1);
      if (row !== void 0) {
        return { ok: true, id: row.sessionId };
      }
      return { miss: `\u5E8F\u53F7 ${index} \u8D85\u51FA\u8303\u56F4\uFF1A\u5148 /attach \u5237\u65B0\u5217\u8868` };
    }
    if (raw.trim() === "") return { miss: "\u7F3A\u5C11\u4F1A\u8BDD\u53C2\u6570\uFF08<\u5E8F\u53F7|id>\uFF09\u3002" };
    return { ok: true, id: SessionId2(raw) };
  }
  async #reply(chatId, text) {
    for (const chunk of chunkText(text)) {
      await this.#transport.sendMessage(chatId, chunk);
    }
  }
  /**
   * Publish one assistant text block on the chat's live stream: edit the
   * stream message when the fused text stays within the chunk budget, send a
   * fresh chunked message otherwise (and after a failed edit, which falls back
   * so no text is lost). The stream follows the last message sent, so further
   * steps keep editing the newest message.
   * @param chatId - the target chat.
   * @param state - the chat's console state.
   * @param block - the trimmed assistant text block.
   * @returns after the edit or send dispatches.
   */
  async #publishAssistant(chatId, state, block) {
    const stream = state.stream;
    const first = stream === void 0 || stream.text === "";
    const header = first && state.turnStartTime !== void 0 ? `${startClockLabel(state.turnStartTime, this.#now())}
` : "";
    const body = first ? `${header}\u{1F916} ${block}` : stream.text + block;
    const shown = body + STREAM_REPLYING_SUFFIX;
    if (stream !== void 0 && Array.from(shown).length <= TELEGRAM_CHUNK_MAX) {
      try {
        await this.#transport.editMessage(chatId, stream.messageId, shown);
        stream.text = body;
        return;
      } catch (error) {
        console.warn(`telegram: stream edit failed, sending a fresh message instead: ${String(error)}`);
      }
    }
    let messageId = 0;
    let text = "";
    for (const chunk of chunkText(shown)) {
      messageId = await this.#transport.sendMessage(chatId, chunk);
      text = chunk;
    }
    text = stripStreamSuffix(text);
    state.stream = { messageId, text };
  }
};
function turnOutcomeLabel(reason) {
  const label = turnEndLabel(reason);
  if (reason.kind !== "error" || !("error" in reason)) return label;
  const message = reason.error.message.trim();
  return message === "" ? label : `${label}
${truncate(message, TURN_ERROR_REASON_MAX)}`;
}
var MODEL_KEYBOARD_LIMIT = 20;
var TURN_ERROR_REASON_MAX = 1e3;
var ATTACH_KEYBOARD_RECENT = 5;
var ATTACH_READ_LIMIT = 40;
var ATTACH_ROUNDS = 2;
var ATTACH_ACTION_LIMIT = 20;
function splitArgs(args) {
  const trimmed = args.trim();
  const space = trimmed.search(/\s+/);
  if (space === -1) return [trimmed, ""];
  return [trimmed.slice(0, space), trimmed.slice(space + 1)];
}
var HELP_TEXT = [
  "\u{1F916} dsh \u4F1A\u8BDD\u9065\u63A7\u53F0",
  "",
  `/attach [\u5E8F\u53F7|id|none|arc] \u2014 \u7ED1\u5B9A\u4F1A\u8BDD\u5E76\u663E\u793A\u6700\u8FD1 ${ATTACH_ROUNDS} \u8F6E\u5BF9\u8BDD\uFF1A\u65E0\u53C2\u6570\u9009\u5DE5\u4F5C\u533A/\u672A\u5206\u7EC4/\u5F52\u6863\uFF1Bnone=\u672A\u5206\u7EC4\uFF1Barc=\u5F52\u6863\uFF1B\u5E8F\u53F7=\u5F53\u524D\u8303\u56F4\u91CC\u7684\u4F1A\u8BDD`,
  "/create \u2014 \u521B\u5EFA\u4F1A\u8BDD\u83DC\u5355\uFF1A\u4E0B\u4E00\u7EA7\u4E3A /new\uFF08\u65B0\u5EFA\uFF09\u4E0E /fork\uFF08\u5206\u53C9\uFF09",
  "/operate \u2014 \u64CD\u4F5C\u4F1A\u8BDD\u83DC\u5355\uFF1A\u4E0B\u4E00\u7EA7\u4E3A /archive\uFF08\u5F52\u6863\uFF09\u3001/stop\uFF08\u505C\u6B62\uFF09\u3001/curTasks\uFF08\u4EFB\u52A1\u5217\u8868\uFF09",
  "/new [\u8DEF\u5F84|\u5E8F\u53F7|none] \u2014 \u521B\u5EFA\u4F1A\u8BDD\uFF1A\u65E0\u53C2\u6570\u5F39\u51FA\u5DE5\u4F5C\u533A\u9009\uFF1Bnone=\u672A\u5206\u7C7B\uFF1B\u5E8F\u53F7=\u5DE5\u4F5C\u533A\uFF1B\u8DEF\u5F84=\u670D\u52A1\u5668\u76EE\u5F55\u81EA\u52A8\u6CE8\u518C",
  "/fork [\u5E8F\u53F7|id] \u2014 \u5206\u53C9\u4F1A\u8BDD\uFF1A\u4ECE\u6700\u540E\u4E00\u4E2A\u5DF2\u5B8C\u6210\u56DE\u5408\u5F00\u65B0\u4F1A\u8BDD\u5E76\u7ED1\u5B9A\uFF08\u65E0\u53C2\u6570\u4F5C\u7528\u4E8E\u5F53\u524D\u7ED1\u5B9A\uFF09",
  "/archive [\u5E8F\u53F7|id] \u2014 \u5F52\u6863\u4F1A\u8BDD\u52A0\u5165\u5F52\u6863\u533A\uFF08\u65E0\u53C2\u6570\u4F5C\u7528\u4E8E\u5F53\u524D\u4F1A\u8BDD\uFF1B\u9700\u518D\u6B21\u53D1\u9001 /archive \u786E\u8BA4\uFF09",
  "/delete [\u5E8F\u53F7|id] \u2014 \u5220\u9664\uFF08\u5F52\u6863\uFF09\u4F1A\u8BDD\uFF0C\u65E0\u53C2\u6570\u5F39\u51FA\u9009\u62E9",
  "/stop \u2014 \u505C\u6B62\u8FDB\u884C\u4E2D\u7684\u56DE\u5408\uFF08\u4F5C\u7528\u4E8E\u5F53\u524D\u7ED1\u5B9A\u4F1A\u8BDD\uFF1B\u672A\u7ED1\u5B9A\u4F1A\u8BDD\u65F6\u70B9\u4E0B\u65B9\u6309\u94AE\u9009\u62E9\uFF09",
  "/status [\u5E8F\u53F7|id] \u2014 \u4F1A\u8BDD\u8BE6\u60C5\uFF08\u65E0\u53C2\u6570\u4F5C\u7528\u4E8E\u5F53\u524D\u4F1A\u8BDD\uFF1B\u672A\u7ED1\u5B9A\u4F1A\u8BDD\u65F6\u70B9\u4E0B\u65B9\u6309\u94AE\u9009\u62E9\uFF09",
  "/model [\u6A21\u578B\u540D] \u2014 \u8BBE\u7F6E\u5168\u5C40\u9ED8\u8BA4\u6A21\u578B\uFF08\u65E0\u53C2\u6570\u5F39\u51FA\u6A21\u578B\u952E\u76D8\u9009\u62E9\uFF09",
  "/rename [\u6807\u9898] \u2014 \u91CD\u547D\u540D\u4F1A\u8BDD\uFF1A\u65E0\u53C2\u6570\u4EA4\u4E92\u8F93\u5165\u6807\u9898\uFF08\u4F5C\u7528\u4E8E\u5F53\u524D\u7ED1\u5B9A\u4F1A\u8BDD\uFF09\uFF1B<\u5E8F\u53F7|id> <\u6807\u9898> \u6307\u5B9A\u4F1A\u8BDD",
  "/curTasks \u2014 \u67E5\u770B\u5F53\u524D\u4F1A\u8BDD\u7684\u4EFB\u52A1\u5217\u8868\uFF08\u4E0E Web \u4FA7\u680F\u4EFB\u52A1\u540C\u6E90\uFF09",
  "/preset [\u6A21\u5F0F\u540D|\u5E8F\u53F7] \u2014 \u9009\u62E9\u4F1A\u8BDD\u6A21\u5F0F\uFF08PTC/\u6807\u51C6/\u6781\u7B80/\u521B\u9020\u9884\u8BBE\uFF09\uFF1A\u65E0\u53C2\u6570\u5F39\u51FA\u9884\u8BBE\u952E\u76D8\uFF1B\u5DF2\u5F00\u59CB\u4F1A\u8BDD\u4F1A\u6682\u5B58\u5230\u4E0B\u4E00\u6B21 /new",
  "/close \u2014 \u6536\u8D77\u5FEB\u6377\u952E\u76D8\uFF08\u9700\u518D\u6B21\u53D1\u9001 /close \u786E\u8BA4\uFF1B\u4F1A\u8BDD\u7ED1\u5B9A\u4E0D\u53D8\uFF09",
  "",
  "\u4F1A\u8BDD/\u5DE5\u4F5C\u533A\u5217\u8868\u4E0B\u65B9\u4F1A\u51FA\u73B0\u5FEB\u6377\u952E\u76D8\uFF1A\u70B9\u6309\u94AE = \u81EA\u52A8\u53D1\u9001\u5BF9\u5E94\u547D\u4EE4\uFF0C\u65E0\u9700\u590D\u5236 id\u3002",
  "/ \u547D\u4EE4\u83DC\u5355\u4ECE /keyboard \u5F00\u59CB\uFF08\u4E00\u952E\u5524\u9192\u952E\u76D8\u533A\uFF09\uFF0C\u63A5\u7740 /attach\uFF08\u7ED1\u5B9A\u5165\u53E3\uFF09\uFF0C\u5176\u4F59\u53EA\u4FDD\u7559\u952E\u76D8\u4E0A\u6CA1\u6709\u7684\u547D\u4EE4\uFF1A/status\u3001/model\u3001/delete\u3001/rename\u3001/preset\u3001/start\u3002",
  "\u8FD0\u884C /attach\u3001/status\u3001/stop \u7B49\u4E0D\u5E26\u952E\u76D8\u7684\u547D\u4EE4\u540E\uFF0C\u5FEB\u6377\u952E\u76D8\u4F1A\u56DE\u5230\u5E38\u7528\u64CD\u4F5C\u884C\uFF08/create /archive /attach /close\uFF09\u3002",
  "\u7ED1\u5B9A\u4F1A\u8BDD\u540E\uFF0Cagent \u7684\u56DE\u590D\u4F1A\u5B9E\u65F6\u63A8\u9001\u5230\u8FD9\u91CC\u3002",
  "\u4EE5 / \u5F00\u5934\u7684\u6D88\u606F\u662F\u547D\u4EE4\uFF1B\u8981\u7528 / \u5F00\u5934\u7684\u5185\u5BB9\u53D1\u7ED9 harness\uFF0C",
  "\u8BF7\u5728\u524D\u9762\u52A0 \\ \u8F6C\u4E49\uFF08\u5982 \\/model\uFF09\u3002"
].join("\n");

// src/index.ts
var TYPING_PUMP_INTERVAL_MS = 5e3;
var DENIED_REPLY = "\u26D4 \u65E0\u6743\u8BBF\u95EE\u3002";
var COMMANDS = [
  { command: "keyboard", description: "\u5524\u9192/\u5237\u65B0\u4E0B\u65B9\u952E\u76D8\u533A\uFF08\u6062\u590D\u5E38\u7528\u547D\u4EE4\u6309\u94AE\u4E0E\u8FD0\u884C\u4E2D\u4F1A\u8BDD\u7684\u5FEB\u6377\u7ED1\u5B9A\uFF09" },
  { command: "attach", description: "\u9009\u62E9\u4F1A\u8BDD\u5E76\u7ED1\u5B9A\uFF08<\u5E8F\u53F7|id|none|arc>\uFF1B\u4F1A\u8BDD\u5217\u8868\u65F6\u952E\u76D8\u533A\u53EF\u76F4\u63A5\u70B9\u9009\uFF09" },
  { command: "status", description: "\u67E5\u770B\u4F1A\u8BDD\u8BE6\u60C5" },
  { command: "model", description: "\u8BBE\u7F6E\u5168\u5C40\u9ED8\u8BA4\u6A21\u578B\uFF08\u65E0\u53C2\u6570\u5F39\u51FA\u6A21\u578B\u5217\u8868\uFF09" },
  { command: "delete", description: "\u5220\u9664\uFF08\u5F52\u6863\uFF09\u4F1A\u8BDD <\u5E8F\u53F7|id>\uFF0C\u65E0\u53C2\u6570\u5F39\u51FA\u9009\u62E9" },
  { command: "rename", description: "\u91CD\u547D\u540D\u4F1A\u8BDD <\u6807\u9898>" },
  { command: "preset", description: "\u9009\u62E9\u4F1A\u8BDD\u6A21\u5F0F\uFF08PTC/\u6807\u51C6/\u6781\u7B80/\u521B\u9020\u7B49\u9884\u8BBE\uFF09<\u6A21\u5F0F\u540D|\u5E8F\u53F7>" },
  { command: "start", description: "\u663E\u793A\u5E2E\u52A9\u4E0E\u5168\u90E8\u547D\u4EE4" }
];
var TELEGRAM_SETTINGS_NAMESPACE = "telegram";
var GLOBAL_DEFAULT_MODEL_NAMESPACE = "agent-default-model";
var Config = z.object({
  // A secret form field: DSH redacts it in `describe()` listings, the web form
  // sends an empty placeholder back unless the operator types a new token, and
  // `keepSecretToken` below restores the previous value on such a save.
  botToken: z.string().role("secret").default("").description("\u0422\u043E\u043A\u0435\u043D \u0431\u043E\u0442\u0430 \u043E\u0442 @BotFather. \u041F\u0443\u0441\u0442\u043E \u2014 \u0431\u0435\u0440\u0451\u0442\u0441\u044F TELEGRAM_BOT_TOKEN \u0438\u0437 \u043E\u043A\u0440\u0443\u0436\u0435\u043D\u0438\u044F; \u043F\u0440\u0438 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u0438\u0438 \u043F\u0443\u0441\u0442\u043E\u0435 \u043F\u043E\u043B\u0435 \u043D\u0435 \u0437\u0430\u0442\u0438\u0440\u0430\u0435\u0442 \u0443\u0436\u0435 \u0437\u0430\u0434\u0430\u043D\u043D\u044B\u0439 \u0442\u043E\u043A\u0435\u043D").volatile(),
  allowChatIds: z.array(z.number()).required().description("\u0420\u0430\u0437\u0440\u0435\u0448\u0451\u043D\u043D\u044B\u0435 \u0447\u0430\u0442\u044B: id \u0447\u0430\u0442\u043E\u0432, \u043A\u043E\u0442\u043E\u0440\u044B\u043C \u0431\u043E\u0442 \u043E\u0442\u0432\u0435\u0447\u0430\u0435\u0442. \u041F\u0443\u0441\u0442\u043E\u0439 \u0441\u043F\u0438\u0441\u043E\u043A \u2014 \u0431\u043E\u0442 \u043E\u0442\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442 \u0432\u0441\u0435\u043C").volatile(),
  proxy: z.string().description("HTTP-\u043F\u0440\u043E\u043A\u0441\u0438 \u0434\u043B\u044F Telegram (\u0442\u043E\u043B\u044C\u043A\u043E CONNECT), \u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440 http://user:pass@host:1080. \u041F\u0443\u0441\u0442\u043E \u2014 \u0431\u0435\u0440\u0451\u0442\u0441\u044F ALL_PROXY/HTTPS_PROXY \u0438\u043B\u0438 \u043F\u0440\u044F\u043C\u043E\u0435 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435").volatile(),
  locale: z.string().description("\u042F\u0437\u044B\u043A \u0438\u043D\u0442\u0435\u0440\u0444\u0435\u0439\u0441\u0430 \u0431\u043E\u0442\u0430: ru (\u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E) \u0438\u043B\u0438 zh").volatile(),
  keyboard: z.string().description("\u041D\u0438\u0436\u043D\u044F\u044F \u043A\u043B\u0430\u0432\u0438\u0430\u0442\u0443\u0440\u0430 \u0431\u043E\u0442\u0430: dismissible \u2014 \u043C\u043E\u0436\u043D\u043E \u0441\u0432\u0435\u0440\u043D\u0443\u0442\u044C (\u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E), off \u2014 \u043D\u0435 \u043F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0442\u044C \u0441\u043E\u0432\u0441\u0435\u043C, persistent \u2014 \u0437\u0430\u043A\u0440\u0435\u043F\u043B\u0435\u043D\u0430 \u0432\u0441\u0435\u0433\u0434\u0430").volatile()
});
function resolveLocale(config) {
  return config.locale === "zh" ? "zh" : "ru";
}
function resolveKeyboard(config) {
  if (config.keyboard === "off") return "off";
  if (config.keyboard === "persistent") return "persistent";
  return "dismissible";
}
function plainValue(field) {
  return isVolatile(field) ? field.get() : field;
}
var name = "telegram";
var inject = HOST_API_SERVICES;
function resolveProxy(config) {
  return config.proxy ?? process.env.ALL_PROXY ?? process.env.HTTPS_PROXY ?? void 0;
}
function createPort(api) {
  const rpcId = () => RpcId(randomUUID2());
  const failure = (message, code) => new Error(`${message}\uFF08${code}\uFF09`);
  return {
    async listSessions() {
      const response = await api.sessions.list({ rpcId: rpcId(), payload: {} });
      if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
      return response.result.value.items;
    },
    async readHistory(sessionId, maxMessages) {
      const payload = { sessionId, ...maxMessages === void 0 ? {} : { maxMessages } };
      const response = await api.sessions.history({ rpcId: rpcId(), payload });
      if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
      return response.result.value.events.map((entry) => entry.event);
    },
    async sendPrompt(sessionId, mode, text) {
      const response = await api.sessions.prompt({
        rpcId: rpcId(),
        payload: { sessionId, mode, content: [{ type: "text", text }] }
      });
      if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
    },
    async stopSession(sessionId) {
      const response = await api.sessions.cancel({ rpcId: rpcId(), payload: { sessionId } });
      if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
    },
    async listGlobalModels() {
      const response = await api.llm.models({ rpcId: rpcId(), payload: {} });
      if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
      return response.result.value;
    },
    async setGlobalDefaultModel(provider, model) {
      const response = await api.settings.update({
        rpcId: rpcId(),
        payload: { ns: GLOBAL_DEFAULT_MODEL_NAMESPACE, patch: { provider, model } }
      });
      if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
    },
    async createSession(options) {
      const payload = {
        ...options?.workspaceId === void 0 ? {} : { workspaceId: options.workspaceId },
        ...options?.cwd === void 0 ? {} : { cwd: options.cwd },
        ...options?.agentPreset === void 0 ? {} : { agentPreset: options.agentPreset }
      };
      const response = await api.sessions.create({ rpcId: rpcId(), payload });
      if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
      return response.result.value.sessionId;
    },
    async listWorkspaces() {
      const response = await api.workspace.list({ rpcId: rpcId(), payload: {} });
      if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
      return response.result.value.items;
    },
    async listArchivedSessionIds() {
      const response = await api.workspace.list({ rpcId: rpcId(), payload: {} });
      if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
      return response.result.value.archivedSessionIds;
    },
    async createWorkspace(path) {
      const response = await api.workspace.create({ rpcId: rpcId(), payload: { path } });
      if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
      return response.result.value.workspace;
    },
    async archiveSession(sessionId) {
      const response = await api.workspace.archiveSession({ rpcId: rpcId(), payload: { sessionId } });
      if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
    },
    async renameSession(sessionId, title) {
      const response = await api.sessions.rename({ rpcId: rpcId(), payload: { sessionId, title } });
      if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
      return response.result.value.title;
    },
    async forkSession(sessionId) {
      const response = await api.sessions.fork({ rpcId: rpcId(), payload: { sessionId } });
      if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
      return response.result.value.sessionId;
    },
    async listTodos(sessionId) {
      const response = await api.sessions.history({ rpcId: rpcId(), payload: { sessionId, maxMessages: 20 } });
      if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
      const values = response.result.value.projections?.values;
      if (values?.todos !== void 0) return values.todos;
      return lastTodoWrite(response.result.value.events.map((entry) => entry.event));
    },
    async listPresets() {
      const response = await api.agentPresets.list({ rpcId: rpcId(), payload: {} });
      if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
      return [...response.result.value.presets];
    },
    async selectPreset(sessionId, agentPreset) {
      const response = await api.agentPresets.select({ rpcId: rpcId(), payload: { sessionId, agentPreset } });
      if (!response.result.ok) throw failure(response.result.error.message, response.result.error.code);
    },
    async answerQuestion(rpcId2, sessionId, answer) {
      const response = await api.respond({
        type: "client-response",
        rpcId: rpcId2,
        result: { ok: true, value: { sessionId, answer } }
      });
      if (!response.accepted) {
        throw new Error(`\u63D0\u95EE\u56DE\u7B54\u88AB\u62D2\u7EDD\uFF08${response.reason}\uFF09`);
      }
    },
    async cancelQuestion(rpcId2) {
      const response = await api.respond({
        type: "client-response",
        rpcId: rpcId2,
        result: {
          ok: false,
          error: { code: "cancelled", message: "the user closed this question request", details: {} }
        }
      });
      if (!response.accepted) {
        throw new Error(`\u63D0\u95EE\u53D6\u6D88\u5931\u8D25\uFF08${response.reason}\uFF09`);
      }
    }
  };
}
function inlineKeyboardMarkup(rows) {
  return rows.map((row) => row.map((button) => ({ text: button.text, callback_data: button.data })));
}
function createBot(config, proxyAgent) {
  return new Bot(config.botToken, proxyAgent === void 0 ? {} : {
    client: {
      // grammY's Node runner asks for a `typeof fetch` implementation;
      // undici's fetch signature is structurally identical plus its
      // non-standard `dispatcher` init field, which DOM RequestInit does not
      // carry. One architectural assertion bridges the two request shapes.
      fetch: ((url, init) => {
        const { signal: _signal, ...rest } = init ?? {};
        return undiciFetch(url, { ...rest, dispatcher: proxyAgent });
      })
    }
  });
}
var PRESET_COMMAND_SCOPES = [
  { type: "all_private_chats" },
  { type: "all_group_chats" },
  { type: "all_chat_administrators" }
];
function syncCommandMenu(bot, logger, locale) {
  void (async () => {
    for (const scope of PRESET_COMMAND_SCOPES) {
      await bot.api.deleteMyCommands({ scope }).catch((error) => {
        logger.warn(`telegram: stale menu scope teardown failed for ${scope.type}: ${String(error)}`);
      });
    }
    await bot.api.setMyCommands(COMMANDS.map((command) => ({
      command: command.command,
      description: localize(command.description ?? "", locale)
    }))).catch((error) => {
      logger.warn(`telegram: command menu registration failed: ${String(error)}`);
    });
  })();
}
function startBotSession(options) {
  const { config, api, events, logger, onListened } = options;
  const allowed = new Set(config.allowChatIds);
  const proxy = resolveProxy(config);
  const locale = resolveLocale(config);
  const keyboard = resolveKeyboard(config);
  const proxyAgent = proxy === void 0 ? void 0 : new ProxyAgent(proxy);
  const bot = (options.createBot ?? createBot)(config, proxyAgent);
  bot.catch((error) => {
    logger.warn(`telegram: bot error: ${error.message}`);
  });
  const transport = {
    sendMessage: async (chatId, text) => {
      const message = await bot.api.sendMessage(chatId, localize(text, locale));
      return message.message_id;
    },
    editMessage: async (chatId, messageId, text) => {
      await bot.api.editMessageText(chatId, messageId, localize(text, locale));
    },
    sendMessageHtml: async (chatId, html) => {
      const message = await bot.api.sendMessage(chatId, localize(html, locale), { parse_mode: "HTML" });
      return message.message_id;
    },
    editMessageHtml: async (chatId, messageId, html) => {
      await bot.api.editMessageText(chatId, messageId, localize(html, locale), { parse_mode: "HTML" });
    },
    sendChatAction: async (chatId, action) => {
      await bot.api.sendChatAction(chatId, action);
    },
    sendReplyKeyboard: async (chatId, text, rows) => {
      const translated = localize(text, locale);
      if (keyboard === "off") {
        const plain = await bot.api.sendMessage(chatId, translated);
        return plain.message_id;
      }
      const sent = await bot.api.sendMessage(chatId, translated, {
        reply_markup: {
          keyboard: rows.map((row) => row.map((label) => ({ text: localize(label, locale) }))),
          resize_keyboard: true,
          // `dismissible` leaves Telegram's own hide toggle available;
          // `persistent` is upstream's always-there keyboard.
          is_persistent: keyboard === "persistent",
          input_field_placeholder: localize("\u5411 agent \u53D1\u6D88\u606F\uFF0C\u6216 /start \u67E5\u770B\u547D\u4EE4", locale)
        }
      });
      return sent.message_id;
    },
    removeKeyboard: async (chatId, text) => {
      const sent = await bot.api.sendMessage(chatId, localize(text, locale), {
        reply_markup: { remove_keyboard: true }
      });
      return sent.message_id;
    },
    sendInlineKeyboard: async (chatId, text, rows) => {
      const sent = await bot.api.sendMessage(chatId, localize(text, locale), {
        reply_markup: { inline_keyboard: inlineKeyboardMarkup(localizeRows(rows, locale)) }
      });
      return sent.message_id;
    },
    editInlineKeyboard: async (chatId, messageId, text, rows) => {
      await bot.api.editMessageText(chatId, messageId, localize(text, locale), {
        reply_markup: { inline_keyboard: inlineKeyboardMarkup(localizeRows(rows, locale)) }
      });
    }
  };
  const telegramConsole = new TelegramConsole(createPort(api), transport);
  bot.on("message:text", (messageContext) => {
    const chatId = messageContext.chat.id;
    if (!allowed.has(chatId)) {
      logger.warn(`telegram: chat ${chatId} refused: not in allowChatIds`);
      void bot.api.sendMessage(chatId, localize(`${DENIED_REPLY} \u5982\u9700\u8BBF\u95EE\uFF0C\u8BF7\u5C06 chat id ${chatId} \u52A0\u5165 allowChatIds \u767D\u540D\u5355\u3002`, locale)).catch((error) => {
        logger.debug(`telegram: denial reply failed: ${String(error)}`);
      });
      return;
    }
    void telegramConsole.handleMessage(chatId, messageContext.message.text).catch((error) => {
      logger.warn(`telegram: message handling failed: ${String(error)}`);
    });
  });
  bot.on("callback_query", (callbackContext) => {
    const { message, data } = callbackContext.callbackQuery;
    void bot.api.answerCallbackQuery(callbackContext.callbackQuery.id).catch((error) => {
      logger.debug(`telegram: callback ack failed: ${String(error)}`);
    });
    const chatId = message?.chat.id;
    if (chatId === void 0 || data === void 0) return;
    if (!allowed.has(chatId)) {
      logger.warn(`telegram: chat ${chatId} refused: not in allowChatIds`);
      return;
    }
    void telegramConsole.handleCallback(chatId, data).catch((error) => {
      logger.warn(`telegram: callback handling failed: ${String(error)}`);
    });
  });
  const stopEvents = events.on("session/event", (session, event) => {
    void telegramConsole.onSessionEvent(session.id, event).catch((error) => {
      logger.warn(`telegram: event push failed: ${String(error)}`);
    });
  });
  const typingTimer = setInterval(() => {
    void telegramConsole.pumpTyping().catch((error) => {
      logger.warn(`telegram: typing pump failed: ${String(error)}`);
    });
  }, TYPING_PUMP_INTERVAL_MS);
  let stopped = false;
  void bot.start({
    onStart: (botInfo) => {
      syncCommandMenu(bot, logger, locale);
      onListened(config, botInfo.username);
    }
  }).catch((error) => {
    logger.error(`telegram: long polling start failed: ${String(error)}`);
  });
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      stopEvents();
      clearInterval(typingTimer);
      await bot.stop();
    }
  };
}
function apply(ctx, config) {
  let lastToken = "";
  const readConfig = () => {
    const token = String(plainValue(config.botToken) ?? "").trim();
    if (token !== "") lastToken = token;
    return {
      botToken: token === "" ? lastToken : token,
      allowChatIds: plainValue(config.allowChatIds) ?? [],
      proxy: plainValue(config.proxy) ?? "",
      locale: plainValue(config.locale),
      keyboard: plainValue(config.keyboard)
    };
  };
  const initial = readConfig();
  if (initial.botToken === "") {
    console.log("telegram: bot token is not configured \u2014 set it in the plugin settings or TELEGRAM_BOT_TOKEN");
  }
  console.log(`telegram: configuring bot for ${initial.allowChatIds.length} allowed chat ids`);
  ctx.inject([...HOST_API_SERVICES], (apiCtx) => {
    const api = createHostApi(apiCtx);
    const logger = ctx.logger;
    let session;
    let sessionGeneration = 0;
    const startSession = (cfg) => {
      const generation = ++sessionGeneration;
      void (async () => {
        await session?.stop();
        if (generation !== sessionGeneration) return;
        session = startBotSession({
          config: cfg,
          api,
          events: api.events,
          logger,
          onListened: (current2, username) => {
            console.log(`telegram: bot @${username} listening`);
            logger.info(`telegram: bot @${username} listening with ${current2.allowChatIds.length} allowed chat ids`);
          }
        });
      })().catch((error) => {
        logger.error(`telegram: bot session start failed: ${String(error)}`);
      });
    };
    let current = initial;
    const reconcile = () => {
      try {
        const next = readConfig();
        if (JSON.stringify(next) === JSON.stringify(current)) return;
        current = next;
        console.log(`telegram: applying settings (${next.allowChatIds.length} allowed chat ids, locale ${resolveLocale(next)}, keyboard ${resolveKeyboard(next)})`);
        startSession(next);
      } catch (error) {
        logger.warn?.(`telegram: settings apply failed: ${String(error)}`);
      }
    };
    ctx.inject(["settings"], (settingsCtx) => {
      const stop = settingsCtx.on("settings/document-updated", (ns) => {
        if (ns === TELEGRAM_SETTINGS_NAMESPACE) reconcile();
      });
      settingsCtx.effect(() => stop, "telegram.settings");
    });
    for (const event of ["loader/volatile-update", "app-boot/config-reload"]) {
      const stopEvent = ctx.on(event, () => reconcile());
      ctx.effect(() => stopEvent, `telegram.${event}`);
    }
    const sweep = setInterval(reconcile, 5e3);
    ctx.effect(() => () => clearInterval(sweep), "telegram.settings-sweep");
    registerConfigRoute(ctx, readConfig);
    ctx.effect(() => async () => {
      sessionGeneration += 1;
      await session?.stop();
    }, "telegram.lifecycle()");
    startSession(current);
  });
}
export {
  COMMANDS,
  Config,
  DENIED_REPLY,
  GLOBAL_DEFAULT_MODEL_NAMESPACE,
  TELEGRAM_SETTINGS_NAMESPACE,
  TYPING_PUMP_INTERVAL_MS,
  apply,
  createPort,
  inject,
  name,
  startBotSession
};
