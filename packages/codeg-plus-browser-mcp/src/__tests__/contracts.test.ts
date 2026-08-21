import { describe, expect, it } from "vitest"

import {
  PUBLIC_TOOLS,
  browserToolCatalog,
  parseToolArguments,
} from "../contracts.js"

describe("Browser MCP public contract", () => {
  it("exposes only the approved stage-2 capabilities", () => {
    expect(PUBLIC_TOOLS.map((tool) => tool.name)).toEqual([
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
    ])

    const names = PUBLIC_TOOLS.map((tool) => tool.name).join(" ")
    expect(names).not.toMatch(/evaluate|upload|saveResource|recipe|siteguide/i)
  })

  it("keeps progressive discovery compact", () => {
    const serialized = JSON.stringify(browserToolCatalog())
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(12_000)
  })

  it("rejects unknown fields instead of silently ignoring them", () => {
    const parsed = parseToolArguments("page.navigate", {
      url: "https://example.com",
      unexpected: true,
    })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok && parsed.errorCode === "INVALID_ARGS") {
      expect(parsed.errorCode).toBe("INVALID_ARGS")
      expect(parsed.schema).toBeTruthy()
    }
  })

  it("reports unknown tool names deterministically", () => {
    const parsed = parseToolArguments("page.evaluate", {})
    expect(parsed).toEqual({
      ok: false,
      errorCode: "UNKNOWN_TOOL",
      available: PUBLIC_TOOLS.map((tool) => tool.name),
    })
  })
})
