import { describe, expect, it } from "vitest"

import {
  BROWSER_TOOL_NAMES,
  browserScreenshotImages,
  browserToolNameFromCall,
  parseBrowserToolView,
} from "./browser-tool"

describe("browser tool parsing", () => {
  it("keeps the frozen 20-tool public surface", () => {
    expect(BROWSER_TOOL_NAMES).toHaveLength(20)
    expect(new Set(BROWSER_TOOL_NAMES).size).toBe(20)
  })

  it("recognizes direct and codeg-browser-prefixed tool calls", () => {
    expect(browserToolNameFromCall("page.screenshot")).toBe("page.screenshot")
    expect(browserToolNameFromCall("mcp__codeg-browser__action.click")).toBe(
      "action.click"
    )
    expect(browserToolNameFromCall("other-browser/page.screenshot")).toBeNull()
  })

  it("recognizes a call_tool wrapper only with a browser server identity", () => {
    expect(
      browserToolNameFromCall(
        "call_tool",
        JSON.stringify({ server: "codeg-browser", name: "tabs.open" })
      )
    ).toBe("tabs.open")
    expect(
      browserToolNameFromCall(
        "call_tool",
        JSON.stringify({ server: "other", name: "tabs.open" })
      )
    ).toBeNull()
  })

  it("unwraps MCP text content and extracts tab, error, and download details", () => {
    const envelope = {
      ok: true,
      action: "download.wait",
      tab: { id: "tab-1", url: "https://example.com", title: "Example" },
      data: {
        download: {
          guid: "d-1",
          state: "completed",
          filename: "report.pdf",
          path: "C:\\controlled\\report.pdf",
          receivedBytes: 10,
          totalBytes: 10,
        },
      },
    }
    const view = parseBrowserToolView({
      toolName: "call_tool",
      input: JSON.stringify({
        serverName: "codeg-browser",
        name: "download.wait",
      }),
      output: JSON.stringify({
        content: [{ type: "text", text: JSON.stringify(envelope) }],
      }),
    })
    expect(view?.tab?.title).toBe("Example")
    expect(view?.downloads[0]?.filename).toBe("report.pdf")
    expect(view?.ok).toBe(true)
  })

  it("summarizes inputs without exposing typed text or URL query values", () => {
    const view = parseBrowserToolView({
      toolName: "action.fill",
      input: JSON.stringify({
        ref: "e4",
        text: "private password",
        url: "https://example.com/login?token=secret",
      }),
    })
    expect(view?.input).toEqual([
      { label: "url", value: "https://example.com/login?…" },
      { label: "ref", value: "e4" },
      { label: "text", value: "<16 characters>" },
    ])
    expect(JSON.stringify(view?.input)).not.toContain("private password")
    expect(JSON.stringify(view?.input)).not.toContain("secret")
  })

  it("accepts only bounded screenshot mime types", () => {
    expect(
      browserScreenshotImages([
        { data: "a", mime_type: "image/png", uri: null },
        { data: "b", mime_type: "image/svg+xml", uri: null },
      ])
    ).toHaveLength(1)
  })
})
