# Yunzai-LLM-Plugin — Implementation Notes (agent hand-off doc)

> Keep this file current. It is the hand-off point if the working agent runs out of quota.
> Last updated: 2026-10-20 — v2 implemented, unit/integration tests + sandbox scenarios passing; not yet live-tested
> with real API keys; not committed.

## 0. Hard rules (from the user)

- **Never test against prod.** `config/config/onebot_client.yaml` and `onebot11.yaml` at the Yunzai root point at the
  production NapCat (`frenqy.rabimimi.com:8082`). Do **not** run `node app.js` / `start.bat` from the Yunzai root.
  Use the sandbox (`sandbox/`, see §8) which copies `lib/` + adapters into an isolated dir with its own config,
  its own HTTP port (2599) and its own redis (port 6390), and talks to a local fake NapCat.
- Starting a second Yunzai on the prod port (2536) is dangerous: `lib/bot.js#serverEADDRINUSE` calls `/exit` on
  the process already holding the port — i.e. it would kill the prod bot.
- The bot must only speak when invoked (`@bot`, reply-to-bot, DM per config). No proactive messages.
- Tell the user when ready for them to test; they test in prod themselves.

## 1. Layout

```
plugins/Yunzai-LLM-Plugin/            (separate git repo, branch master)
  index.js                 -> re-exports dist/index.js (what Yunzai loads)
  dist/                    -> tsup bundle (COMMITTED; Yunzai has no build step)
  src/
    index.ts               -> apps export + startup
    globals.d.ts           -> Bot/logger/segment/redis/plugin globals
    apps/chat.ts           -> @-trigger handler (lowest priority) + group log listener
    apps/admin.ts          -> #llm admin/user commands, sticker collection context
    core/                  -> paths, config (YAML w/ comment-preserving writes), json store, utils, yunzai glue
    llm/                   -> provider adapters: openai (chat completions), openai-responses, anthropic, gemini (Interactions)
    billing/               -> pricing (builtin + OpenRouter + LiteLLM), ledger/quota (rolling 5h + 7d), balance APIs
    chat/                  -> session/history, prompt builder, agent loop, reply humanizer, rate limits, group log, input extraction
    tools/                 -> registry + web_search, web_fetch (SSRF-guarded), bot commands, skills, custom JS/HTTP tools
    commands/              -> command catalog (runtime rule scan + help-file scraping + curated presets) and dispatcher
    stickers/              -> sticker store, vision indexing, picker
    help.ts                -> help menu text
  config/default_config.yaml  -> all options, commented (Chinese). config/config.yaml = user overrides (gitignored)
  skills/<name>/SKILL.md      -> custom skills (progressive disclosure via load_skill tool)
  tools/*.js                  -> custom JS tools (optional)
  data/                       -> runtime state (gitignored): sessions, usage ledger, pricing cache, stickers
  test/*.test.ts              -> node:test unit/integration tests (run TS directly, Node >= 23.6 type stripping)
  sandbox/                    -> isolated Yunzai + fake NapCat for manual testing
```

Build: `pnpm build` (tsup -> dist/index.js). Type-check: `pnpm type-check`. Tests: `pnpm test`.
Source uses `.ts` import extensions (`allowImportingTsExtensions`) so tests can run src directly with Node.
Only erasable TS syntax (no enums/parameter properties/namespaces) — `erasableSyntaxOnly` is on.

## 2. Requirements -> design map

| # | Requirement | Where / how |
|---|---|---|
| 1 | OpenAI / Anthropic / Gemini compatible APIs, latest standards | `src/llm/*`. Types: `openai` (Chat Completions, widest compat), `openai-responses` (Responses API), `anthropic` (Messages API, adaptive thinking + `output_config.effort`, cache_control), `gemini` (Interactions API `POST /v1beta/interactions`, steps-based I/O, `previous_interaction_id`). Raw `fetch`, no SDKs, because targets are arbitrary *compatible* base URLs. |
| 2 | Billing-based quota: rolling 5h + weekly per model | `src/billing/ledger.ts` (ledger of `[ts, usd]` per scope key+model, pruned >8d), `pricing.ts` (config price > provider-reported cost > OpenRouter/LiteLLM price lists > builtin table). Scopes: user/group/global, per model. On exhaustion: fall back along `fallbackModels`, else polite notice (rate-limited). `balance.ts` queries provider balance APIs (DeepSeek, OpenRouter, Moonshot, SiliconFlow). |
| 3 | Easy config (thinking level, persona, ...) | `config/default_config.yaml` + DM commands; `#llm设置 <path> <value>` generic setter writes `config.yaml` preserving comments (YAML Document API). Per-group overrides under `groups:`. |
| 4 | Stickers: admin adds, LLM indexes, sends sometimes | `src/stickers/*`. Add via `#llm添加表情` (image / reply-to-image / mface / collection mode), `#llm导入收藏表情` (NapCat `fetch_custom_face`). Vision model writes name/desc/tags. Prompt lists stickers; LLM appends `[表情:名称]`; picker resolves + gates (probability, per-group cooldown). Sent as image `sub_type:1` (shows as sticker) or native `mface`. |
| 5 | Admin config via DM + complete help | `src/apps/admin.ts`, `src/help.ts`. API keys may only be set in DM. |
| 6 | Tools / skills | `src/tools/*`: `web_search` (native provider search or Tavily/Brave/SearXNG/Jina), `web_fetch` (SSRF guard), `run_bot_command`, `search_bot_commands`, `load_skill`, custom JS tools (`tools/*.js`), HTTP tools (config). Skills = `skills/*/SKILL.md` (name+description in prompt, body loaded on demand). |
| 7 | Only `@` invocation | `src/apps/chat.ts`: rule at priority 99999 (after every other plugin) returns `false` unless `e.atBot` / reply-to-bot / allowed DM / optional alias. Synthesized command events carry `llmDispatched` and are ignored. |
| 8 | QQ risk control | `src/chat/reply.ts` + `ratelimit.ts`: max N bubbles/reply, typing delays, per-group + global token buckets, per-session lock, global concurrency cap, quote only when needed, markdown stripped, long text -> single forward msg, error/quota notices rate-limited. |
| 9 | Token conservation | Stable system prompt (no timestamps; dynamic info goes in the user turn), deterministic tool order, Anthropic cache breakpoints (system + last message), OpenAI `prompt_cache_key`, Gemini server state (`previous_interaction_id`), chunked history truncation (not sliding — keeps cached prefix stable), optional summary compaction with utility model, tool transcripts not persisted across turns, tool output truncation, images not re-sent in history, command dispatch ends the loop without an extra LLM call. |
| 10 | NL -> existing commands | `src/commands/*`: scans `PluginsLoader.priority` rules at runtime, scrapes plugins' help files (miao-style `title`/`desc`), curated Genshin/HSR/ZZZ presets; every candidate validated against live rule regexes. LLM calls `run_bot_command("#深渊")` -> synthesized event re-dispatched through the real loader as the same user (permissions intact). Never overrides existing commands (lowest priority). |

### Later changes (user requests, 2026-10-20)

- Sticker adding is **explicit only**: `#llm添加表情` adds images in that same message or in the message it replies to.
  The old "collection mode" (context that captured later images) was removed. Non-admins are rejected.
- `cli/config.mjs` + `cli/schema.mjs`: schema-driven config tool. `schema.mjs` lists every valid key (types,
  ranges, enums — static or derived from the config: provider names, model ids, persona names — required fields for
  new providers/models/groups, provider-type-specific fields via `when`). The interactive browser shows all schema
  keys incl. unset ones; widgets: radio list for bool/enum, checkbox for multi-value, number/text/password/editor;
  map/array entries via guided "+ 新增"; nothing outside the schema can be written and every write is validated
  (`validate`, `validatePath` for map keys like group ids). Subcommands `list|get|describe|set|unset|check` use the
  same schema; `check` also flags invalid keys hand-written into config.yaml. **When adding a config option, add it
  to schema.mjs too** — `test/cli.test.ts` fails if default_config.yaml has a key the schema doesn't know.
  Uses `@inquirer/prompts` (CLI-only dependency, not bundled). Tests drive it through a pipe with raw key codes.
- Default model ids updated to the current official ones (2026-10): claude-sonnet-5-5 / claude-haiku-5-5,
  gpt-6.1-sol / gpt-6-luna, gemini-3.8-flash / gemini-3.5-flash-lite, deepseek-flash. All are in the LiteLLM price list
  (DeepSeek listed at its peak rate). `schema.mjs#KNOWN_MODELS` holds the CLI's model suggestions.
- **Long-term memory** (`src/memory/`): per-user (keyed by QQ, shared across chats) and per-group lists, edited by
  the LLM through the `memory` tool (add/update/delete, ≤ `memory.maxWritesPerTurn` per turn). Hard caps
  (`userMaxEntries/userMaxChars/groupMaxEntries/groupMaxChars/entryMaxChars`) are checked on every write, so the
  store can't exceed them; near-duplicates merge into the existing entry; sensitive data is refused; at ≥80% of a
  budget `compact.ts` asks the utility model to consolidate to ~60% (output validated, unchanged on failure).
  Injected as a stable prefix message (`prompt.ts#buildMemoryBlock`), never in the system prompt; in shared group
  sessions the speaker's memory rides in the turn header instead. Server-state key includes a memory hash.
  Commands: `#llm记忆`, `#llm删除记忆`, `#llm忘记我`, admin `#llm清空长期记忆`. Tests: `test/memory.test.ts`.
- Sandbox repro of prod: `--runtime <name>` uses a separate `sandbox/.runtime-<name>/` (e.g. without game plugins,
  like prod), `--overlay <file>` merges YAML over the generated plugin config (copy prod's settings minus
  providers/models/keys, remap the group whitelist to 30001). Used 2026-10-20 to debug "#深渊 fails in prod":
  prod has no genshin/miao-plugin installed, so no rule matches `#深渊` (plugin behaved correctly).
- Sandbox speedups: ready = plugin's "指令目录" log line (not a fixed sleep); expect timeout 10s with the mock;
  scripted runs wipe usage/sessions/memory first (a previous run's spent quota made every reply a quota notice).

## 3. Key framework facts (TRSS-Yunzai 3.1.3, this checkout)

- `lib/plugins/loader.js#deal(e)`: runs context hooks, then `accept()` hooks, then rules across all plugins sorted by
  `priority` asc; first rule whose regex matches and whose fnc doesn't return `false` ends processing.
- `dealEvent` sets `e.msg` (concat of text segs), `e.atBot` (at seg == self_id), `e.img`, `e.reply_id` + `e.getReply()`,
  `e.isMaster`. Group cooldowns: `loader.groupCD[group_id]`, `loader.singleCD["gid.uid"]`, `loader.msgThrottle`.
- `srReg` (`*` prefix -> `#星铁`) and `zzzReg` (`%` -> `#绝区零`) normalization happens inside `deal`.
- Loader imports plugins as `../../plugins/<dir>/index.js` **relative to its own real path**, so a sandbox needs its own
  copy of `lib/`. We get the loader instance via `import(pathToFileURL(cwd/lib/plugins/loader.js))` and verify it
  contains our own plugin class (handles drive-letter case mismatch) — see `src/core/yunzai.ts`.
- `Bot.prepareEvent`, `Bot.em`, `Bot.makeLog`, `Bot.sleep`, `Bot.Buffer` exist. `segment.image(file)` -> `{type:'image', file}`;
  OneBotv11 adapter turns `{type, ...fields}` into `{type, data:{...fields}}`, so extra fields (e.g. `sub_type`, `summary`) pass through.
- NapCat extras used: `fetch_custom_face`, `set_input_status` (DM typing), `mface` segments.
- miao/genshin/StarRail/ZZZ plugins are NOT installed in this checkout; the sandbox installs them for testing.

## 4. Provider adapter contract (`src/llm/types.ts`)

Neutral history: `user{content: Part[]}`, `assistant{content, toolCalls?, native?}`, `tool{results}`.
`native` holds provider-raw output (thinking signatures, reasoning items, Gemini thought steps) and is replayed verbatim
only when the next request goes to the same provider+model within the same tool loop. Persisted history never stores
`native` or tool transcripts.

Usage normalized to `{input (uncached), cacheRead, cacheWrite, cacheWrite1h, output (incl. reasoning), reasoning, webSearches, cost?}`.

Server state: `ChatParams.state = {previousId, skip}` means `messages[0..skip)` already live server-side.
Used by `gemini` (default on) and `openai-responses` (opt-in `serverState: true`).

## 5. Status

See checklist at the bottom (§9). Update it whenever a piece lands.

## 6. Conventions

- User-facing strings and YAML comments in Chinese; code comments in English, sparse.
- No new runtime deps beyond `yaml` (already in Yunzai root). Node >= 22 globals (`fetch`, `AbortSignal.timeout`).
- All persistence via `src/core/store.ts` JSON stores under `DATA_DIR` (env `YZ_LLM_DATA_DIR` overrides; tests/sandbox use it).

## 7. Testing

- `pnpm test` -> `node --test test/` — 52 tests, ~6s, no network:
  - `providers.test.ts`: request/response shape for all 4 formats against a mock HTTP server (tool calls, usage
    normalization incl. cache read/write, native replay, Anthropic cache breakpoints, Gemini `previous_interaction_id`,
    key rotation on 401, retry on 429).
  - `core.test.ts`: config merge / comment-preserving writes / group-id keys, pricing + cost math, rolling quota windows,
    markdown stripping, bubble splitting, sticker markers, SSRF guard, HTML extraction, token bucket, KeyedLock.
  - `integration.test.ts`: real `LLMChat` handler + fake PluginsLoader + mock OpenAI/Gemini server: @-only triggering,
    synthesized-event ignore, prompt-cache stability across turns, NL->`#深渊` dispatch (one LLM call, no extra text),
    master-command refusal, 400-degrade-and-retry, Gemini chain reuse + stateless fallback, quota block + notice
    cooldown + fallback model, catalog validation (srReg normalisation, catch-all exclusion, help scraping).
- Price-list fetchers were probed once against the real LiteLLM/OpenRouter lists (1720 models parsed).
- **Not done (needs keys): live calls against real Anthropic/OpenAI/Gemini endpoints.** Request bodies follow the
  current docs (Anthropic skill reference; Gemini Interactions OpenAPI spec downloaded 2026-10-20; OpenAI Responses
  reference). First real-key run should be in the sandbox: copy `sandbox/config.example.yaml` -> `sandbox/config.yaml`.

## 8. Sandbox (manual end-to-end without prod)

`node sandbox/run.mjs` (see `sandbox/README.md`): builds `sandbox/.runtime/` with copied `lib/`, adapters, this plugin,
safe configs (server port 2599, redis 6390, master = fake QQ 10001, OneBotClient -> ws://127.0.0.1:3299),
starts a fake NapCat WS server with a REPL to inject group/private messages and print bot output.

- `node sandbox/run.mjs --mock --script sandbox/scenarios/basic.txt` — passes (chat, empty-@, reply-to-bot, bubbles,
  forward, NL->command, admin DM commands, sticker add/collect/import-favorites/send, key-in-group refusal + recall,
  private typing, image input).
- `node sandbox/install-plugins.mjs` clones miao-plugin, genshin (TRSS), StarRail-plugin, ZZZ-Plugin into the sandbox
  only. `scenarios/games.txt` passes: 300 rules scanned, 112 commands verified; 「帮我查查深渊数据」→`#深渊` (miao),
  「星铁忘却之庭」→`*忘却之庭` (StarRail-plugin), 「绝区零深渊」→`%式舆防卫战` (ZZZ-Plugin); direct `#深渊` never hits the LLM.
- Sandbox-only relaxations (in the generated mock config): `trigger.userCooldown: 0`, `reply.groupRate 30/60s`,
  Yunzai `groupCD/singleCD: 0` — scripts send faster than humans. Prod defaults are stricter on purpose.

## 9. Open items / ideas for the next agent

- Live smoke test with real keys (sandbox first). Watch the log line `[LLM] [model] …ms in=… cache=…/… out=… $…`
  for cache hit rates; `#llm统计` shows per-model cache hit %.
- Unknown-on-purpose model params are handled by `agent.ts#featureToDrop` (400 -> drop nativeSearch/thinking/tools for
  that model, rebuild system prompt, retry). If a compat endpoint 400s for another optional param, extend it there.
- MCP client tools are not implemented (only JS/HTTP custom tools + skills).
- `trigger.alias` (Yunzai botAlias) is off by default; groups with `onlyReplyAt: 1` may want it on.
- Possible: per-message "thinking" reaction (`set_msg_emoji_like`) while the LLM works; deliberately not added
  (extra API actions = more bot-like).
- Anthropic `web_search` tool version is picked by model-name regex in `llm/anthropic.ts#searchToolType`.

## 10. Checklist

- [x] core: paths, log, store, util, config (+ comment-preserving set), yunzai glue
- [x] llm: types, http/retry, openai chat, openai responses, anthropic, gemini interactions
- [x] billing: pricing (builtin/openrouter/litellm), ledger + quota, balance
- [x] chat: input extraction, group log, session/history/compaction, prompt, agent loop, reply humanizer, rate limits
- [x] tools: registry, web_search, web_fetch+ssrf, bot command, skills, custom
- [x] commands: catalog scan, help scrape, presets, dispatcher
- [x] stickers: store, indexer, picker, sender
- [x] apps: chat trigger, admin commands, help menu
- [x] default_config.yaml
- [x] README (user-facing), example skill (`skills/genshin-team`), example custom tool (`tools/example-dice.js.example`)
- [x] tests: 52 passing (see §7)
- [x] sandbox + fake NapCat + mock LLM + game-plugin installer; both scenarios pass (see §8)
- [x] dist built (`pnpm build` — rebuild after any src change; Yunzai loads dist/, not src/)
- [ ] commit — not done; the user hasn't asked yet (plugin is its own git repo, branch `master`)
- [ ] live test with real API keys (user / next agent, sandbox first)
- [ ] prod rollout by the user

### Gotchas found so far
- `yaml` `doc.setIn()` creates a *sequence* for numeric keys: `config.resolvePath()` keeps `groups.<qqGroupId>` as a string key.
- Fake events in tests need `group.sendMsg` — the dispatcher prefers the raw group/friend sender over the wrapped `e.reply`.
- Anthropic: don't put `cache_control` on thinking blocks; we only mark the final user block (text/image/tool_result).
- Gemini Interactions responses contain only *new* steps (not the echoed input); `status: requires_action` when function calls are pending. Never persist a server-state chain that ended with unanswered tool calls (agent.ts `cleanEnd`).
