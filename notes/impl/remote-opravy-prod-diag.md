# remote-opravy — why commands sometimes do not take effect on prod (diagnosis 2026-11-20)

Author: remote-E. Production 17e22d3 (= main). Read-only on the server.

## Verdict

**The cause is the test environment, not the app logic.** Every SSE connection over HTTPS (HTTP/2
through Cloudflare) in Chromium on THIS host is reset with `net::ERR_NETWORK_CHANGED` about once a
minute. All pages drop in the same millisecond. The app reconnects after 5 s (`_scheduleReconnect`).
A command the controller sends inside that ~5 s gap gets **404 "Device offline"** and is lost. That
is the Space / B9 / B2-404 failure. A press that lands while the drop happens fails the same way.
Runs over the tree are immune: `http://127.0.0.1` is HTTP/1.1, and Chromium does not tear those
connections down on a network change. That is why the tree gave 150/0 three times while prod gave
~145/5 with different checks each time.

Why the host "changes network" every minute: the Docker compose stack `supabase_*_kontexta-resettest`
(network `supabase_network_kontexta-resettest`, bridge `br-fefa94390363`) is in a crash loop.
`docker ps` shows `supabase_storage`, `supabase_realtime`, `supabase_auth` and `supabase_analytics`
each `Restarting (1) …`. Every restart creates a veth on that bridge and assigns it an IPv6
link-local address. Chromium's netlink watcher counts that as an IP address change.

It also points at a real, smaller app gap: **a command sent while the target is reconnecting is
refused with 404, not delivered when the target comes back.** A real phone switching Wi-Fi ↔
mobile data has the same window. The fix proposals are below; nothing is implemented.

## Evidence

### 1. Instrumented suite run on prod (phone): 62 passed / 3 failed
`MS_DIAG=… node tests/e2e/audit/remote.mjs --vp=phone --no-local`

The run wraps `EventSource` in an init script; the app code is unchanged. It records every SSE
event with its arrival time, the target's state 1.5 s after each command, every `/api/remote/state`
body and every `/api/remote/command` request with its response.
- **Every command that was accepted (202) arrived at the target**, within 48–75 ms. Its age at
  arrival was 0 s; the client offset was −0.02 s on all pages, so no age drop happened. It went to
  the one tab that was playing, the connection was the current `store.remoteEventSource`, and the
  target's state changed as expected. This includes all `next` commands: idx 0→1→2, 0→1, 1→2. So
  `_advanceInFlight` / the throttle did not drop anything in this run.
- **The failures are exactly the commands sent during an SSE gap:**
  ```
  01:23:41.570  ERROR e2e-remote-a#2 (controller)  readyState 0
  01:23:41.570  ERROR e2e-remote-b#1 (target)      readyState 0     ← same millisecond
  01:23:42.5    SEND toggle → e2e-remote-b  status 404 (Device offline)   ← Space press: lost
  01:23:46.63   OPEN both again (5 s reconnect)
                FAIL B1 [phone] Space pauses the target / Space again resumes it
  01:24:42.78   target reload (B9): own close, reopened 01:24:43.59
  01:24:44.096  ERROR controller + target, same millisecond
  01:24:49.0    SEND toggle → 404                                        ← lost
  01:24:49.15   OPEN both again
                FAIL B9 [phone] play on the controller plays the reloaded target
  01:25:45.729  ERROR controller + target, same millisecond (no command in the gap this time)
  ```
  Server access log, same seconds: `01:23:42.519 POST /api/remote/command 404 Not Found`, followed
  by `GET /api/remote/token?device_id=e2e-remote-b|a` at 01:23:46.61 and `/events` at 01:23:46.68.
  The drops are ~62 s apart (41.57 → 44.10 → 45.73), regardless of when each connection opened
  (the controller opened 12 s after the target).

### 2. The same drop without the app
- **node (undici, HTTP/1.1)**: 2 connections through Cloudflare and 1 straight to `192.168.1.22:8090`,
  held for 240 s. **0 drops** (`sseprobe.mjs`).
- **Chromium**: plain `EventSource` in 3 contexts. Two go through Cloudflare (`nextHopProtocol`
  h2); one goes over plain http on the LAN.
  ```
  01:33:57.569 pubA error rs=0 — Failed to load resource: net::ERR_NETWORK_CHANGED
  01:33:57.569 pubB error rs=0 — Failed to load resource: net::ERR_NETWORK_CHANGED
  01:37:02.401 pubA/pubB error — net::ERR_NETWORK_CHANGED
  01:38:04.226 pubA/pubB error — net::ERR_NETWORK_CHANGED
  ```
  The LAN (HTTP/1.1) connection never dropped (`sseprobe_browser.mjs`).
- **`ip -ts monitor link address route`** running alongside the browser probe:
  ```
  01:37:01.16  veth85b1108 created on br-fefa94390363 (supabase_network_kontexta-resettest)
  01:37:02.398 15950: veth85b1108 inet6 fe80::8cae:faff:fe99:16f/64 scope link   ← address added
  01:37:02.401 browser: net::ERR_NETWORK_CHANGED                                  ← 3 ms later
  ```
  There were 182 events on that bridge in 200 s. `docker events` shows `supabase_auth`,
  `supabase_analytics`, `supabase_storage` and `supabase_realtime` of `kontexta-resettest` starting
  over and over.

### 3. Other questions from the brief
- **Next during a load (`_advanceInFlight`)**: not seen. Every `next` that arrived moved the index by
  exactly one. Run A's "B12 desktop one Next 0→0" and "B1 tablet swipe 0→0" fit the gap: the command
  was either 404 or killed in flight by `ERR_NETWORK_CHANGED`. Run A/B logs had no instrumentation,
  so for those runs this is an inference.
- **B3 second tab**: `e2e-remote-b#3` opened at 01:25:05.76. **No command was delivered to it**;
  every command went to `#1`. It is closed before the next step. Nothing points at a lingering
  connection taking commands.
- **404 right after a target reload**: the B9 404 came 5 s after the reload. The reload itself had
  already reconnected within 0.8 s. A network-change drop 0.5 s later (01:24:44.096) opened the gap
  that got the 404. Run B's B2 404 fits the same pattern (a gap, not the reload).
- **Stale old-JS `lucas` tab** reconnecting every 5 s with an `aud: stream` token: in the log, and
  unrelated, as you said.

## Classification and proposals

### Test environment (main cause)
- **The fix belongs outside the app**: stop or repair the crash-looping `kontexta-resettest`
  Supabase stack on this host. It is someone else's project; I did not touch it. Afterwards rerun
  `remote.mjs` against prod; the random failures should be gone.
- **Change to the suite (proposed, not done yet):** before each controller action, wait until
  `store.remoteEventSource?.readyState === 1` on BOTH pages and the controller sees the target
  `online`. Record `requestfailed` / console `net::ERR_NETWORK_CHANGED` per page with a timestamp.
  When a check fails and such an event fell inside that step's window, repeat the step once and
  mark the row "retried after a host network change". A failure without a network change stays a
  plain FAIL. The instrumentation (`MS_DIAG=<file.json>`) is already in `remote.mjs`, as observation
  only.

### App (small resilience gap, real on phones too)
A command to a target that is reconnecting is answered 404 and lost. The controller keeps its
remote mode during the 15 s grace (B9), but the press does nothing except show "Device offline".
Minimal options, in order of preference:
1. **Broker: hold, don't refuse** (`app/services/remote.py: send_command`, plus
   `register_listener`; `app/routers/remote.py:368/387` gives 404 today). When the device has no
   connection but reported state within the grace window (`OFFLINE_GRACE`, e.g. 15 s), put the
   command in a per-device pending deque and return it (202). `register_listener` drains that deque
   into the new connection, the way it already moves the same tab's pending commands. The existing
   `COMMAND_MAX_AGE` drop in `listen` keeps anything older than 5 s from playing.
2. **Client: reconnect faster after a connection that worked** (`static/js/remote.js:
   _scheduleReconnect`, line ~168). Use ~0.5–1 s for the first retry after a delivered connection
   drops, and keep the 5 → 60 s backoff for connections that never delivered. This shrinks the gap
   from 5 s to about 1 s; it does not close it.
3. **Controller: retry once.** On 404 while the target is in its grace window, resend the command
   when the target shows `online` again (≤ 5 s), and say "Reconnecting to <device>…" instead of
   "Device offline".

## How to rerun

```
uptime
cd /home/lucas/music-seeker-wt/remote-opravy
flock /home/lucas/music-seeker/notes/impl/.prejimka.lock env MS_DIAG=/tmp/diag.json node tests/e2e/audit/remote.mjs --vp=phone --no-local
# browser-only check of the host (no app): Chromium EventSource via Cloudflare vs LAN, 200 s
node <scratchpad>/sseprobe_browser.mjs 200        # look for net::ERR_NETWORK_CHANGED
docker ps -a --filter network=supabase_network_kontexta-resettest --format '{{.Names}}\t{{.Status}}'
```
The probe scripts are in the remote-E scratchpad (`sseprobe.mjs`, `sseprobe_browser.mjs`,
`diag_an.mjs`) and are not part of the repo. The probes connected as devices
`e2e-probe-1…6` of `claude_test` (states only; no queues, no playlists).
