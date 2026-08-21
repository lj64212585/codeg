import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { spawn } from "node:child_process"
import { promisify } from "node:util"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const execFileAsync = promisify(execFile)
const DEFAULT_SIDECAR = resolve(
  "src-tauri/binaries/codeg-browser-sidecar-x86_64-pc-windows-msvc.exe"
)
const FORM_URL = "https://www.selenium.dev/selenium/web/web-form.html"
const DOWNLOAD_URL =
  "https://httpbingo.org/response-headers?Content-Disposition=attachment%3B%20filename%3Dcodeg-browser-smoke.txt&Content-Type=text%2Fplain"
const TOKEN = "codeg-browser-smoke-token-" + "x".repeat(32)
const BACKEND = (
  process.argv[3] ??
  process.env.CODEG_BROWSER_SMOKE_BACKEND ??
  "external"
).toLowerCase()

if (process.platform !== "win32") {
  throw new Error("windows_only")
}
assert.ok(
  BACKEND === "external" || BACKEND === "embedded",
  `Invalid Browser backend: ${BACKEND}`
)

const sidecarPath = resolve(process.argv[2] ?? DEFAULT_SIDECAR)
assert.ok(existsSync(sidecarPath), `Browser sidecar not found: ${sidecarPath}`)

const tempRoot = await mkdtemp(join(tmpdir(), "codeg-browser-smoke-"))
const profileDir = join(tempRoot, "profile")
const downloadDir = join(tempRoot, "downloads")
const outputLines = []
const errorLines = []
let child = null
let client = null
let isolationClient = null
let surfaceClient = null
let restoredSurfaceClient = null
const surfaceStreams = []
let runError = null
const checks = []

function record(name, detail = "ok") {
  checks.push({ name, detail })
  process.stdout.write(`${JSON.stringify({ check: name, detail })}\n`)
}

function withTimeout(promise, timeoutMs, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}_timeout`)), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

function waitForJsonLine(lines, predicate, timeoutMs, label) {
  return withTimeout(
    new Promise((resolveLine) => {
      const poll = setInterval(() => {
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line)
            if (predicate(parsed)) {
              clearInterval(poll)
              resolveLine(parsed)
              return
            }
          } catch {
            // The sidecar contract is JSONL; non-JSON stays visible in evidence.
          }
        }
      }, 50)
    }),
    timeoutMs,
    label
  )
}

async function admin(baseUrl, action) {
  const response = await fetch(`${baseUrl}/admin/${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  const body = await response.json()
  if (!response.ok) throw new Error(`${action}:${JSON.stringify(body)}`)
  return body
}

async function surfacePost(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}/admin/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  const value = text ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(`${path}:${response.status}:${text}`)
  }
  return value
}

async function openSurfaceStream(baseUrl, sessionId) {
  const controller = new AbortController()
  const response = await fetch(
    `${baseUrl}/admin/surface/stream?sessionId=${encodeURIComponent(sessionId)}`,
    {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    }
  )
  assert.equal(
    response.status,
    200,
    `surface stream failed: ${response.status}`
  )
  assert.ok(response.body, "surface stream body missing")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  let closed = false

  return {
    async next(predicate, label, timeoutMs = 20_000) {
      return await withTimeout(
        (async () => {
          while (true) {
            const lineEnd = buffered.indexOf("\n")
            if (lineEnd >= 0) {
              const line = buffered.slice(0, lineEnd).trim()
              buffered = buffered.slice(lineEnd + 1)
              if (!line) continue
              const event = JSON.parse(line)
              if (predicate(event)) return event
              continue
            }
            const chunk = await reader.read()
            if (chunk.done) throw new Error(`${label}_stream_closed`)
            buffered += decoder.decode(chunk.value, { stream: true })
          }
        })(),
        timeoutMs,
        label
      )
    },
    async close() {
      if (closed) return
      closed = true
      controller.abort()
      await reader.cancel().catch(() => undefined)
    },
  }
}

function createClient(baseUrl, sessionId) {
  const next = new Client({ name: "codeg-browser-smoke", version: "1" })
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    {
      requestInit: {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "X-Codeg-Browser-Session": sessionId,
        },
      },
    }
  )
  return { client: next, transport }
}

async function call(activeClient, name, args = {}, expectError = false) {
  const result = await activeClient.callTool({ name, arguments: args })
  const text = result.content.find((item) => item.type === "text")?.text
  assert.equal(typeof text, "string", `${name} must return a text envelope`)
  const envelope = JSON.parse(text)
  if (expectError) {
    assert.equal(result.isError, true, `${name} should fail`)
    assert.equal(envelope.ok, false, `${name} should return ok=false`)
  } else {
    assert.notEqual(result.isError, true, `${name} failed: ${text}`)
    assert.equal(envelope.ok, true, `${name} should return ok=true`)
  }
  return { result, envelope }
}

async function waitForRuntime(activeClient, expected, timeoutMs = 15_000) {
  return withTimeout(
    new Promise((resolveState) => {
      const poll = setInterval(async () => {
        try {
          const { envelope } = await call(activeClient, "runtime.status")
          if (envelope.data?.state === expected) {
            clearInterval(poll)
            resolveState(envelope.data)
          }
        } catch {
          // Runtime transitions can briefly race the CDP disconnect.
        }
      }, 200)
    }),
    timeoutMs,
    `runtime_${expected}`
  )
}

async function terminateOwnedProcessTree(pid) {
  assert.ok(Number.isInteger(pid) && pid > 0, "process id must be positive")
  await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"])
}

async function removeTempTree(path) {
  let lastError
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch (error) {
      lastError = error
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
  }
  throw lastError
}

try {
  child = spawn(
    sidecarPath,
    [
      "--profile-dir",
      profileDir,
      "--download-dir",
      downloadDir,
      "--auto-start",
      "false",
      "--backend",
      BACKEND,
    ],
    {
      env: { ...process.env, CODEG_BROWSER_TOKEN: TOKEN },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
  createInterface({ input: child.stdout }).on("line", (line) => {
    outputLines.push(line)
  })
  createInterface({ input: child.stderr }).on("line", (line) => {
    errorLines.push(line)
  })

  const ready = await waitForJsonLine(
    outputLines,
    (line) => line.event === "ready" && Number.isInteger(line.port),
    20_000,
    "sidecar_ready"
  )
  const baseUrl = `http://127.0.0.1:${ready.port}`
  record(
    "sidecar_ready",
    `pid=${ready.pid};version=${ready.version};backend=${BACKEND}`
  )

  const unauthorized = await fetch(`${baseUrl}/health`)
  assert.equal(unauthorized.status, 401)
  record("bearer_required")

  await admin(baseUrl, "start")
  await admin(baseUrl, "start")
  record("runtime_start_idempotent")

  const primary = createClient(baseUrl, "smoke-primary")
  client = primary.client
  await client.connect(primary.transport)
  const catalog = await client.listTools()
  assert.equal(catalog.tools.length, 20)
  assert.ok(catalog.tools.some((tool) => tool.name === "page.screenshot"))
  assert.ok(!catalog.tools.some((tool) => tool.name.includes("evaluate")))
  record("frozen_tool_catalog", `${catalog.tools.length} tools`)

  const surfaceSessionId = "smoke-surface"
  const surfaceConnection = createClient(baseUrl, surfaceSessionId)
  surfaceClient = surfaceConnection.client
  await surfaceClient.connect(surfaceConnection.transport)
  const surfaceOpened = await call(surfaceClient, "tabs.open")
  const surfaceTargetId = surfaceOpened.envelope.tab?.id
  assert.equal(typeof surfaceTargetId, "string")
  await call(surfaceClient, "page.navigate", {
    url: FORM_URL,
    timeoutMs: 20_000,
  })
  await call(surfaceClient, "action.wait", {
    text: "Web form",
    timeoutMs: 20_000,
  })

  const ensured = await surfacePost(baseUrl, "surface/ensure", {
    sessionId: surfaceSessionId,
  })
  const ensuredAgain = await surfacePost(baseUrl, "surface/ensure", {
    sessionId: surfaceSessionId,
  })
  assert.equal(ensured.activeTargetId, surfaceTargetId)
  assert.deepEqual(ensuredAgain, ensured)
  assert.deepEqual(
    ensured.tabs.map((tab) => tab.id),
    [surfaceTargetId]
  )
  record("surface_unique_target")

  const surfaceStream = await openSurfaceStream(baseUrl, surfaceSessionId)
  surfaceStreams.push(surfaceStream)
  const streamedSnapshot = await surfaceStream.next(
    (event) => event.type === "snapshot",
    "surface_snapshot"
  )
  assert.equal(streamedSnapshot.snapshot.activeTargetId, surfaceTargetId)
  assert.deepEqual(streamedSnapshot.snapshot.tabs, ensured.tabs)
  const streamedFrame = await surfaceStream.next(
    (event) => event.type === "frame",
    "surface_frame"
  )
  assert.equal(streamedFrame.frame.targetId, surfaceTargetId)
  assert.equal(streamedFrame.frame.mimeType, "image/jpeg")
  assert.ok(streamedFrame.frame.data.length > 1_000)
  assert.ok(streamedFrame.frame.deviceWidth > 0)
  assert.ok(streamedFrame.frame.deviceHeight > 0)
  record("surface_same_target_frame")

  const duplicateStream = await fetch(
    `${baseUrl}/admin/surface/stream?sessionId=${surfaceSessionId}`,
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  )
  assert.equal(duplicateStream.status, 409)
  await duplicateStream.body?.cancel()
  record("surface_single_subscriber")

  const surfaceSemantic = await call(surfaceClient, "page.snapshot", {
    interactive: true,
    limit: 500,
  })
  const surfaceTextBox = surfaceSemantic.envelope.data?.nodes?.find(
    (node) =>
      typeof node.ref === "string" &&
      /textbox/i.test(node.role ?? "") &&
      /text input/i.test(node.name ?? "")
  )
  assert.ok(surfaceTextBox?.ref, "surface semantic text input ref not found")
  await call(surfaceClient, "action.click", { ref: surfaceTextBox.ref })
  await surfacePost(baseUrl, "surface/action", {
    sessionId: surfaceSessionId,
    action: "input",
    input: { kind: "text", text: "Codeg Surface Input" },
  })
  const afterSurfaceInput = await call(surfaceClient, "page.snapshot", {
    interactive: true,
    limit: 500,
  })
  const updatedTextBox = afterSurfaceInput.envelope.data?.nodes?.find(
    (node) => node.ref === surfaceTextBox.ref
  )
  assert.match(updatedTextBox?.value ?? "", /Codeg Surface Input/)
  record("surface_input_same_target")

  const twoTargets = await surfacePost(baseUrl, "surface/action", {
    sessionId: surfaceSessionId,
    action: "open",
  })
  assert.equal(twoTargets.tabs.length, 2)
  const agentTargetIds = (
    await call(surfaceClient, "tabs.list")
  ).envelope.data.tabs.map((tab) => tab.id)
  assert.deepEqual(
    [...agentTargetIds].sort(),
    twoTargets.tabs.map((tab) => tab.id).sort()
  )
  record("surface_full_target_snapshot")

  await surfaceStream.close()
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
  const afterHide = await surfacePost(baseUrl, "surface/ensure", {
    sessionId: surfaceSessionId,
  })
  assert.equal(afterHide.tabs.length, 2)
  const reopenedStream = await openSurfaceStream(baseUrl, surfaceSessionId)
  surfaceStreams.push(reopenedStream)
  const reopenedSnapshot = await reopenedStream.next(
    (event) => event.type === "snapshot",
    "surface_reopen"
  )
  assert.equal(reopenedSnapshot.snapshot.tabs.length, 2)
  await reopenedStream.close()
  record("surface_hide_reopen_reuses_targets")

  await surfacePost(baseUrl, "release-session", {
    sessionId: surfaceSessionId,
  })
  await surfaceClient.close().catch(() => undefined)
  surfaceClient = null
  const restoredConnection = createClient(baseUrl, surfaceSessionId)
  restoredSurfaceClient = restoredConnection.client
  await restoredSurfaceClient.connect(restoredConnection.transport)
  const restoredTab = await call(restoredSurfaceClient, "tabs.open")
  const restored = await surfacePost(baseUrl, "surface/ensure", {
    sessionId: surfaceSessionId,
  })
  assert.equal(restored.tabs.length, 1)
  assert.equal(restored.activeTargetId, restoredTab.envelope.tab?.id)
  record("surface_explicit_close_then_agent_restore")

  const opened = await call(client, "tabs.open")
  const tabId = opened.envelope.tab?.id
  assert.equal(typeof tabId, "string")
  await call(client, "page.navigate", { url: FORM_URL, timeoutMs: 20_000 })
  await call(client, "action.wait", {
    text: "Web form",
    timeoutMs: 20_000,
  })
  const snapshot = await call(client, "page.snapshot", {
    interactive: true,
    limit: 500,
  })
  assert.match(snapshot.envelope.tab?.url ?? "", /selenium\.dev/)
  assert.ok(
    snapshot.envelope.tab?.title || snapshot.envelope.data?.title,
    `page title missing: ${JSON.stringify(snapshot.envelope)}`
  )
  const nodes = snapshot.envelope.data?.nodes
  assert.ok(Array.isArray(nodes) && nodes.length > 0)
  const textBox = nodes.find(
    (node) =>
      typeof node.ref === "string" &&
      /textbox/i.test(node.role ?? "") &&
      /text input/i.test(node.name ?? "")
  )
  const submit = nodes.find(
    (node) =>
      typeof node.ref === "string" &&
      /button/i.test(node.role ?? "") &&
      /submit/i.test(node.name ?? "")
  )
  assert.ok(textBox?.ref, "semantic text input ref not found")
  assert.ok(submit?.ref, "semantic submit button ref not found")
  record("semantic_snapshot", `${nodes.length} nodes`)

  await call(client, "action.fill", {
    ref: textBox.ref,
    text: "Codeg Browser MCP",
  })
  await call(client, "action.type", { ref: textBox.ref, text: " smoke" })
  await call(client, "action.press", { key: "Tab" })
  await call(client, "action.scroll", { deltaY: 240 })
  await call(client, "action.wait", { milliseconds: 100 })
  await call(client, "action.click", { ref: submit.ref })
  await call(client, "action.wait", {
    urlIncludes: "submitted-form.html",
    timeoutMs: 20_000,
  })
  record("semantic_actions")

  const screenshot = await call(client, "page.screenshot", {
    format: "png",
    fullPage: false,
  })
  const screenshotImage = screenshot.result.content.find(
    (item) => item.type === "image"
  )
  assert.ok(screenshotImage?.data)
  assert.equal(screenshotImage.mimeType, "image/png")
  assert.ok(Buffer.byteLength(screenshotImage.data, "base64") <= 5_000_000)
  record("screenshot_media", `${screenshotImage.data.length} base64 chars`)

  const second = createClient(baseUrl, "smoke-isolated")
  isolationClient = second.client
  await isolationClient.connect(second.transport)
  const isolatedTabs = await call(isolationClient, "tabs.list")
  assert.deepEqual(isolatedTabs.envelope.data?.tabs, [])
  record("session_isolation")

  const listed = await call(client, "tabs.list")
  assert.ok(listed.envelope.data.tabs.some((tab) => tab.id === tabId))
  await call(client, "tabs.focus", { tabId })
  await call(client, "tabs.close", { tabId })
  record("tab_lifecycle")

  const ssrf = await call(
    client,
    "tabs.open",
    { url: "http://127.0.0.1:1/private" },
    true
  )
  assert.equal(ssrf.envelope.error?.code, "SSRF_BLOCKED")
  record("ssrf_blocked")

  const running = await call(client, "runtime.status")
  const browserPid = running.envelope.data?.browserPid
  await terminateOwnedProcessTree(browserPid)
  await waitForRuntime(client, "error")
  await call(client, "runtime.recover")
  await waitForRuntime(client, "ready", 25_000)
  record("browser_crash_recovery")

  await call(client, "tabs.open")
  const downloadNavigation = await client.callTool({
    name: "page.navigate",
    arguments: { url: DOWNLOAD_URL, timeoutMs: 5_000 },
  })
  const downloadNavigationText = downloadNavigation.content.find(
    (item) => item.type === "text"
  )?.text
  assert.equal(typeof downloadNavigationText, "string")
  const downloaded = await call(client, "download.wait", { timeoutMs: 20_000 })
  const download = downloaded.envelope.data?.download
  assert.equal(download?.state, "completed")
  assert.ok(download?.path)
  assert.ok(resolve(download.path).startsWith(`${resolve(downloadDir)}\\`))
  assert.ok(existsSync(download.path))
  record("controlled_download", download.filename)

  await call(client, "runtime.stop")
  await waitForRuntime(client, "stopped")
  record("runtime_stop")

  const combinedLogs = [...outputLines, ...errorLines].join("\n")
  assert.ok(!combinedLogs.includes(TOKEN))
  assert.ok(!combinedLogs.includes(FORM_URL))
  assert.ok(!/cookie/i.test(combinedLogs))
  record("logs_redacted")
} catch (error) {
  runError = error
} finally {
  for (const stream of surfaceStreams) {
    await stream.close().catch(() => undefined)
  }
  await restoredSurfaceClient?.close().catch(() => undefined)
  await surfaceClient?.close().catch(() => undefined)
  await isolationClient?.close().catch(() => undefined)
  await client?.close().catch(() => undefined)
  if (child && child.exitCode === null) {
    child.kill("SIGTERM")
    await withTimeout(
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      8_000,
      "sidecar_exit"
    ).catch(async () => {
      await terminateOwnedProcessTree(child.pid).catch(() => undefined)
    })
  }
  const resolvedTemp = resolve(tempRoot)
  const resolvedSystemTemp = resolve(tmpdir())
  if (resolvedTemp.startsWith(`${resolvedSystemTemp}\\codeg-browser-smoke-`)) {
    await removeTempTree(resolvedTemp).catch((error) => {
      errorLines.push(`cleanup_failed:${String(error)}`)
    })
  }
}

if (runError) throw runError

process.stdout.write(`${JSON.stringify({ ok: true, checks })}\n`)
