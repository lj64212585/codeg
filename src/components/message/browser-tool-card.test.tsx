import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/ui/image-preview-dialog", () => ({
  ImagePreviewDialog: () => null,
}))

import { ContentPartsRenderer } from "./content-parts-renderer"
import enMessages from "@/i18n/messages/en.json"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"

function renderPart(part: AdaptedContentPart) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContentPartsRenderer parts={[part]} role="assistant" />
    </NextIntlClientProvider>
  )
}

describe("Browser tool card", () => {
  it("shows URL, title, tab, and screenshot media without dumping base64", () => {
    renderPart({
      type: "tool-call",
      toolCallId: "browser-shot",
      toolName: "page.screenshot",
      input: JSON.stringify({ format: "png" }),
      state: "output-available",
      output: JSON.stringify({
        ok: true,
        action: "page.screenshot",
        tab: {
          id: "tab-1",
          url: "https://example.com/page",
          title: "Example page",
        },
        data: { captured: true },
      }),
      images: [{ data: "QUJD", mime_type: "image/png" }],
    })

    expect(screen.getByText("Browser · page.screenshot")).toBeInTheDocument()
    expect(screen.getByText("Example page")).toBeInTheDocument()
    expect(screen.getByText("https://example.com/page")).toBeInTheDocument()
    expect(screen.getByText("Tab tab-1")).toBeInTheDocument()
    expect(screen.getByAltText("Browser screenshot 1")).toHaveAttribute(
      "src",
      "data:image/png;base64,QUJD"
    )
    expect(document.body.textContent).not.toContain("QUJD")
  })

  it("shows download location and actionable recovery errors", () => {
    const { rerender } = renderPart({
      type: "tool-call",
      toolCallId: "download",
      toolName: "download.wait",
      input: "{}",
      state: "output-available",
      output: JSON.stringify({
        ok: true,
        action: "download.wait",
        data: {
          download: {
            guid: "d-1",
            state: "completed",
            filename: "report.pdf",
            path: "C:\\Codeg\\browser\\downloads\\report.pdf",
          },
        },
      }),
    })

    expect(screen.getByText("report.pdf")).toBeInTheDocument()
    expect(
      screen.getByText("C:\\Codeg\\browser\\downloads\\report.pdf")
    ).toBeInTheDocument()

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ContentPartsRenderer
          role="assistant"
          parts={[
            {
              type: "tool-call",
              toolCallId: "failed",
              toolName: "page.navigate",
              input: JSON.stringify({ url: "http://127.0.0.1" }),
              state: "output-error",
              errorText: JSON.stringify({
                ok: false,
                action: "page.navigate",
                error: {
                  code: "SSRF_BLOCKED",
                  message: "Private network targets are blocked",
                  retryable: false,
                  recovery: "check_settings",
                },
              }),
            },
          ]}
        />
      </NextIntlClientProvider>
    )

    expect(screen.getByRole("alert")).toHaveTextContent("SSRF_BLOCKED")
    expect(screen.getByRole("alert")).toHaveTextContent("check_settings")
  })
})
