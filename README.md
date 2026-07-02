# FreeDeepseekAPI

<p align="center">
  <strong>Local OpenAI-compatible API proxy for DeepSeek Web Chat</strong>
</p>

<p align="center">
  <a href="https://github.com/ForgetMeAI/FreeDeepseekAPI/blob/main/LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-green.svg" /></a>
  <img alt="Node.js 18 plus" src="https://img.shields.io/badge/node-18%2B-339933.svg" />
  <img alt="No npm dependencies" src="https://img.shields.io/badge/dependencies-0-blue.svg" />
  <img alt="OpenAI compatible" src="https://img.shields.io/badge/OpenAI-compatible-111111.svg" />
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-features">Features</a> •
  <a href="#-request-examples">Examples</a> •
  <a href="#-models">Models</a> •
  <a href="#-endpoints">Endpoints</a> •
  <a href="#-open-webui">Open WebUI</a>
</p>

FreeDeepseekAPI runs a local API server for **DeepSeek Web Chat** (`chat.deepseek.com`) and allows you to connect DeepSeek Web to Open WebUI, LiteLLM, Hermes, Claude Code, OpenAI SDK-style clients, and other OpenAI-compatible tools.

The project works through your normal logged-in DeepSeek account in a separate Chrome profile. The local server accepts API requests and then communicates with DeepSeek Web through the saved browser session.

> ⚠️ This is an experimental web-chat proxy. DeepSeek may change its internal Web API without notice. For production use cases, the official paid DeepSeek API is more reliable.

ForgetMeAI: https://t.me/forgetmeai

---

## Navigation

- [What this provides](#-what-this-provides)
- [Features](#-features)
- [Quick Start](#-quick-start)
- [Windows Setup](#-windows-setup)
- [Linux / Chromium Setup](#-linux--chromium-setup)
- [VPS / Headless Setup](#-vps--headless-setup)
- [Diagnostics / doctor](#-diagnostics--doctor)
- [Session reuse and chat reset](#-session-reuse-and-chat-reset)
- [Multi-account pool](#-multi-account-pool)
- [Console authorization ideas](#-console-authorization-ideas)
- [Checking if it works](#-checking-if-it-works)
- [Request examples](#-request-examples)
  - [Chat Completions](#chat-completions)
  - [Reasoning](#reasoning)
  - [Web search](#web-search)
  - [Streaming](#streaming)
  - [Anthropic Messages API](#anthropic-messages-api)
  - [OpenAI Responses API](#openai-responses-api)
  - [Tool calling](#tool-calling)
- [Models](#-models)
- [Endpoints](#-endpoints)
- [Open WebUI](#-open-webui)
- [Refresh login](#-refresh-login)
- [Project status](#-project-status)

---

## ✨ What this provides

- Use DeepSeek Web as a local API endpoint.
- Connect DeepSeek to Open WebUI and other OpenAI-compatible clients.
- Get regular JSON responses or streaming SSE.
- Use reasoning models with separate `reasoning_content`.
- Work with an Anthropic Messages API shim for Claude Code / Anthropic SDK.
- Use an OpenAI Responses API shim for new OpenAI/Codex-style clients.
- Maintain separate web sessions for different agents/users.

## 🚀 Features

- **OpenAI-compatible API:** `POST /v1/chat/completions`
- **Anthropic-compatible shim:** `POST /v1/messages`
- **OpenAI Responses shim:** `POST /v1/responses`
- **Streaming:** SSE chunks and regular non-stream JSON responses
- **Reasoning output:** separate `reasoning_content` for thinking models
- **Tool calling:** parsing OpenAI tools, Anthropic tools, and Responses function tools
- **Model capabilities:** `GET /v1/model-capabilities` with alias → real web mode mapping
- **Agent sessions:** separate DeepSeek session per `user` / agent id
- **Session recovery:** automatically resets stale chains/sessions
- **Zero dependencies:** Node.js 18+, no npm dependencies

---

## ⚡ Quick Start

```bash
git clone https://github.com/ForgetMeAI/FreeDeepseekAPI.git
cd FreeDeepseekAPI
npm run auth
npm start
```

`npm run auth` opens the authorization menu:

1. select option `1`;
2. log in to DeepSeek in a separate Chrome profile;
3. send a short message such as `ok`;
4. return to the terminal and press Enter.

`npm start` shows the startup menu:

- `1` — authorize / refresh DeepSeek login
- `2` — show models and statuses
- `3` — start the proxy
- `4` — exit

For headless/CI startup without the menu:

```bash
NON_INTERACTIVE=1 npm start
# or
SKIP_ACCOUNT_MENU=1 npm start
```

By default, the server listens on:

```text
http://localhost:9655
```

---

## 🪟 Windows Setup

```powershell
git clone https://github.com/ForgetMeAI/FreeDeepseekAPI.git
cd FreeDeepseekAPI
npm run auth
npm start
```

If Chrome is installed in a non-standard location, specify the path explicitly:

```powershell
$env:CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
npm run auth
```

If Chrome is not found, `npm run auth` now prints ready-to-follow instructions for Windows/macOS/Linux instead of a confusing stack trace.

---

## 🐧 Linux / Chromium Setup

```bash
git clone https://github.com/ForgetMeAI/FreeDeepseekAPI.git
cd FreeDeepseekAPI
CHROME_PATH=$(which chromium) npm run auth
npm start
```

If Chromium has a different binary name:

```bash
CHROME_PATH=$(which chromium-browser) npm run auth
# or
CHROME_PATH=$(which google-chrome) npm run auth
```

---

## 🖥 VPS / Headless Setup

The most reliable flow without Chrome on the server:

1. On your local PC with GUI/Chrome:

```bash
npm run auth
```

2. Copy `deepseek-auth.json` to the VPS:

```bash
scp deepseek-auth.json user@your-vps:/opt/FreeDeepseekAPI/deepseek-auth.json
```

3. On the VPS, import/check the file and set safe permissions:

```bash
cd /opt/FreeDeepseekAPI
npm run auth:import -- --input ./deepseek-auth.json
npm run doctor -- --offline
```

4. Start the proxy without the interactive menu:

```bash
NON_INTERACTIVE=1 npm start
```

You can import not only a ready-made `deepseek-auth.json`, but also a browser cookie export:

```bash
DEEPSEEK_TOKEN="<token>" npm run auth:import -- --input ./cookies.json
```

> Important: `deepseek-auth.json` gives access to your DeepSeek Web login. Do not commit it, do not publish it, and store it with `0600` permissions.

---

## 🩺 Diagnostics / doctor

```bash
npm run doctor
# without network requests to DeepSeek:
npm run doctor -- --offline
```

`doctor` checks:

- whether `deepseek-auth.json` / `DEEPSEEK_AUTH_DIR` is found;
- whether the JSON is valid;
- whether `token`, `cookie`, and `wasmUrl` are present;
- whether the file permissions are safe on macOS/Linux (`0600`);
- in normal mode, whether the DeepSeek PoW endpoint is reachable.

If you see `data.biz_data is null`, `fetch failed`, `401/403/429`, or Hermes/OpenCode cannot see the models, run `npm run doctor` first.

---

## ♻️ Session reuse and chat reset

FreeDeepseekAPI does not create a new DeepSeek chat for every HTTP request unless necessary. The logic is:

- one `x-agent-session`, `session`, or `user` → one DeepSeek chat session;
- if a session id already exists, the proxy reuses it and continues the chain through `parent_message_id`;
- auto-reset happens on TTL, DeepSeek session errors, or overly long message chains;
- local history is preserved as a short context so a new DeepSeek session can continue the conversation.

Explicitly set the agent/session:

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-agent-session: my-agent" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Hello"}]}'
```

View active sessions:

```bash
curl http://localhost:9655/v1/sessions
```

Reset one session:

```bash
curl -X POST "http://localhost:9655/reset-session?agent=my-agent"
```

Reset all sessions:

```bash
curl -X POST "http://localhost:9655/reset-session?agent=all"
```

Why chats still appear in DeepSeek Web: the proxy works through the internal Web Chat API, and DeepSeek stores real chat sessions on its side. This is normal for a web-proxy. The purpose of session reuse is to avoid creating unnecessary new chats and to reset cleanly only when the chain becomes stale or broken.

---

## 👥 Multi-account pool

You can connect multiple auth files. The correct model is sticky account per agent/session — the proxy does not switch accounts inside a live DeepSeek session. If an account receives `401/403/429` and enters cooldown, the session is safely reset and the next request can move to another available account.

Option 1 — directory with auth files:

```bash
mkdir -p accounts
cp deepseek-auth-main.json accounts/main.json
cp deepseek-auth-backup.json accounts/backup.json
chmod 600 accounts/*.json
DEEPSEEK_AUTH_DIR=./accounts NON_INTERACTIVE=1 npm start
```

Option 2 — list of files:

```bash
DEEPSEEK_AUTH_PATH="./accounts/main.json,./accounts/backup.json" NON_INTERACTIVE=1 npm start
```

How the pool works:

- a new agent/session receives an available account using round-robin;
- the selected account is attached to the session (`sticky`);
- on `401`, `403`, or `429`, the account enters cooldown;
- if the session’s sticky account enters cooldown, the old DeepSeek session is reset so the proxy does not keep hitting a rate-limited/expired account;
- account status is visible in `/health` without auth file paths or file names;
- auth files must be stored with `0600` permissions.

Configure cooldown:

```bash
DEEPSEEK_ACCOUNT_COOLDOWN_MS=600000 npm start
```

---

## 🔑 Console authorization ideas

A password-based flow from PR #3 can be implemented, but it is safer not to store passwords and not to make this the default behavior. A proper implementation would be:

1. `npm run auth:console` asks for email/phone and password through a hidden prompt.
2. The password is kept only in process memory and is not written to files/logs/history.
3. The script repeats the Web login flow through `fetch`/CDP: receives a captcha/verification challenge, gives the user a link/code, and waits for confirmation.
4. After a successful login, only `deepseek-auth.json` in the standard format is saved.
5. If DeepSeek requires captcha/2FA, the script honestly says “open the link, complete the verification, then press Enter” instead of trying to bypass protection.
6. For VPS, the preferred mode is `auth:console --no-save-password --output deepseek-auth.json`.

Minimal safe MVP: console auth is interactive only, without an environment password. Acceptable automation option: `DEEPSEEK_EMAIL=... npm run auth:console`, but the password is still entered through a hidden prompt.

---

## ✅ Checking if it works

```bash
curl http://localhost:9655/
curl http://localhost:9655/v1/models
curl http://localhost:9655/v1/model-capabilities
```

If everything is OK, `/health` returns the server status, the list of supported aliases, and `config_ready: true`.

---

## 🧪 Request examples

### Chat Completions

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Hello! Reply in one sentence."}],
    "stream": false
  }'
```

### Reasoning

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-reasoner",
    "messages": [{"role": "user", "content": "Explain briefly: why is the sky blue?"}],
    "stream": false
  }'
```

For reasoning models, the API returns the chain of thought separately from the final answer:

- non-stream: `choices[0].message.reasoning_content`
- stream: `choices[0].delta.reasoning_content`
- usage: `usage.completion_tokens_details.reasoning_tokens`

`reasoning_tokens` is an approximate estimate based on the extracted DeepSeek Web `THINK` text, because the web stream does not provide official token usage for reasoning separately.

### Web search

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat-search",
    "messages": [{"role": "user", "content": "Find a recent fact about DeepSeek and answer briefly."}],
    "stream": false
  }'
```

### Streaming

```bash
curl -N -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Write a short joke."}],
    "stream": true
  }'
```

### Anthropic Messages API

```bash
curl -X POST http://localhost:9655/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "max_tokens": 512,
    "messages": [{"role": "user", "content": "Reply exactly OK"}],
    "stream": false
  }'
```

For Claude Code, you can point the backend directly:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:9655"
export ANTHROPIC_AUTH_TOKEN="dummy-key"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude --model deepseek-chat
```

### OpenAI Responses API

```bash
curl -X POST http://localhost:9655/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "input": "Reply exactly OK",
    "stream": false
  }'
```

### Tool calling

FreeDeepseekAPI accepts:

- OpenAI `tools`;
- Anthropic `tools`;
- Responses API function tools.

The proxy asks DeepSeek to return a strict JSON tool call, but it can also parse fallback formats:

- `TOOL_CALL:`
- fenced JSON
- `<tool_call>...</tool_call>`

---

## 🧠 Models

`GET /v1/models` returns only aliases that are currently tested and work through this proxy.

### Working aliases

| Alias                      | Web mode            | Reasoning | Web search | Comment                 |
| -------------------------- | ------------------- | --------- | ---------- | ----------------------- |
| `deepseek-chat`            | `Fast` / `default`  | no        | no         | basic chat              |
| `deepseek-v3`              | `Fast` / `default`  | no        | no         | compatible alias        |
| `deepseek-default`         | `Fast` / `default`  | no        | no         | compatible alias        |
| `deepseek-reasoner`        | `Fast` / `default`  | yes       | no         | `thinking_enabled=true` |
| `deepseek-r1`              | `Fast` / `default`  | yes       | no         | R1-compatible alias     |
| `deepseek-chat-search`     | `Fast` / `default`  | no        | yes        | web search              |
| `deepseek-default-search`  | `Fast` / `default`  | no        | yes        | web search alias        |
| `deepseek-reasoner-search` | `Fast` / `default`  | yes       | yes        | reasoning + search      |
| `deepseek-r1-search`       | `Fast` / `default`  | yes       | yes        | R1-compatible + search  |
| `deepseek-expert`          | `Expert` / `expert` | no        | no         | Expert mode             |
| `deepseek-v4-pro`          | `Expert` / `expert` | yes       | no         | Expert + reasoning      |

Full mapping:

```bash
curl http://localhost:9655/v1/model-capabilities
```

According to the official DeepSeek V4 Preview page, `deepseek-chat` and `deepseek-reasoner` currently route to `deepseek-v4-flash` non-thinking/thinking. In `chat.deepseek.com` itself, the direct stream does not return the exact checkpoint name (`model: ""`), so the proxy records both the web mode (`default` / `Fast`) and the current official routing (`DeepSeek-V4-Flash`).

The current DeepSeek Web remote config shows these web modes:

- `default` / UI `Fast` — works; supports `thinking_enabled` and `search_enabled`.
- `expert` / UI `Expert` — works through the current web contract (`x-client-version=2.0.0`) and supports `thinking_enabled`. `/v1/models` exposes `deepseek-expert` without reasoning and `deepseek-v4-pro` as Expert + reasoning.
- `vision` / UI `Recognition` — visible in remote config, but the direct Web API currently returns `backend_err_by_model` (`Vision is temporarily unavailable`). Therefore, `deepseek-vision` is hidden from `/v1/models`.

Search for Expert is unavailable according to the remote config, so `deepseek-expert-search` remains unsupported.

---

## 🔌 Endpoints

| Method | Path                        | Purpose                                      |
| ------ | --------------------------- | -------------------------------------------- |
| `GET`  | `/` or `/health`            | proxy status                                 |
| `GET`  | `/v1/models`                | list of working OpenAI-compatible aliases    |
| `GET`  | `/v1/model-capabilities`    | full alias mapping, real model, capabilities |
| `POST` | `/v1/chat/completions`      | OpenAI-compatible Chat Completions           |
| `POST` | `/v1/messages`              | Anthropic Messages API shim                  |
| `POST` | `/v1/responses`             | OpenAI Responses API shim                    |
| `GET`  | `/v1/sessions`              | active local agent sessions                  |
| `POST` | `/reset-session?agent=<id>` | reset one session                            |
| `POST` | `/reset-session?agent=all`  | reset all sessions                           |

---

## 🖥 Open WebUI

Base URL for Open WebUI in Docker:

```text
http://host.docker.internal:9655/v1
```

For local startup without Docker:

```text
http://localhost:9655/v1
```

You can set any API key: the proxy itself connects to DeepSeek Web through the saved browser session.

---

## 🔐 Refresh login

```bash
npm run auth
npm start
```

If DeepSeek starts returning `401`, `403`, or asks for a new PoW/session, run `npm run auth` again and refresh the saved browser session.

Local authorization files must not be pushed to GitHub:

- `deepseek-auth.json`
- `.chrome-profile-deepseek/`
- `.env`

They are already added to `.gitignore`.

---

## 🧪 Tests

Project syntax check:

```bash
npm test
```

Live smoke tests against the running local proxy:

```bash
BASE_URL=http://127.0.0.1:9655 MODEL=deepseek-chat npm run test:live
```

---

## 📌 Project status

FreeDeepseekAPI is an experimental web-chat proxy for local use and integrations. It depends on the current DeepSeek Web Chat contract, so changes on DeepSeek’s side may require updates to the auth/session logic or model mapping.

If something stops working:

1. refresh the login with `npm run auth`;
2. check `/v1/model-capabilities`;
3. retry the request with a fresh session;
4. if the problem persists, DeepSeek has probably changed its internal Web API.

---

<p align="center">
  <strong>ForgetMeAI</strong> · <a href="https://t.me/forgetmeai">Telegram</a>
</p>
