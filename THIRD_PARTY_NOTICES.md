# Third-party notices

Codeg is licensed under Apache-2.0. The stage 2 Browser sidecar additionally
bundles the following MIT-licensed projects at fixed versions:

- `@modelcontextprotocol/sdk` 1.30.0 — Model Context Protocol TypeScript SDK,
  https://github.com/modelcontextprotocol/typescript-sdk
- `ipaddr.js` 2.5.0 — IPv4 and IPv6 address parsing,
  https://github.com/whitequark/ipaddr.js
- `ws` 8.21.3 — WebSocket implementation for Node.js,
  https://github.com/websockets/ws
- `zod` 4.4.3 — TypeScript-first schema validation,
  https://github.com/colinhacks/zod
- Node.js 22.23.2 runtime embedded by the fixed `@yao-pkg/pkg` build tool —
  https://github.com/nodejs/node/blob/v22.23.2/LICENSE

Build-only MIT dependencies used to create the packaged sidecar are:

- `esbuild` 0.28.2 — https://github.com/evanw/esbuild
- `@yao-pkg/pkg` 6.22.0 — https://github.com/yao-pkg/pkg
- `@yao-pkg/pkg-fetch` 3.6.5 — https://github.com/yao-pkg/pkg-fetch

The package itself is Apache-2.0 under the repository `LICENSE`. The following
MIT terms apply to the MIT components listed above (their individual copyright
notices remain attributed to their respective authors and contributors):

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

Node.js includes additional third-party component notices in its fixed-version
license file linked above. `pnpm-lock.yaml` records the complete JavaScript
dependency graph used for the packaged sidecar.
