# Desktop resource limits and RustDesk recovery

The isolated `llm-desktop.service` has a finite task budget. Linux cgroups count
each thread as a task, so Chrome tabs, native library worker pools, and RustDesk
all consume it. The limit protects the rest of the WSL VM from runaway programs.
It is separate from the service's 3 GiB memory limit and two-core CPU quota.

The task budget is now 2,048 instead of 768. A single ad-heavy Minesweeper page
was observed with 59 embedded frames; desktop usage peaked at 968 tasks after
restart, already above the old budget. RustDesk's Rayon, Tokio, OpenMP, and
OpenBLAS worker pools are limited to two threads each rather than being sized
for all host CPUs. These settings do not limit every thread used by RustDesk.

`supervisor.py` retries process creation failures, including `EAGAIN`, with a
15-second delay. The desktop checks its RustDesk launcher every two seconds
while idle, so a dead launcher is restarted too. Requests can delay that check
until they finish. Dead RustDesk sessions have their remaining process group
killed before retrying; normal launcher termination also cleans up its session.
The existing file lock prevents concurrent launchers.

`computer-setup` installs the desktop, launcher, and supervisor together. Both
setup commands install the supervisor dependency. Existing desktops must update
`server.py`, `rustdesk-launch.py`, and `supervisor.py` in
`/usr/local/lib/llm-desktop`, persist `TasksMax=2048`, and restart
`llm-desktop.service`. This briefly closes the desktop's open applications;
the persistent home/work disk is retained. No root RustDesk service is used.

Chrome starts with its native sandbox enabled (no `--no-sandbox` flag).
Browser diagnostics are written to `~/.config/llm-desktop/chrome.log`; a file
over 4 MiB is rotated to `chrome.previous.log` on the next browser launch.

Regression tests: `python3 test/desktop-supervisor.test.py -v` on Linux.
