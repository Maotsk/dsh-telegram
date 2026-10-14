# 🤖 dsh-telegram

**Telegram remote control for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — your agent in your pocket.**

List sessions, bind one, send prompts, watch replies stream live, answer the agent's
questions with one tap, stop or re-point sessions — through the exact same channel the
Web UI uses, from any chat you whitelist.

[Русский](README.md) · **English** · [中文](README.zh.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
![Node](https://img.shields.io/badge/node-%3E%3D22.19-339933)

> **Fork note.** This is a fork of [Kevin66Z0/dsh-telegram](https://github.com/Kevin66Z0/dsh-telegram)
> ported to **DSH 0.2.x** — upstream targets the 0.0.x `apiProxy` service, which 0.2.x no
> longer ships, so it fails to import there. This fork talks to the in-process 0.2.x
> services the Web UI itself uses, adds a Russian UI, a live settings card in the Web UI
> and full-length button labels. Details: [FORK.md](FORK.md).

---

## ✨ Features

- **Full session console** — `/attach` binds a session, `/status` inspects it, plain text
  becomes a prompt, replies stream into a single message.
- **Live streaming replies** — assistant output is edited in place across the turn
  (`💭 Think` / `🔧 tool` action lines per step) and finished as Telegram HTML with a
  token-usage footer.
- **Interactive questions as buttons** — when the agent calls `ask_user_question`, the chat
  gets an answerable inline keyboard instead of a wall of text: tap to answer, tap to
  cancel; Telegram and the Web UI see the same question and the first answer wins.
- **One-tap keyboards** — reply keyboards carry `/create` `/archive` `/attach` and
  `/stop` `/close`; session, workspace, model and preset lists render as inline buttons
  with full names. Everything is a tap, everything still works typed.
- **Russian interface** — every message, button label and `/` menu entry is translated
  (see “Language and keyboard”).
- **Settings in the Web UI** — token, allowed chats, proxy, language and keyboard policy
  are edited on the plugin's card and applied without a restart.
- **Safe by default** — only chats in `allowChatIds` get answers; everyone else is refused
  without leaking session facts. The plugin opens no inbound port: outbound Telegram
  long polling only (optionally through a proxy).

## 🚀 Installation

You need **DSH 0.2.x** (tested on 0.2.0-rc.2) and internet access to GitHub — the
repository is public, no keys required.

**Option 1 — from the Web UI (no files to edit):**

1. **Settings → Plugins → install plugin** and give the package spec:

   ```
   github:Maotsk/dsh-telegram
   ```

2. Restart the DSH application and hard-refresh the page (**Ctrl+F5**) so the settings
   card is picked up.
3. Open **Settings → Plugins → Telegram** and fill in the bot token from
   [@BotFather](https://t.me/BotFather), your `chat id` under “Allowed chats”, and an
   HTTP proxy if Telegram is not reachable directly. Saving applies immediately.

**Option 2 — from the command line** (on the host that runs DSH):

```bash
dsh plugin --profile web add github:Maotsk/dsh-telegram
```

then restart DSH. The plugin manager adds the `@deepseek-ai/dsh-host-telegram` bundle row
to the profile itself; if it is missing from `dsh.profile.bundles` in
`$DSH_HOME/profiles/web/package.json`, add it by hand.

**Token** can be entered in the settings card (stored in the profile settings) or placed
in `$DSH_HOME/.env` — mode 600:

```bash
echo 'TELEGRAM_BOT_TOKEN=123456:AA...' >> "$DSH_HOME/.env"
chmod 600 "$DSH_HOME/.env"
```

**Check:** the DSH log shows `telegram: configuring bot for N allowed chat ids` and
`telegram: bot @<name> listening`; in Telegram the bot answers `/start`, and `/attach`
lists your sessions and workspaces. A restart is only needed when the plugin package
itself is updated — settings apply on the fly.

## ⚙️ Settings

The plugin card lives at **Settings → Plugins → Telegram**:

| Field | What it does |
| --- | --- |
| Bot token | Token from [@BotFather](https://t.me/BotFather). A secret field: shown as configured, never disclosed. Saving with the field empty keeps the running token |
| Allowed chats | Comma-separated `chat id`s the bot answers. An empty list denies everyone (the bot tells the caller their own id) |
| HTTP proxy | Proxy for Telegram, **HTTP CONNECT only** (e.g. `http://user:pass@host:1080`). SOCKS5 is not supported. Empty falls back to `ALL_PROXY`/`HTTPS_PROXY`, then a direct connection |
| Interface language | `ru` (default) or `zh` |
| Bottom keyboard | `dismissible` — can be folded away with Telegram's own toggle (default); `off` — never shown; `persistent` — always pinned |

## 💬 Commands

| Command | What it does |
| --- | --- |
| `/start` | Help and the command list |
| `/keyboard` | Show/refresh the bottom keyboard with the frequent actions |
| `/attach` | Pick and bind a session (`/attach <number\|id\|none\|arc>`) |
| `/status` | Details of the bound session |
| `/create` | Create a session: `/new` (in a workspace, ungrouped, or by path) or `/fork` |
| `/archive` | Archive a session |
| `/rename` | Rename a session |
| `/model` | Model catalog and the global default model |
| `/preset` | Switch the session's agent preset (before its first turn) |
| `/stop` | Interrupt the running turn |
| `/close` | Hide the bottom keyboard |

Session, workspace, model and preset lists arrive as buttons — everything also works
typed.

## 🌍 Language and keyboard

Upstream ships Simplified-Chinese literals with no i18n. This fork translates at the
output boundary: the dictionary in `src/locale-ru.ts` (249 phrases plus numeric rules
with proper Russian agreement — “5 minutes ago”, “3 sessions”) is applied to outgoing
messages and button labels. Service data is never translated, so button taps and command
routing keep working; `locale: zh` restores the original behaviour.

Workspace and preset names in buttons are filled up to Telegram's label limit (60
characters) instead of a 6–8 character stub. The bottom keyboard can be folded away with
Telegram's own toggle, or turned off completely with the `off` mode.

## 🧩 Differences from upstream

- Host layer: the missing `apiProxy` is replaced by in-process DSH 0.2.x services
  (`sessionController`, `workspaceRegistry`, `agentDefaultModel`, `agentPresets`,
  `settingsController`, `userQuestions`).
- Russian localization, a settings card in the Web UI, keyboard modes, full-length button
  labels.
- Question cancellation (`🚫`) is expressed as a “skip” answer: the 0.2.x question service
  has no separate cancel.

Internals and migration notes: [FORK.md](FORK.md).

## License

MIT, same as upstream. Original plugin by [Kevin66Z0](https://github.com/Kevin66Z0);
the DSH 0.2.x fork is maintained in [Maotsk/dsh-telegram](https://github.com/Maotsk/dsh-telegram).
