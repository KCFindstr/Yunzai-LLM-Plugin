# Persistent pixel PC

The optional computer agent owns a shared character desktop, not the host's Windows desktop. It uses a separate configured vision/tool model and a serialized global queue. A task starts only after the chat acknowledgement has been sent; results are proactively delivered to that same conversation. Normal chat remains available while it works.

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

## Lifecycle

- Tools: `computer_task` actions `start`, `status`, `cancel`, `respond`. Include the task ID in follow-ups. Ownership includes bot, requester and conversation; another user or group cannot inspect/cancel/resume your jobs.
- One job controls the desktop at a time. Queued jobs wait; each requester can queue at most two jobs. Paused jobs release the lease; resumed tasks re-observe the desktop.
- The worker reports completion, failure or a necessary question. Reply with the task ID to continue. Only the actual incoming user message is supplied as a response, not an invented authorization from the main model.
- Bot shutdown cancels work; queued/running jobs become interrupted on restart, never automatically replayed. Status/report metadata survives in `data/computer-jobs.json`. Resume deliberately; the desktop/files remain.
- API observations are not automatically posted to chat. `share=true` selects up to four screenshots for the final report. Requested screenshots are real X11 captures, not generated images.
- Delivery errors are recorded without automatic retries that could duplicate messages. Status can retrieve the report.

## Environment and persistence

The isolated UTS hostname is `Amatsukaze`; `/etc/hostname` and `/etc/hosts` are overlaid with neutral files, so terminal prompts do not expose the Windows host name. The host itself is not renamed.

The `llm-desktop` systemd service runs Openbox, Xvfb, Chrome, xterm and tint2 in a bubblewrap namespace as UID 2001. It has no host-drive mounts, no bot files/API keys, a public-internet-only UID firewall (DNS plus its local Chrome control endpoint excepted), a 3 GiB memory cap, 2-CPU quota, process limit and a 4 GiB ext4 disk for `/home/pc` and `/work`. The loop image is `/var/lib/llm-desktop/desktop.ext4`. The service's control socket is permission-restricted and is not an HTTP endpoint. No remote viewer is exposed.

Chrome runs without its own sandbox inside this outer isolation boundary. This is not a hardened hostile multi-tenant VM; all authorized users share the same character PC, files and browser profile. Do not sign into personal accounts or place secrets there. `access: all` permits everyone who can invoke chat to control this shared PC; use `admin` for a private installation. Snapshots/backups should be taken with the service stopped. Old pre-volume home/work directories are preserved by initial migration.

The bot holds a hidden WSL keepalive while enabled, so WSL idle shutdown does not destroy the running UI. Browser profile/files survive service/host restarts, but running programs and active tabs are not guaranteed to survive a host restart. User-installed software belongs under `/home/pc` or `/work`; the system files are read-only. Do not terminate the distro during an active task.

Screen: 1024×768, pastel pixel-art theme, Fusion Pixel 12px Mono fonts (Chinese/Japanese variants) with Noto CJK fallback. Terminal renders at an integer 2× scale (24 px); desktop labels at 12 px. Setup downloads a pinned upstream font archive, checks SHA-256 and preserves bundled licenses. See [Fusion Pixel Font](https://github.com/TakWolf/fusion-pixel-font). Site-specific web fonts can override browser defaults.

## Token use and permissions

The worker reads compact visible browser text/links where possible; uses screenshot/action batches for graphics; and can checkpoint a progress note to replace long tool history. Non-Claude routes retain only recent screenshots per request. Claude keeps the segment append-only to avoid invalidating its explicit cache; the runtime requests a checkpoint after `checkpointSteps` model steps, retaining only `recentScreenshots` in the new segment. It disables server-side conversation chaining so discarded context is actually removed from subsequent requests. Screenshots use original detail in OpenAI Responses and high detail in Chat Completions; other providers receive native image parts. Pixel colors and PNG compression do not themselves lower image-token costs.

For Claude, use an Anthropic Messages provider (`type: anthropic`). Explicit cache markers cover the last tool definition, stable system/skill prompt, previous user turn and latest user turn (at most four). `providers.<provider>.cacheTtl` defaults to 5m; 1h is optional but has a higher write cost and is not automatically enabled. Every step refreshes active cache entries. The task status/logs expose actual cache read/write tokens; do not assume a hit merely because markers were sent. Provider/model-specific minimum lengths still apply (Haiku 5.5: 512; Haiku 4.5: 4096); prompts are not padded to meet thresholds. OpenAI-compatible Claude proxies do not automatically receive Anthropic cache markers and require their own documented cache support. See [Claude caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

Ordinary navigation, public downloads, clicks, and writes inside the PC do not require per-action approval. The worker asks only for essential missing information or consequential actions lacking specific user authorization (payments, external posting, sensitive transmission, destructive valuable-data changes, account/security changes). This is an agent policy, not a classifier that can guarantee every risky click is detected. Webpage content is untrusted and cannot authorize actions. The strongest enforced boundaries are environment isolation, access/ownership, queue serialization, quotas and budgets. CAPTCHA/login barriers are reported, not bypassed. Video inspection uses selected frames; screenshots alone do not provide audio understanding.

## Diagnostics

`wsl -d yunzai-sandbox -u root -e systemctl status llm-desktop` and `journalctl -u llm-desktop` inspect the service. Internal runtime operations are `health`, `screenshot`, `actions`, `browse`, `exec` via `/opt/llm-desktop/client.py` JSON stdin. Do not expose the socket or Chrome debug port externally. Setup updates theme files and restarts the desktop, so run it between tasks.
