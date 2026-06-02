# supernote-mcp

An [MCP](https://modelcontextprotocol.io) server that captures the **live screen mirror** of a
[Ratta Supernote](https://supernote.com) e-ink tablet and returns it as an image to an AI agent.

Sketch or handwrite on your Supernote during a planning/whiteboarding session, then ask your agent
"what did I just draw?" — it pulls the current canvas in as vision input and reasons over it inline.

Beyond the live screen, it can also browse the device's saved files over its **Browse & Access**
Wi-Fi server. Every tool is **lazy** — it touches the device only when invoked, so a session that
never calls one makes no network calls to the tablet.

> [!IMPORTANT]
> **Unofficial, community-built project — not affiliated with, authorised by, or endorsed by
> Ratta / Supernote.** "Supernote" and "Ratta" are trademarks of their respective owner, used here
> only for identification. It relies on **reverse-engineered, undocumented LAN interfaces** (screen
> mirror + Browse & Access) that may change or break with firmware updates. Provided **as-is** under
> the MIT license — use at your own risk.

Built on [`supernote-typescript`](https://github.com/philips/supernote-typescript) for screen
capture and `.note` parsing.

## Prerequisites

- A Supernote that supports **Screen Mirroring** (Manta / Nomad / A5X / A6X-class devices).
- The tablet and the machine running this server on the **same Wi-Fi network**, with
  **no VPN or proxy** active — either will break the LAN mirror connection.
- For the `npx` install path: **Node.js ≥ 18**. For `bunx`: [Bun](https://bun.sh). The standalone
  binary needs neither.

## Enable mirroring and find the IP

1. On the Supernote, open the sidebar and turn on **Screen Mirroring** (a.k.a. "Cast"/"Screencast").
2. A popup shows an address like `192.168.1.42`. That's the device IP. The mirror serves on
   **port 8080** (`http://<ip>:8080/screencast.mjpeg`); the server appends `:8080` for you.
3. Keep mirroring on while you want the agent to be able to snapshot the canvas.

Set the IP once via the `SUPERNOTE_IP` environment variable, or pass it per-call as the tool's
`ip` argument (an explicit argument wins over the env var).

### Browse & Access (for the file tools)

`supernote_list_files` (and the note tools) use a **separate** device feature from screen mirroring:
**Browse & Access**, the built-in Wi-Fi file server on **port 8089**.

1. On the Supernote, **swipe down from the top** of the screen to open the drop-down toolbar and tap
   **Browse & Access**.
2. A popup shows an address like `http://192.168.1.42:8089` and stays open while it's active. The
   device IP is the same as for mirroring; the tools target port 8089 automatically.
3. Keep the popup open while you want the agent to read or upload files.

Browse & Access and Screen Mirroring are independent toggles — enable whichever the task needs (or
both). Discovery probes each port, so the device can be found with only one of them on.

### Coping with a changing IP

The mirror address is a DHCP lease and can change between sessions. Two ways to stay robust:

- **Pin it (recommended):** add a DHCP reservation on your router so the tablet always gets the
  same IP, then `SUPERNOTE_IP` never goes stale.
- **Automatic fallback:** if the configured address is unreachable — or none is set — the server
  **scans the local network** for the mirror, uses the device it finds, and logs the new IP so you
  can update `SUPERNOTE_IP`. The scan only runs as a fallback (never on the fast path) and probes
  port 8080 across your subnet for the mirror's `multipart` stream. Disable it with
  `SUPERNOTE_DISCOVER=0` if you'd rather it fail fast than scan the LAN.

## Install & register with Claude Code

Pick whichever distribution suits you — none require this repo to be checked out.

```bash
# Recommended: published npm package via Node's npx
claude mcp add supernote --scope user --env SUPERNOTE_IP=192.168.1.42 -- npx -y supernote-mcp

# If you already have Bun
claude mcp add supernote --scope user --env SUPERNOTE_IP=192.168.1.42 -- bunx supernote-mcp

# Standalone binary (no runtime needed) — download the asset for your platform from the
# latest GitHub Release (supernote-mcp-darwin-arm64, -darwin-x64, -linux-x64, -linux-arm64,
# -windows-x64.exe), make it executable, then register its path:
chmod +x ./supernote-mcp-darwin-arm64
claude mcp add supernote --scope user --env SUPERNOTE_IP=192.168.1.42 -- /path/to/supernote-mcp-darwin-arm64
```

Restart Claude Code, then try: *"Snapshot my Supernote and tell me what I drew."*

> On macOS the downloaded binary is unsigned; the first run may be blocked by Gatekeeper.
> Right-click → Open once, or run `xattr -d com.apple.quarantine /path/to/supernote-mcp-darwin-arm64`.

## The tools

All tools accept an optional `ip` (device IP, optionally `:port`; defaults to `SUPERNOTE_IP`, else a
LAN scan) and return a clear, actionable message on failure rather than hanging.

| Tool | Needs | Input | Returns |
|------|-------|-------|---------|
| `supernote_snapshot` | Screen Mirroring (8080) | `ip?` | the live screen as `image/png` |
| `supernote_list_files` | Browse & Access (8089) | `ip?`, `path?` | a listing — name, folder?, size, date, and a `path` to pass on |
| `supernote_read_note` | Browse & Access (8089) | `ip?`, `path` | a note's recognized handwriting/text per page (or a note that recognition hasn't run) |

Failures point at the usual causes — wrong IP, the relevant feature turned off, or the host/device
not sharing a VPN-free Wi-Fi network — and time out fast (10s) rather than hanging.

## Local development

Bun is used only to run, typecheck, and build — it is **not** required by end users. This repo ships
an optional [devbox](https://www.jetify.com/devbox) environment that provides Bun reproducibly; you
can equally use a system Bun install.

```bash
bun install

# Capture-first verification against a real device (writes a PNG you can open):
bun run src/capture.ts --ip 192.168.1.42 --out frame.png

# Browse & Access (port 8089) — list a directory, download a file:
bun run src/browse.ts list --ip 192.168.1.42 --path /Note
bun run src/browse.ts get  --ip 192.168.1.42 --path /Note/obsidian/x.note --out x.note

# Run the MCP server over stdio:
bun run src/server.ts

# Inspect the tool interactively:
bunx @modelcontextprotocol/inspector bun run src/server.ts

bun run test           # unit tests (bun:test)
bun run typecheck      # tsc --noEmit
bun run build          # node-compatible bundle -> dist/server.js (the npx/bunx entry)
bun run build:binary   # self-contained executable -> dist/supernote-mcp
```

`bun build --compile` cross-compiles too, e.g.
`bun build --compile --target=bun-linux-x64 src/server.ts --outfile dist/supernote-mcp-linux-x64`.

## How it works

`src/capture.ts` wraps `fetchMirrorFrame(`${ip}:8080`)`, which parses the device's
`multipart/x-mixed-replace` stream, extracts a frame, and decodes it via
[`image-js`](https://github.com/image-js/image-js). The frame is re-encoded to PNG (sidestepping
PNG-vs-JPEG part-encoding differences across firmwares) and returned as base64. `src/browse.ts`
is a client for the Browse & Access HTTP file server (port 8089): it lists directories (parsing the
listing page's embedded JSON) and downloads files. `src/resolve.ts` holds the shared address
resolution + LAN-scan fallback used by both, and `src/discover.ts` does the subnet scan (probing the
mirror or Browse & Access endpoint to recognise the device). `src/server.ts` registers the tools on
an `McpServer` over the stdio transport.

## License

[MIT](./LICENSE)
