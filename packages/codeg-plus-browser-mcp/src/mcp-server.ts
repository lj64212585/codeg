import { timingSafeEqual } from "node:crypto"
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http"

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"

import { BrowserRuntime } from "./browser-runtime.js"
import { PUBLIC_TOOLS, toolSchema } from "./contracts.js"
import { BrowserError } from "./errors.js"
import type {
  BrowserSurfaceAction,
  BrowserSurfaceEvent,
} from "./runtime-types.js"

export interface BrowserSidecarServerOptions {
  runtime: BrowserRuntime
  token: string
  host?: "127.0.0.1"
  port?: number
  onControlEvent?: (event: Record<string, unknown>) => void
}

interface McpRequestContext {
  server: Server
  transport: WebStandardStreamableHTTPServerTransport
}

interface AuditEntry {
  at: string
  code: string
}

const MAX_REQUEST_BYTES = 1_000_000
const MAX_AUDIT_ENTRIES = 100
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/

export class BrowserSidecarServer {
  private httpServer: HttpServer | null = null
  private portValue: number | null = null
  private readonly auditEntries: AuditEntry[] = []
  private readonly surfaceStreams = new Set<ServerResponse>()

  constructor(private readonly options: BrowserSidecarServerOptions) {}

  get port(): number | null {
    return this.portValue
  }

  async start(): Promise<number> {
    if (this.portValue !== null) return this.portValue
    const host = this.options.host ?? "127.0.0.1"
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        this.audit("request_internal_error")
        if (!response.headersSent) {
          this.json(response, 500, { error: "internal_error" })
        } else {
          response.end()
        }
      })
    })
    this.httpServer = server
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(this.options.port ?? 0, host, () => {
        server.off("error", reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === "string") {
      await this.stop()
      throw new Error("Loopback server did not publish a TCP port")
    }
    this.portValue = address.port
    this.audit("sidecar_ready")
    return address.port
  }

  async stop(): Promise<void> {
    await this.options.runtime.shutdown()
    for (const response of this.surfaceStreams) response.end()
    this.surfaceStreams.clear()
    const server = this.httpServer
    this.httpServer = null
    this.portValue = null
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    response.setHeader("Cache-Control", "no-store")
    response.setHeader("X-Content-Type-Options", "nosniff")
    if (!this.isLoopbackRequest(request)) {
      this.audit("non_loopback_rejected")
      this.json(response, 403, { error: "forbidden" })
      return
    }
    if (!this.isAuthorized(request)) {
      this.audit("unauthorized")
      response.setHeader("WWW-Authenticate", "Bearer")
      this.json(response, 401, { error: "unauthorized" })
      return
    }

    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1")
    const path = requestUrl.pathname
    if (path === "/health" && request.method === "GET") {
      this.json(response, 200, {
        ok: true,
        sidecar: "ready",
        runtime: this.options.runtime.status(),
      })
      return
    }
    if (path === "/admin/diagnostics" && request.method === "GET") {
      this.json(response, 200, {
        status: this.options.runtime.status(),
        audit: [...this.auditEntries],
      })
      return
    }
    if (path === "/mcp") {
      await this.handleMcp(request, response)
      return
    }
    if (path === "/admin/surface/stream" && request.method === "GET") {
      await this.handleSurfaceStream(requestUrl, request, response)
      return
    }
    if (path.startsWith("/admin/") && request.method === "POST") {
      await this.handleAdmin(path, request, response)
      return
    }
    this.json(response, 404, { error: "not_found" })
  }

  private async handleMcp(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST")
      this.json(response, 405, { error: "method_not_allowed" })
      return
    }
    const sessionId = this.readSessionId(request)
    if (!sessionId) {
      this.audit("mcp_session_rejected")
      this.json(response, 400, { error: "invalid_agent_session" })
      return
    }
    const body = await readJsonBody(request)
    const session = await this.createMcpRequestContext(sessionId)
    const headers = new Headers()
    for (const [name, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) headers.append(name, item)
      } else if (value !== undefined) {
        headers.set(name, value)
      }
    }
    const webRequest = new Request(
      `http://127.0.0.1:${this.portValue ?? 0}${request.url ?? "/mcp"}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }
    )
    try {
      const webResponse = await session.transport.handleRequest(webRequest, {
        parsedBody: body,
      })
      await writeWebResponse(response, webResponse)
    } finally {
      await session.server.close().catch(() => undefined)
    }
  }

  private async handleAdmin(
    path: string,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (path === "/admin/surface/ensure") {
      const sessionId = await this.readAdminSessionId(request, response)
      if (!sessionId) return
      const snapshot = await this.options.runtime.ensureSurface(sessionId)
      this.json(response, 200, snapshot)
      return
    }
    if (path === "/admin/surface/action") {
      const body = await readJsonBody(request)
      const sessionId = readObjectString(body, "sessionId")
      const command = readSurfaceAction(body)
      if (!sessionId || !SESSION_ID_PATTERN.test(sessionId) || !command) {
        this.json(response, 400, { error: "invalid_surface_action" })
        return
      }
      const snapshot = await this.options.runtime.surfaceAction(
        sessionId,
        command
      )
      this.json(response, 200, snapshot)
      return
    }
    if (path === "/admin/release-session") {
      const body = await readJsonBody(request)
      const sessionId = readObjectString(body, "sessionId")
      if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
        this.json(response, 400, { error: "invalid_agent_session" })
        return
      }
      await this.options.runtime.releaseSession(sessionId)
      this.audit("session_released")
      this.json(response, 200, { ok: true })
      return
    }

    const actionByPath: Record<string, string> = {
      "/admin/start": "runtime.start",
      "/admin/stop": "runtime.stop",
      "/admin/recover": "runtime.recover",
      "/admin/doctor": "runtime.doctor",
      "/admin/status": "runtime.status",
    }
    const action = actionByPath[path]
    if (!action) {
      this.json(response, 404, { error: "not_found" })
      return
    }
    await drainBody(request)
    const result = await this.options.runtime.callTool("admin", action, {})
    this.audit(`admin_${action.slice("runtime.".length)}`)
    this.options.onControlEvent?.({
      event: "browser-status",
      status: this.options.runtime.status(),
    })
    this.json(response, result.envelope.ok ? 200 : 409, result.envelope)
  }

  private async readAdminSessionId(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<string | null> {
    const body = await readJsonBody(request)
    const sessionId = readObjectString(body, "sessionId")
    if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
      this.json(response, 400, { error: "invalid_agent_session" })
      return null
    }
    return sessionId
  }

  private async handleSurfaceStream(
    requestUrl: URL,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const sessionId = requestUrl.searchParams.get("sessionId")
    if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
      this.json(response, 400, { error: "invalid_agent_session" })
      return
    }
    response.statusCode = 200
    response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8")
    response.setHeader("Connection", "keep-alive")
    const writer = new BoundedSurfaceWriter(response)
    let detach: (() => Promise<void>) | null = null
    try {
      detach = await this.options.runtime.subscribeSurface(sessionId, (event) =>
        writer.send(event)
      )
    } catch (error) {
      if (
        error instanceof BrowserError &&
        error.code === "SURFACE_ALREADY_ATTACHED"
      ) {
        this.json(response, 409, { error: "surface_already_attached" })
        return
      }
      throw error
    }
    this.surfaceStreams.add(response)
    response.flushHeaders()
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      this.surfaceStreams.delete(response)
      writer.close()
      void detach?.()
    }
    request.once("aborted", close)
    response.once("close", close)
  }

  private async createMcpRequestContext(
    sessionId: string
  ): Promise<McpRequestContext> {
    const server = new Server(
      { name: "codeg-browser", version: "0.1.0" },
      { capabilities: { tools: {} } }
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: PUBLIC_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: toolSchema(tool.name) as Tool["inputSchema"],
      })),
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (!request.params.name.startsWith("runtime.")) {
        this.options.onControlEvent?.({
          event: "browser-session-activity",
          sessionId,
        })
      }
      const output = await this.options.runtime.callTool(
        sessionId,
        request.params.name,
        request.params.arguments
      )
      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [
        {
          type: "text",
          text: JSON.stringify(output.envelope),
        },
      ]
      if (output.image) {
        content.push({
          type: "image",
          data: output.image.data,
          mimeType: output.image.mimeType,
        })
      }
      this.audit(output.envelope.ok ? "tool_succeeded" : "tool_failed")
      return { content, isError: !output.envelope.ok }
    })

    const transport = new WebStandardStreamableHTTPServerTransport({
      // X-Codeg-Browser-Session is the authoritative application session.
      // Keeping a second stateful MCP session here made an explicit Browser
      // resource release invalidate a still-live Agent's transport. Stateless
      // JSON requests also tolerate clients that do not retain MCP initialization
      // state, while Browser tab/download ownership remains scoped above.
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await server.connect(transport)
    return { server, transport }
  }

  private readSessionId(request: IncomingMessage): string | null {
    const value = request.headers["x-codeg-browser-session"]
    const sessionId = Array.isArray(value) ? value[0] : value
    return sessionId && SESSION_ID_PATTERN.test(sessionId) ? sessionId : null
  }

  private isAuthorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization
    if (!header?.startsWith("Bearer ")) return false
    const supplied = Buffer.from(header.slice("Bearer ".length), "utf8")
    const expected = Buffer.from(this.options.token, "utf8")
    return (
      supplied.length === expected.length && timingSafeEqual(supplied, expected)
    )
  }

  private isLoopbackRequest(request: IncomingMessage): boolean {
    const address = request.socket.remoteAddress?.replace(/^::ffff:/, "")
    if (address !== "127.0.0.1" && address !== "::1") return false
    const host = request.headers.host?.toLowerCase()
    if (!host || this.portValue === null) return false
    return (
      host === `127.0.0.1:${this.portValue}` ||
      host === `[::1]:${this.portValue}`
    )
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    const data = JSON.stringify(body)
    response.statusCode = status
    response.setHeader("Content-Type", "application/json; charset=utf-8")
    response.setHeader("Content-Length", Buffer.byteLength(data))
    response.end(data)
  }

  private audit(code: string): void {
    this.auditEntries.push({ at: new Date().toISOString(), code })
    if (this.auditEntries.length > MAX_AUDIT_ENTRIES) this.auditEntries.shift()
  }
}

class BoundedSurfaceWriter {
  private blocked = false
  private closedValue = false
  private readonly pending: BrowserSurfaceEvent[] = []
  private latestFrame: BrowserSurfaceEvent | null = null

  constructor(private readonly response: ServerResponse) {
    response.on("drain", () => this.flush())
  }

  send(event: BrowserSurfaceEvent): void {
    if (this.closedValue) return
    if (this.blocked) {
      if (event.type === "frame") this.latestFrame = event
      else {
        this.pending.push(event)
        if (this.pending.length > 8) this.pending.shift()
      }
      return
    }
    this.write(event)
  }

  close(): void {
    this.closedValue = true
    this.pending.length = 0
    this.latestFrame = null
  }

  private write(event: BrowserSurfaceEvent): void {
    if (!this.response.write(`${JSON.stringify(event)}\n`)) this.blocked = true
  }

  private flush(): void {
    if (this.closedValue) return
    this.blocked = false
    while (!this.blocked && this.pending.length > 0) {
      this.write(this.pending.shift()!)
    }
    if (!this.blocked && this.latestFrame) {
      const frame = this.latestFrame
      this.latestFrame = null
      this.write(frame)
    }
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) {
      throw new Error("request_too_large")
    }
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
}

async function drainBody(request: IncomingMessage): Promise<void> {
  let size = 0
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk)
    if (size > MAX_REQUEST_BYTES) throw new Error("request_too_large")
  }
}

function readObjectString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null
  const result = (value as Record<string, unknown>)[key]
  return typeof result === "string" ? result : null
}

function readSurfaceAction(value: unknown): BrowserSurfaceAction | null {
  if (!value || typeof value !== "object") return null
  const body = value as Record<string, unknown>
  const action = body.action
  if (action === "open") {
    return typeof body.url === "string" ? { action, url: body.url } : { action }
  }
  if (action === "focus" || action === "close") {
    return typeof body.targetId === "string"
      ? { action, targetId: body.targetId }
      : null
  }
  if (action === "navigate") {
    return typeof body.url === "string" ? { action, url: body.url } : null
  }
  if (action === "resize") {
    const width = body.width
    const height = body.height
    return Number.isInteger(width) &&
      Number.isInteger(height) &&
      (width as number) >= 1 &&
      (width as number) <= 4_096 &&
      (height as number) >= 1 &&
      (height as number) <= 4_096
      ? { action, width: width as number, height: height as number }
      : null
  }
  if (
    action === "back" ||
    action === "forward" ||
    action === "reload" ||
    action === "stop"
  ) {
    return { action }
  }
  if (action === "input" && isSurfaceInput(body.input)) {
    return { action, input: body.input }
  }
  return null
}

function isSurfaceInput(
  value: unknown
): value is Extract<BrowserSurfaceAction, { action: "input" }>["input"] {
  if (!value || typeof value !== "object") return false
  const input = value as Record<string, unknown>
  if (input.kind === "text") return typeof input.text === "string"
  if (input.kind === "key") {
    return (
      (input.event === "down" || input.event === "up") &&
      typeof input.key === "string"
    )
  }
  if (input.kind === "mouse") {
    return (
      (input.event === "pressed" ||
        input.event === "released" ||
        input.event === "moved" ||
        input.event === "wheel") &&
      typeof input.x === "number" &&
      typeof input.y === "number"
    )
  }
  return false
}

async function writeWebResponse(
  response: ServerResponse,
  webResponse: Response
): Promise<void> {
  response.statusCode = webResponse.status
  webResponse.headers.forEach((value, name) => response.setHeader(name, value))
  if (!webResponse.body) {
    response.end()
    return
  }
  const body = Buffer.from(await webResponse.arrayBuffer())
  response.setHeader("Content-Length", body.length)
  response.end(body)
}
