import type { ImageData } from "@/lib/types"

export const BROWSER_TOOL_NAMES = [
  "runtime.status",
  "runtime.doctor",
  "runtime.start",
  "runtime.stop",
  "runtime.recover",
  "tabs.list",
  "tabs.open",
  "tabs.focus",
  "tabs.close",
  "page.navigate",
  "page.snapshot",
  "page.screenshot",
  "action.click",
  "action.type",
  "action.fill",
  "action.press",
  "action.scroll",
  "action.wait",
  "download.list",
  "download.wait",
] as const

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number]

const BROWSER_TOOL_SET = new Set<string>(BROWSER_TOOL_NAMES)

interface BrowserTabView {
  id: string
  url: string
  title: string
}

export interface BrowserDownloadView {
  guid: string | null
  state: string | null
  filename: string | null
  path: string | null
  receivedBytes: number | null
  totalBytes: number | null
  errorCode: string | null
}

export interface BrowserToolView {
  name: BrowserToolName
  input: Array<{ label: string; value: string }>
  ok: boolean | null
  tab: BrowserTabView | null
  error: {
    code: string | null
    message: string | null
    recovery: string | null
    retryable: boolean | null
  } | null
  downloads: BrowserDownloadView[]
  output: unknown
}

const SAFE_INPUT_KEYS = [
  "tabId",
  "tab_id",
  "ref",
  "key",
  "format",
  "fullPage",
  "full_page",
  "quality",
  "interactive",
  "limit",
  "deltaX",
  "delta_x",
  "deltaY",
  "delta_y",
  "milliseconds",
  "timeoutMs",
  "timeout_ms",
  "guid",
  "urlIncludes",
  "url_includes",
] as const

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function stringField(
  object: Record<string, unknown> | null,
  ...keys: string[]
): string | null {
  if (!object) return null
  for (const key of keys) {
    const value = object[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

function numberField(
  object: Record<string, unknown> | null,
  ...keys: string[]
): number | null {
  if (!object) return null
  for (const key of keys) {
    const value = object[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return null
}

function boolField(
  object: Record<string, unknown> | null,
  ...keys: string[]
): boolean | null {
  if (!object) return null
  for (const key of keys) {
    const value = object[key]
    if (typeof value === "boolean") return value
  }
  return null
}

function directToolName(value: string | null): BrowserToolName | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return BROWSER_TOOL_SET.has(normalized)
    ? (normalized as BrowserToolName)
    : null
}

function prefixedToolName(value: string): BrowserToolName | null {
  const normalized = value.trim().toLowerCase()
  if (!/(?:codeg[-_ ]?browser|browser[-_ ]?mcp)/.test(normalized)) {
    return null
  }
  return BROWSER_TOOL_NAMES.find((name) => normalized.endsWith(name)) ?? null
}

function findNamedValue(
  value: unknown,
  keys: Set<string>,
  depth = 0
): string | null {
  if (depth > 4) return null
  const object = asObject(value)
  if (!object) return null
  for (const [key, candidate] of Object.entries(object)) {
    if (keys.has(key.toLowerCase()) && typeof candidate === "string") {
      return candidate
    }
  }
  for (const nested of Object.values(object)) {
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const found = findNamedValue(item, keys, depth + 1)
        if (found) return found
      }
    } else {
      const found = findNamedValue(nested, keys, depth + 1)
      if (found) return found
    }
  }
  return null
}

function unwrapOutput(value: unknown, depth = 0): unknown {
  if (depth > 5) return value
  if (typeof value === "string") {
    const parsed = parseJson(value)
    return parsed === null ? value : unwrapOutput(parsed, depth + 1)
  }
  const object = asObject(value)
  if (!object) return value
  if (typeof object.action === "string" && typeof object.ok === "boolean") {
    return object
  }
  const content = object.content
  if (Array.isArray(content)) {
    for (const item of content) {
      const itemObject = asObject(item)
      if (itemObject?.type === "text" && typeof itemObject.text === "string") {
        const unwrapped = unwrapOutput(itemObject.text, depth + 1)
        const unwrappedObject = asObject(unwrapped)
        if (unwrappedObject?.action || unwrappedObject?.ok !== undefined) {
          return unwrapped
        }
      }
    }
  }
  for (const key of ["result", "output", "data"]) {
    if (key in object) {
      const unwrapped = unwrapOutput(object[key], depth + 1)
      const unwrappedObject = asObject(unwrapped)
      if (unwrappedObject?.action || unwrappedObject?.ok !== undefined) {
        return unwrapped
      }
    }
  }
  return object
}

function toolArguments(value: unknown): Record<string, unknown> | null {
  const object = asObject(value)
  if (!object) return null
  for (const key of ["arguments", "args", "params", "input"]) {
    const nested = object[key]
    const parsed =
      typeof nested === "string"
        ? asObject(parseJson(nested))
        : asObject(nested)
    if (parsed) return parsed
  }
  return object
}

function safeUrlLabel(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}${url.search ? "?…" : ""}`
  } catch {
    return "<invalid URL>"
  }
}

function summarizeInput(
  value: unknown
): Array<{ label: string; value: string }> {
  const args = toolArguments(value)
  if (!args) return []
  const summary: Array<{ label: string; value: string }> = []
  if (typeof args.url === "string") {
    summary.push({ label: "url", value: safeUrlLabel(args.url) })
  }
  for (const key of SAFE_INPUT_KEYS) {
    const candidate = args[key]
    if (
      typeof candidate === "string" ||
      typeof candidate === "number" ||
      typeof candidate === "boolean"
    ) {
      summary.push({ label: key, value: String(candidate) })
    }
  }
  if (typeof args.text === "string") {
    summary.push({ label: "text", value: `<${args.text.length} characters>` })
  }
  return summary
}

export function browserToolNameFromCall(
  toolName: string,
  input?: string | null,
  output?: string | null
): BrowserToolName | null {
  const exact = directToolName(toolName)
  if (exact) return exact
  const prefixed = prefixedToolName(toolName)
  if (prefixed) return prefixed

  const parsedInput = parseJson(input)
  const parsedOutput = unwrapOutput(parseJson(output) ?? output)
  const outputAction = directToolName(
    stringField(asObject(parsedOutput), "action")
  )
  if (outputAction) return outputAction

  const server = findNamedValue(
    parsedInput,
    new Set(["server", "servername", "server_name", "mcpserver", "mcp_server"])
  )
  if (!server || !/(?:codeg[-_ ]?browser|browser[-_ ]?mcp)/i.test(server)) {
    return null
  }
  return directToolName(
    findNamedValue(
      parsedInput,
      new Set(["name", "tool", "toolname", "tool_name"])
    )
  )
}

function parseTab(value: unknown): BrowserTabView | null {
  const object = asObject(value)
  const id = stringField(object, "id", "tabId", "tab_id")
  const url = stringField(object, "url")
  const title = stringField(object, "title")
  if (!id && !url && !title) return null
  return { id: id ?? "", url: url ?? "", title: title ?? "" }
}

function parseDownload(value: unknown): BrowserDownloadView | null {
  const object = asObject(value)
  if (!object) return null
  const filename = stringField(object, "filename")
  const guid = stringField(object, "guid")
  if (!filename && !guid) return null
  return {
    guid,
    state: stringField(object, "state"),
    filename,
    path: stringField(object, "path"),
    receivedBytes: numberField(object, "receivedBytes", "received_bytes"),
    totalBytes: numberField(object, "totalBytes", "total_bytes"),
    errorCode: stringField(object, "errorCode", "error_code"),
  }
}

function collectDownloads(value: unknown): BrowserDownloadView[] {
  const object = asObject(value)
  if (!object) return []
  const data = asObject(object.data)
  const candidates = data?.downloads ?? data?.download
  if (Array.isArray(candidates)) {
    return candidates
      .map(parseDownload)
      .filter((item): item is BrowserDownloadView => item !== null)
  }
  const single = parseDownload(candidates)
  return single ? [single] : []
}

export function parseBrowserToolView(params: {
  toolName: string
  input?: string | null
  output?: string | null
  errorText?: string | null
}): BrowserToolView | null {
  const source = params.output ?? params.errorText ?? null
  const name = browserToolNameFromCall(params.toolName, params.input, source)
  if (!name) return null

  const output = unwrapOutput(parseJson(source) ?? source)
  const envelope = asObject(output)
  const error = asObject(envelope?.error)
  return {
    name,
    input: summarizeInput(parseJson(params.input)),
    ok: boolField(envelope, "ok"),
    tab: parseTab(envelope?.tab),
    error: error
      ? {
          code: stringField(error, "code"),
          message: stringField(error, "message"),
          recovery: stringField(error, "recovery"),
          retryable: boolField(error, "retryable"),
        }
      : null,
    downloads: collectDownloads(output),
    output,
  }
}

export function browserScreenshotImages(
  images: ImageData[] | null | undefined
): ImageData[] {
  return (images ?? []).filter(
    (image) =>
      Boolean(image.data) && /^image\/(?:png|jpeg)$/.test(image.mime_type)
  )
}
