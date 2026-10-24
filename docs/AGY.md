# Async agent (AGY)

`agy` handles general analysis, coding, file processing and other sustained tasks. It has access to current/quoted context images and its retained session workspace. It runs the host's private Antigravity CLI with `gemini-3.8-flash-medium`, medium effort and `--sandbox`. It acknowledges the user first, executes asynchronously, then returns a filtered report to the original conversation model/persona. The tool description explicitly identifies this as an AI agent for the main model. The user-facing final reply describes the work in first person. No conversation history, provider credentials or host environment variables are forwarded to the worker. Current and quoted image bytes are snapshotted automatically, using the same image-selection contract as `computer_task`.

## Setup

Requires Windows, the existing `yunzai-llm-sandbox` computer-use distro, and the host's Antigravity sign-in. Run `npm run agy-setup` in the plugin directory. This prepares a private CLI copy (official manifest with SHA-512 verification if absent), a private CLI profile, the shared attachment mount, a separate VM user/firewall and the root-owned command broker. It briefly restarts the existing desktop service. It creates no additional VM and does not change the normal Antigravity profile or permissions. The bot's profile lives under `data/agy-setup/profile` and has its own history and MCP configuration. CLI jobs are serialized so profile settings cannot race. Each chatbot session owns a separate AGY conversation and workspace. Its first task creates a new project; follow-up tasks resume its recorded CLI conversation ID. Clearing or expiring the chatbot session discards this mapping and starts fresh. A late response from the old session cannot replace the new mapping. The CLI installation profile is shared infrastructure; conversations and workspaces remain separate.

Configure `tools.agy.enable`, `access` (`admin` or `all`), `distro`, optional `executable`, `maxMinutes` (1–30), and `maxQueue` (1–50). Model and thinking level cannot be selected through model-supplied arguments. Defaults are disabled and admin-only. `node cli/agy-verify.mjs` performs a live model/browser boundary test; it consumes the host's normal Antigravity allowance.

## Files and permissions

The same physical folder has three views:

| Consumer | Path |
| --- | --- |
| Host native file/image tools | `data/shared-attachments/<session-workspace>/` |
| Existing computer-use desktop | `/work/attachments/<session-workspace>/` |
| Command/browser sandbox | `/work/` |

Only this attachment tree is mounted from Windows. WSL host-drive automount and Windows interop remain disabled. Existing attachment files are copied into the shared tree on first setup; the previous ext4 files remain underneath the mount. The normal computer-use image import and paths continue to work.

Antigravity's native file/image tools are enabled in the job project. Explicit deny rules cover existing host files outside that folder and other WSL paths. Unconfigured outside paths require approval and fail in headless mode. `--dangerously-skip-permissions` is never used. The `proceed-in-sandbox` preset automatically approves allowed workspace operations and the scoped MCP tools; it does not approve host execution or outside-folder access. These are bot-profile settings, not global user settings.

All native host execution is denied. `agy-sandbox/exec` routes commands through the existing VM into a fresh Bubblewrap namespace: UID 2002, only the job folder writable/persistent, clean environment, temporary home, no desktop home/control socket/bot files/other jobs/host drives. Static system libraries, fonts, certificates, Chrome and Playwright are read-only. Commands are bounded to 55 seconds, 2 GiB and 256 processes. Public network access is available; the separate UID's firewall rejects private/loopback addresses, IPv6 and mail ports (DNS is explicitly allowed). The broker refuses work when that firewall service is inactive. The native terminal sandbox flag alone is insufficient for this boundary; it was tested and permitted outside-folder shell reads.

The native image reader can view original attachments. The fallback scoped MCP image reader also returns multimodal image content. File copying adds no image tokens; viewing through either reader consumes image tokens. General command/browser instructions stay in the worker prompt.

Google Lens is a separate main-chatbot skill and `google_lens` tool; see [Google Lens](GOOGLE-LENS.md). The AGY MCP exposes only `exec` and `read_image`, and contains no Lens workflow.

## Privacy and delivery

Worker input, persisted reports, main-model input and final text pass through redaction of configured/environment credentials, host identity, private paths/addresses, emails, private numbers and sensitive URL parameters. Worker stderr is filtered into debug logs and never forwarded to task history or chat. Main-model result turns have no tools or image outputs, preventing raw reports or generated screenshots from bypassing final filtering. Failed summarization never falls back to raw worker output. This is a defense in depth filter, not a guarantee that arbitrary personal details in natural language can always be recognized; the worker is also instructed to omit them and receives only the minimum task context.

Debug lines use the `[AGY <job>]` prefix and include model/effort, visible responses, tool inputs/results, final reports, delivery status, filtered CLI diagnostics and exit status. They follow the plugin's existing debug logging controls (`YZ_LLM_DEBUG=1` also shows them at info level and in the web log console). Diagnostic lines are buffered before filtering so secrets split across pipe chunks are redacted together. Sign-in URLs, private-key blocks, binary payloads and provider-native reasoning are omitted.

Jobs are owned by bot/user/group, have bounded queues, support status/cancel/respond, and do not replay after restart. Result completion holds the original conversation lock. No long-lived VM keepalive is added.

## Web panel

Open **系统管理 → 异步代理（AGY）** (`#/agy`) to view queued/running/completed tasks, live progress, model/usage details, results, delivery status and the execution timeline. The page refreshes every three seconds and can cancel queued/running/waiting tasks. Tasks are started or continued from the chat so the original context and reply destination remain attached.

The authenticated `/api/agy`, `/api/agy/:id/history` and `/api/agy/:id/cancel` routes use the panel's normal login and CSRF protection. They expose filtered summaries without raw owner identities, input bytes, host paths or CLI stderr. Visible responses and tool calls are filtered before persistence under `data/agy-history/<job>/history.json`, with an additional filter on read. Records are bounded to 500 events / 2 MiB per task and pruned with the queue's retained jobs. Provider-native reasoning is never recorded. Final chat replies record successful/failed delivery separately from the worker report. Older tasks retain their summaries; detailed history starts with new execution or continuation after this update.
