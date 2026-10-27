# Async worker (AGY)

`agy` handles sustained analysis, coding and file processing on the Windows host. It uses the native Antigravity CLI with `gemini-3.8-flash-medium`, medium effort, `--sandbox` and `--dangerously-skip-permissions` (turbo). Every tool request is automatically approved. Treat enabling AGY as granting full access to the host machine, including its files, commands, network and signed-in accounts. The plugin adds no worker filesystem, command or network access checks. The CLI's own sandbox is used as provided; it is not the bot VM's isolation boundary.

The chatbot acknowledges the request first, runs the worker asynchronously, then summarizes the result in the original conversation's voice. Google Lens image search remains a separate `google_lens` tool and skill.

## Setup

Run `npm run agy-setup` in the plugin directory. It installs a host CLI at `data/agy-setup/agy.exe` if absent, using the official Windows manifest and checking its SHA-512 checksum. Sign in to Antigravity using the same Windows account that runs the bot. AGY inherits that account's normal environment, tools, CLI profile and login. Setup and execution do not create or modify private CLI profiles, permission settings or MCP configurations, and never invoke WSL, install VM services or restart the desktop.

Configure `tools.agy.enable`, `access` (`admin` or `all`), optional `executable`, `maxMinutes` (1–30), `maxQueue` (1–50) and `maxChainDepth` (0–10, default 1: how many times in a row a result turn may start or resume another job). Defaults remain disabled and admin-only. The former `tools.agy.distro` setting is obsolete and ignored. The setup wizard only checks that the host CLI is runnable and supports the required flags; it does not probe login, model access or filesystem permissions. `node cli/agy-verify.mjs` runs a small native file task and uses the account's AGY allowance. `node cli/agy-verify-image.mjs <bot-image-path>` tests native image reading through the prompt mapping.

Each chatbot session retains a normal host task folder under `data/agy-workspaces/<session>/` and starts a fresh CLI conversation on every execution, including follow-up/clarification runs. These folders organize task files; they do not confine the worker. Each task must include its required context; previous files remain available through the same path mapping. Resetting or expiring the chatbot session starts a fresh mapping; late updates cannot replace it. Old files are not automatically deleted. Jobs remain serialized.

Old `data/agy-setup/profile`, broker scripts and VM services from earlier versions are unused by AGY. The launcher explicitly selects the real Windows account's CLI data directory and removes inherited parent-CLI backend/profile selectors, so a bot started from an old AGY terminal cannot silently reuse its deny rules. Other host environment variables and tools remain inherited. Previously saved CLI conversation IDs are discarded while retaining their existing output folder. Setup does not remove old files or touch the bot VM. Google Lens keeps its independent `lens-setup` workflow.

## Image and output paths

The prompt supplies an explicit path mapping on every task, including continuations. Task text and reports are not rewritten with regexes, and files are not copied or staged through the VM.

| Bot alias | Real host location |
| --- | --- |
| `/work/attachments/<rest>` | `data/images/<rest>` |
| `/work/agy/<session>/out/<rest>` | `data/agy-workspaces/<session>/out/<rest>` |
| CLI `brain/<rest>` artifacts | `<Windows home>/.gemini/antigravity-cli/brain/<rest>` |

The worker resolves input aliases to host paths for native file/image tools. The image store and native CLI brain directory are passed with `--add-dir` so the CLI sandbox can use those files directly. It is instructed to keep intermediates in its working folder, always save final deliverables inside `out/`, and report only the corresponding bot aliases. When image generation writes to `brain/`, the worker must copy the actual image into `out/` with native host tools and verify it exists before reporting delivery. A text placeholder or frontend copy suggestion is not a deliverable. The output directory is created before launch. Input images retain their global 30-day TTL, independent of chatbot session expiry.

The bot's normal `read_image`, `send_image` and `render_html` tools can consume current-session AGY output aliases without WSL. Reading an output image imports it into the chat's image store. Existing bot image validation and chat scoping still apply; arbitrary host paths are not accepted by those chatbot tools. Other output files remain on the host at the documented mapping. Completion can inspect and deliver the images the user requested with its final text; only `read_image` and `send_image` may execute during that turn.

Completion uses the original session's effective configuration and an in-memory snapshot of the initiating model/provider, system prompt, complete tool declarations, resolved thinking level, native-search setting and generation parameters. It appends the worker result to the same session, preserving its prompt-cache key and reusable server-side conversation. Tool restrictions are enforced at execution rather than by changing the declarations or system prompt. The snapshot is never persisted; account keys remain in memory with the pending job.

## Reports and delivery

Worker task text, reports, saved history and final replies retain the existing credential/privacy redaction. Host paths are omitted from reports; bot aliases survive filtering. Worker diagnostics go to filtered debug logs and are not sent to chat. This filtering is not a worker access restriction or a guarantee against disclosure by a fully authorized process. Worker completion cannot start more jobs or substitute for user authorization. Failed summarization never falls back to raw worker output.

The stream reader processes a terminal record even without a final newline. A successful terminal result may use the last completed visible response when its response field is empty; an optional init banner is not required for success. Real CLI failures retain their exact exit/status details and any partial work in history and the completion input, rather than replacing everything with a generic startup error. Missing terminal confirmation or a nonzero exit remains a failure even if the worker's prose claims success.

Jobs remain owned by bot/user/group, bounded by queue size and timeout, cancellable, and are not replayed after restart. The admin/all setting controls who may invoke the worker, rather than restricting what it can access once running.

## Web panel

Open **系统管理 → 异步代理（AGY）** (`#/agy`) for progress, usage, results, delivery status and execution history, refreshed every three seconds. Start or continue tasks from chat to retain the original context and reply destination.

Expand **实际发送给 AGY 的提示（已脱敏）** in task details to inspect the effective worker prompt, including the path-mapping and artifact-copy instructions. Every launch/continuation records its own prompt before execution. Host paths and secrets are redacted. Older executions cannot reconstruct a prompt that was never recorded; their next continuation will save one.

The configuration form and setup wizard show a warning immediately when `access: all` is selected: every user who can invoke the bot may use AGY's full access to the host machine. The warning remains visible while all-user access is configured. No additional approval dialog is added.

Authenticated `/api/agy`, `/api/agy/:id/history` and `/api/agy/:id/cancel` routes retain normal panel login and CSRF protection. History is filtered before persistence and again on read, bounded to 500 events / 2 MiB per task, and pruned with retained jobs. Raw provider reasoning is never recorded; a response shows the thinking summary the CLI writes to its own `brain/<conversation>/.system_generated/logs/transcript.jsonl` (the stream itself only reports thinking token counts), redacted like other history text. Tool records keep the CLI step index so parallel and repeated calls of the same tool stay separate. Subagents started by `invoke_subagent` run as separate CLI conversations that never appear in the parent stream; the parent transcript records the child conversation id on that tool record, and `/api/agy/:id/subagents/:conversation` serves the child transcript (thinking summaries, tool calls and results, same filtering) only for conversations reachable from the job's own records, up to four levels of nesting. The panel shows it inline under the tool call and refreshes it while the subagent is running. Each run notes its CLI conversation. The first time a finished task is viewed, missing thinking summaries and subagent links are filled from those transcripts; tasks recorded before that (no step indexes or conversation ids) are matched by prompt and time window and paired by order of tool calls, and are left as they are if the pairing is ambiguous. A call still marked running after its run ended shows as 未报告结果. `[AGY <job>]` debug logs follow the existing debug controls.
