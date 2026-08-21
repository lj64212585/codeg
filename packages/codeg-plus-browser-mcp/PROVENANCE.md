# Browser sidecar source and packaging record

## Source boundary

All files under `src/` and `scripts/` in this package are original Codeg
implementation authored for stage 2. No Cindy or OpenClaw source file is copied
into this package.

Cindy was used only as an architectural and behavioral reference for these
facts:

- keep the Browser runtime independent from the desktop renderer;
- expose progressive MCP discovery through `list_tools` and `call_tool`;
- isolate the managed browser profile from the user's default Chrome profile;
- enforce a 200,000-byte bound on textual tool output;
- own and clean up the complete browser process tree.

The reviewed Cindy reference is Apache-2.0. Its vendored OpenClaw runtime is
MIT and pinned there at commit
`b972feb3f791ed38dafc27c1961dc87f2e30b210`, but none of that generated runtime
is imported here. In particular, Codeg does not carry Cindy's generated
`npx chrome-devtools-mcp@latest` fallback.

## Fixed production dependencies

| Package                     | Version | License | Purpose                                      |
| --------------------------- | ------: | ------- | -------------------------------------------- |
| `@modelcontextprotocol/sdk` |  1.30.0 | MIT     | MCP server and Streamable HTTP transport     |
| `ipaddr.js`                 |   2.5.0 | MIT     | IP range classification for SSRF enforcement |
| `ws`                        |  8.21.3 | MIT     | Chrome DevTools Protocol WebSocket transport |
| `zod`                       |   4.4.3 | MIT     | Strict public tool schemas                   |

## Fixed build-only dependencies

| Package              | Version | License    | Purpose                                                      |
| -------------------- | ------: | ---------- | ------------------------------------------------------------ |
| `esbuild`            |  0.28.2 | MIT        | Produce one deterministic CommonJS sidecar bundle            |
| `@yao-pkg/pkg`       |  6.22.0 | MIT        | Embed the bundle and Node 22 runtime in a Windows executable |
| `@yao-pkg/pkg-fetch` |   3.6.5 | MIT        | Fetch checksum-verified base runtimes for `pkg`              |
| `typescript`         |   5.8.x | Apache-2.0 | Static type checking                                         |

`pnpm-lock.yaml` is the authoritative transitive dependency lock. Release and
local Tauri builds run `src-tauri/scripts/prepare-sidecars.mjs`, which first
builds the bundle and then produces
`codeg-browser-sidecar-<target>.exe`. The installed client never runs npm,
pnpm, npx, or another online installer.

`@yao-pkg/pkg-fetch` 3.6.5 resolves the `node22` targets to Node.js 22.23.2.
Its checked-in expected SHA-256 values for the Windows targets used by Codeg
Plus are:

- `node-v22.23.2-win-x64`:
  `555d3dceaaf1c5628ac8fa23d1ebde46a424d2ad6782cc2412be8eed4a7a6b69`
- `node-v22.23.2-win-arm64`:
  `d625fdb98c359a0b234566ff66d50e802c9f48abad732b46d54014e41d9389db`

The packaged executable therefore has a fixed base-runtime version and an
upstream checksum gate in addition to the workspace lockfile.

Non-Windows Tauri targets receive a non-functional packaged stub so existing
macOS/Linux builds remain valid. Stage 2 runtime support and acceptance are
Windows-only.
