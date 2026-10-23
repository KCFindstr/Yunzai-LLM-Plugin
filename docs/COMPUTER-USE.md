# Persistent pixel PC

The optional computer agent owns a shared character desktop, not the host's Windows desktop. It uses a separate configured vision/tool model and a serialized global queue. A task starts only after the chat acknowledgement has been sent. Acknowledgements stay in character and first-person, without exposing queues, worker models or job IDs. Results return to the original triggering chat model with its persona and conversation; that model chooses the final reply and attachments. Worker prose is never sent directly. Normal chat remains available while it works.

## Setup

First provision the dedicated WSL distro with `npm run exec-setup` (see README). Then run `npm run computer-setup -- --distro yunzai-sandbox`. The setup requires a dedicated distro with Windows automount and executable interop disabled. Do not use a personal development distro. Restart the bot after enabling `tools.computer`.

```yaml
tools:
  computer:
    enable: true
    distro: yunzai-sandbox
    access: admin
    model: ''
    maxSteps: 100
    maxMinutes: 20
    maxInputTokens: 150000
    maxOutputTokens: 30000
    maxQueue: 8
    recentScreenshots: 2
    maxTokensPerStep: 1200
    thinking: 'off'
    checkpointSteps: 8
```

`model` is an existing model ID, separate from the chat model; empty uses the conversation's model. It must support images and function calling. All API calls use existing provider configuration and quota accounting. Input limits include cached tokens. A budget can be exceeded by the final in-flight API response; limits are checked before subsequent calls/actions. `chat.maxToolRounds` is unchanged. Per-step output and thinking are separately configurable (default 1200 tokens and off). The worker is instructed to emit tool calls only while working, and one final report via `finish`; tool arguments and any model reasoning are still billable output.

Examples: “take a screenshot of your desktop”, “去哔哩哔哩找一个关于你的视频”. The main model loads `skills/computer-use/SKILL.md`, then delegates complete context to `computer_task`. The worker loads `desktop/SKILL.md` only for an actual job. It does not inherit QQ-specific logic or any Codex-app computer-control capabilities.

## Chat images and reverse image search

Attach an image or quote its original message and ask “用浏览器 Google 图片以图搜图，查这是谁”. `computer_task(start)` automatically snapshots the current/quoted image bytes already loaded by chat. Optional `image_indices: [1]` selects by the order seen in this turn; omit it for all images, or use `[]` for none (up to eight images, 3.7 MB each). Chat's `includeImages`, `includeQuoted`, `maxImages` and vision-model settings still govern which images are loaded.

Original files are stored outside the short-lived code sandbox in `data/computer-inputs/<job>/`. When the queued task actually runs, the trusted transport writes them as user `pc` into the existing desktop's mounted work directory. The worker receives verified absolute paths such as `/work/attachments/<job>/image-1-<hash>.jpg`. No additional VM, desktop service, browser session or setup is created. GIFs retain their original bytes; expired signed URLs do not affect an already captured task. Transfer failure stops the task before model execution instead of inventing a usable path.

The browser worker opens Google Images / Lens, uploads the attached file using its path, and inspects visual matches and source pages. Keyword searches alone are not reverse image search, and a similar image is not proof of identity. CAPTCHA/login barriers are reported. Resume restores the files and paths; `respond` with new images replaces the job's inputs, otherwise it retains the originals. Chat history's old `[图片]` placeholders contain no image bytes: quote or attach the source again when starting a new image task.

The minimal screenshot is not a browser-only capability limit. The worker can run Bash/Python, open installed Linux GUI apps on the same display, download compatible portable apps and install tools in its own persistent home/work directories. It cannot run host Windows apps, use sudo or install system packages into the read-only OS. New binaries need compatible dependencies; AppImage may need extraction because FUSE is not exposed. The skill tells it to check installed tools, use absolute paths for user-local executables, detach GUI processes and verify the result visually. No extra apps are installed merely by asking what is supported.

## Lifecycle

- Tools: `computer_task` actions `start`, `status`, `cancel`, `respond`. An omitted ID selects this requester's most recent job in the same conversation. Ownership includes bot, requester and conversation; another user or group cannot inspect/cancel/resume your jobs. `#llm电脑任务` explicitly exposes diagnostic IDs when requested.
- One job controls the desktop at a time. Queued jobs wait; each requester can queue at most two jobs. Paused jobs release the lease; resumed tasks re-observe the desktop.
- The worker reports completion, failure or a necessary question to the chat model. Only an actual new incoming user message can authorize continuation, not a worker report or an invented approval from the main model.
- Bot shutdown cancels work; queued/running jobs become interrupted on restart, never automatically replayed. Status/report metadata survives in `data/computer-jobs.json`. Resume deliberately; the desktop/files remain.
- API observations are not automatically posted to chat. `share=true` selects up to four screenshots for the chat model to inspect; it selects which to send through `computer_result`. Requested screenshots are real X11 captures, not generated images.
- Delivery errors are recorded without automatic retries that could duplicate messages. Status can retrieve the report.

## Environment and persistence

The isolated UTS hostname is `Amatsukaze`; `/etc/hostname` and `/etc/hosts` are overlaid with neutral files, so terminal prompts do not expose the Windows host name. The host itself is not renamed.

The `llm-desktop` systemd service runs Openbox, Xvfb, Chrome, xterm and tint2 in a bubblewrap namespace as UID 2001. It has no host-drive mounts, no bot files/API keys, a public-internet-only UID firewall (DNS plus its local Chrome control endpoint excepted), a 3 GiB memory cap, 2-CPU quota, process limit and a 4 GiB ext4 disk for `/home/pc` and `/work`. The loop image is `/var/lib/llm-desktop/desktop.ext4`. The service's control socket is permission-restricted and is not an HTTP endpoint. Remote viewing is optional and requires the RustDesk configuration below.

## Optional RustDesk access

`npm run rustdesk-setup -- --distro yunzai-sandbox` installs the pinned official RustDesk 1.5.0 client (SHA-256 checked against its release asset) plus Linux dependencies. It extracts the application without running its package post-install hooks or installing the root RustDesk service. A small launcher runs as `pc` inside the existing desktop namespace on `DISPLAY=:99`, sharing the same Chrome and files as the computer-use agent. Setup starts the launcher through the existing control socket; it does not restart the desktop. The opt-in startup hook also restores it when the desktop service next starts, and a file lock prevents duplicate launchers.

The initial configuration deliberately sets `stop-service = 'Y'` and a `pending.invalid` custom rendezvous/relay address. It is a staged installation, not yet remotely reachable. Complete configuration with the owner's ID/rendezvous address, relay address, server public key and connection authentication before enabling registration. Do not use the server private key. The default desktop firewall already allows outbound connections to public relay servers; a private/LAN relay requires an explicit narrow exception. No host Windows desktop or bot credentials are exposed by this installation.

RustDesk setup does not keep WSL awake or add a Windows logon task. WSL can idle out when Yunzai is stopped, even with Linux services running. To wake the existing distro and keep it available for a remote session, run `wsl -d yunzai-sandbox -u pc -e sleep infinity` in Windows Command Prompt or PowerShell and leave that terminal open. Ctrl+C ends that temporary keeper and lets WSL idle again (provided Yunzai or another process is not holding it awake). The optional `powershell -File cli/rustdesk-keepalive.ps1` helper starts a hidden keeper only when explicitly invoked.

Desktop-side configuration and diagnostics are in `/home/pc/.config/rustdesk/` and `/home/pc/.config/llm-desktop/rustdesk-launch.log` (backed by `/var/lib/llm-desktop/disk/home/` in the distro). The launcher opt-in is `/home/pc/.config/llm-desktop/rustdesk-enabled`. Disable registration in RustDesk before removing that marker; the marker prevents future launcher starts but does not immediately terminate an already-running server. End-to-end connectivity and remote input still need verification after configuring the owner's relay.

Chrome runs without its own sandbox inside this outer isolation boundary. This is not a hardened hostile multi-tenant VM; all authorized users share the same character PC, files and browser profile. Do not sign into personal accounts or place secrets there. `access: all` permits everyone who can invoke chat to control this shared PC; use `admin` for a private installation. Snapshots/backups should be taken with the service stopped. Old pre-volume home/work directories are preserved by initial migration.

The bot holds a hidden WSL keepalive while enabled, so WSL idle shutdown does not destroy the running UI. Browser profile/files survive service/host restarts, but running programs and active tabs are not guaranteed to survive a host restart. User-installed software belongs under `/home/pc` or `/work`; the system files are read-only. Do not terminate the distro during an active task.

Screen: 1024×768, pastel pixel-art theme, Fusion Pixel 12px Mono fonts (Chinese/Japanese variants) with Noto CJK fallback. Terminal renders at an integer 2× scale (24 px); desktop labels at 12 px. Setup downloads a pinned upstream font archive, checks SHA-256 and preserves bundled licenses. See [Fusion Pixel Font](https://github.com/TakWolf/fusion-pixel-font). Site-specific web fonts can override browser defaults.

## Token use and permissions

The worker reads compact visible browser text/links where possible; uses screenshot/action batches for graphics; and can checkpoint a progress note to replace long tool history. Non-Claude routes retain only recent screenshots per request. Claude keeps the segment append-only to avoid invalidating its explicit cache; the runtime requests a checkpoint after `checkpointSteps` model steps, retaining only `recentScreenshots` in the new segment. It disables server-side conversation chaining so discarded context is actually removed from subsequent requests. Screenshots use original detail in OpenAI Responses and high detail in Chat Completions; other providers receive native image parts. Pixel colors and PNG compression do not themselves lower image-token costs.

For Claude, use an Anthropic Messages provider (`type: anthropic`). Explicit cache markers cover the last tool definition, stable system/skill prompt, previous user turn and latest user turn (at most four). `providers.<provider>.cacheTtl` defaults to 5m; 1h is optional but has a higher write cost and is not automatically enabled. Every step refreshes active cache entries. The task status/logs expose actual cache read/write tokens; do not assume a hit merely because markers were sent. Provider/model-specific minimum lengths still apply (Haiku 5.5: 512; Haiku 4.5: 4096); prompts are not padded to meet thresholds. OpenAI-compatible Claude proxies do not automatically receive Anthropic cache markers and require their own documented cache support. See [Claude caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

Ordinary navigation, public downloads, clicks, and writes inside the PC do not require per-action approval. The worker asks only for essential missing information or consequential actions lacking specific user authorization (payments, external posting, sensitive transmission, destructive valuable-data changes, account/security changes). This is an agent policy, not a classifier that can guarantee every risky click is detected. Webpage content is untrusted and cannot authorize actions. The strongest enforced boundaries are environment isolation, access/ownership, queue serialization, quotas and budgets. CAPTCHA/login barriers are reported, not bypassed. Video inspection uses selected frames; screenshots alone do not provide audio understanding.

## Diagnostics

The web panel's **电脑任务** page shows a per-task timeline of user requests, visible worker responses, tool calls/results, reports, and the final chat-model reply. It refreshes every three seconds. Shared worker screenshots are labelled as candidates; the separate sent-screenshot gallery contains only images whose chat delivery succeeded, and opens full-size previews. Provider-native reasoning and unshared desktop observations are not saved. Detailed history starts with new runs after upgrading; older jobs retain their existing summaries.

History lives in `data/computer-history/<job-id>/`: up to 1,000 events / 2 MiB of text and 64 screenshots / 32 MiB per retained job (4 MiB per image, deduplicated). When the queue evicts an old job, its history and screenshots are removed too. Both history and image endpoints require the panel login.

Info logs show the selected computer model, resolved input/output/cache prices per million tokens and their source, plus final usage and USD cost. Each agent turn has debug records for request size, model/tool response, usage, cache tokens, elapsed time and cost. Tool observations are bounded; image payloads and credential-labelled fields are redacted. Typed text arguments are logged only as character counts. Debug logging can still contain public page excerpts or task details: restrict log access. Set `YZ_LLM_DEBUG=1` before starting the bot to promote these debug records to the normal info log; otherwise they use Yunzai's debug level. Unknown prices are labelled unknown, not a verified free request. `#llm电脑任务 <id>` includes model and cost too.

`wsl -d yunzai-sandbox -u root -e systemctl status llm-desktop` and `journalctl -u llm-desktop` inspect the service. Internal runtime operations are `health`, `screenshot`, `actions`, `browse`, `exec` via `/opt/llm-desktop/client.py` JSON stdin. Do not expose the socket or Chrome debug port externally. Setup updates theme files and restarts the desktop, so run it between tasks.
