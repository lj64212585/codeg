import { z } from "zod"

export const MAX_TEXT_RESULT_BYTES = 200_000
export const MAX_SCREENSHOT_BYTES = 5_000_000
export const DEFAULT_TOOL_TIMEOUT_MS = 15_000
export const MAX_TOOL_TIMEOUT_MS = 60_000

const empty = z.strictObject({})
const timeoutMs = z.number().int().min(100).max(MAX_TOOL_TIMEOUT_MS).optional()
const tabId = z.string().trim().min(1).max(256)
const ref = z.string().regex(/^e[1-9]\d{0,5}$/)
const url = z.string().trim().min(1).max(8_192)

export type BrowserToolCategory =
  | "runtime"
  | "tabs"
  | "page"
  | "action"
  | "download"

export interface BrowserToolDefinition {
  name: string
  category: BrowserToolCategory
  description: string
  schema: z.ZodType<Record<string, unknown>>
}

export const PUBLIC_TOOLS: readonly BrowserToolDefinition[] = [
  {
    name: "runtime.status",
    category: "runtime",
    description: "Read sidecar, Chrome, profile, session, and recovery state.",
    schema: empty,
  },
  {
    name: "runtime.doctor",
    category: "runtime",
    description:
      "Check browser discovery, directories, CDP, and process health.",
    schema: empty,
  },
  {
    name: "runtime.start",
    category: "runtime",
    description: "Start the managed browser when it is stopped.",
    schema: empty,
  },
  {
    name: "runtime.stop",
    category: "runtime",
    description: "Stop the managed browser and its owned process tree.",
    schema: empty,
  },
  {
    name: "runtime.recover",
    category: "runtime",
    description: "Restart an unhealthy managed browser with bounded retry.",
    schema: empty,
  },
  {
    name: "tabs.list",
    category: "tabs",
    description: "List tabs owned by the current Agent session.",
    schema: empty,
  },
  {
    name: "tabs.open",
    category: "tabs",
    description: "Open a tab owned by the current Agent session.",
    schema: z.strictObject({ url: url.optional() }),
  },
  {
    name: "tabs.focus",
    category: "tabs",
    description: "Focus a tab owned by the current Agent session.",
    schema: z.strictObject({ tabId }),
  },
  {
    name: "tabs.close",
    category: "tabs",
    description: "Close a tab owned by the current Agent session.",
    schema: z.strictObject({ tabId }),
  },
  {
    name: "page.navigate",
    category: "page",
    description: "Navigate the active tab to an allowed HTTP(S) URL.",
    schema: z.strictObject({ url, timeoutMs }),
  },
  {
    name: "page.snapshot",
    category: "page",
    description:
      "Read a bounded semantic accessibility snapshot with stable refs.",
    schema: z.strictObject({
      interactive: z.boolean().optional(),
      limit: z.number().int().min(1).max(1_000).optional(),
      timeoutMs,
    }),
  },
  {
    name: "page.screenshot",
    category: "page",
    description: "Capture the active tab as an MCP image result.",
    schema: z.strictObject({
      format: z.enum(["png", "jpeg"]).optional(),
      fullPage: z.boolean().optional(),
      quality: z.number().int().min(1).max(100).optional(),
      timeoutMs,
    }),
  },
  {
    name: "action.click",
    category: "action",
    description: "Click a semantic ref from the latest snapshot.",
    schema: z.strictObject({ ref, timeoutMs }),
  },
  {
    name: "action.type",
    category: "action",
    description: "Type text at a semantic ref without clearing it first.",
    schema: z.strictObject({
      ref,
      text: z.string().max(100_000),
      timeoutMs,
    }),
  },
  {
    name: "action.fill",
    category: "action",
    description: "Clear a semantic field and insert text.",
    schema: z.strictObject({
      ref,
      text: z.string().max(100_000),
      timeoutMs,
    }),
  },
  {
    name: "action.press",
    category: "action",
    description: "Press a keyboard key in the active tab.",
    schema: z.strictObject({
      key: z.string().trim().min(1).max(64),
      timeoutMs,
    }),
  },
  {
    name: "action.scroll",
    category: "action",
    description: "Scroll the active tab or a semantic ref by pixel deltas.",
    schema: z.strictObject({
      ref: ref.optional(),
      deltaX: z.number().finite().min(-100_000).max(100_000).optional(),
      deltaY: z.number().finite().min(-100_000).max(100_000).optional(),
      timeoutMs,
    }),
  },
  {
    name: "action.wait",
    category: "action",
    description: "Wait for time, visible semantic text, or a URL fragment.",
    schema: z
      .strictObject({
        milliseconds: z
          .number()
          .int()
          .min(0)
          .max(MAX_TOOL_TIMEOUT_MS)
          .optional(),
        text: z.string().min(1).max(4_096).optional(),
        urlIncludes: z.string().min(1).max(4_096).optional(),
        timeoutMs,
      })
      .refine(
        (value) =>
          value.milliseconds !== undefined ||
          value.text !== undefined ||
          value.urlIncludes !== undefined,
        "Provide milliseconds, text, or urlIncludes"
      ),
  },
  {
    name: "download.list",
    category: "download",
    description:
      "List bounded download status and controlled completion paths.",
    schema: empty,
  },
  {
    name: "download.wait",
    category: "download",
    description: "Wait for a selected or latest download to settle.",
    schema: z.strictObject({
      guid: z.string().trim().min(1).max(256).optional(),
      timeoutMs,
    }),
  },
] as const

const TOOL_BY_NAME = new Map(PUBLIC_TOOLS.map((tool) => [tool.name, tool]))

export function browserToolCatalog(category?: BrowserToolCategory) {
  const tools = category
    ? PUBLIC_TOOLS.filter((tool) => tool.category === category)
    : PUBLIC_TOOLS
  return tools.map((tool) => ({
    name: tool.name,
    category: tool.category,
    description: tool.description,
  }))
}

export type ParsedToolArguments =
  | { ok: true; value: Record<string, unknown> }
  | {
      ok: false
      errorCode: "UNKNOWN_TOOL"
      available: string[]
    }
  | {
      ok: false
      errorCode: "INVALID_ARGS"
      issues: z.core.$ZodIssue[]
      schema: unknown
    }

export function parseToolArguments(
  name: string,
  raw: unknown
): ParsedToolArguments {
  const definition = TOOL_BY_NAME.get(name)
  if (!definition) {
    return {
      ok: false,
      errorCode: "UNKNOWN_TOOL",
      available: PUBLIC_TOOLS.map((tool) => tool.name),
    }
  }
  const result = definition.schema.safeParse(raw ?? {})
  if (!result.success) {
    return {
      ok: false,
      errorCode: "INVALID_ARGS",
      issues: result.error.issues,
      schema: z.toJSONSchema(definition.schema),
    }
  }
  return { ok: true, value: result.data }
}

export function toolSchema(name: string): unknown | null {
  const definition = TOOL_BY_NAME.get(name)
  return definition ? z.toJSONSchema(definition.schema) : null
}
