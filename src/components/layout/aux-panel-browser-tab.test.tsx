import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const surface = vi.hoisted(() => ({
  attachBrowserSurface: vi.fn(),
  detachBrowserSurface: vi.fn(),
  closeBrowserSurface: vi.fn(),
  runBrowserSurfaceAction: vi.fn(),
}))
const connection = vi.hoisted(() => ({ connectionId: "connection-a" }))

vi.mock("@/lib/browser-surface", () => surface)
vi.mock("@/contexts/tab-context", () => ({
  useTabStore: (selector: (state: { activeTabId: string }) => unknown) =>
    selector({ activeTabId: "tab-a" }),
}))
vi.mock("@/hooks/use-connection", () => ({
  useConnection: () => connection,
}))
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { AuxPanelBrowserTab, browserFramePoint } from "./aux-panel-browser-tab"
import type {
  BrowserSurfaceEvent,
  BrowserSurfaceSnapshot,
} from "@/lib/browser-surface"

const snapshot: BrowserSurfaceSnapshot = {
  sessionId: "connection-a",
  tabs: [
    { id: "t1", title: "One", url: "https://one.example/" },
    { id: "t2", title: "Two", url: "https://two.example/" },
  ],
  activeTargetId: "t1",
  active: {
    tab: { id: "t1", title: "One", url: "https://one.example/" },
    loading: false,
    canGoBack: true,
    canGoForward: false,
  },
}

describe("AuxPanelBrowserTab", () => {
  let emit: ((event: BrowserSurfaceEvent) => void) | null

  beforeEach(() => {
    vi.clearAllMocks()
    emit = null
    connection.connectionId = "connection-a"
    surface.attachBrowserSurface.mockImplementation(
      async (
        _connectionId: string,
        listener: (event: BrowserSurfaceEvent) => void
      ) => {
        emit = listener
        return snapshot
      }
    )
    surface.detachBrowserSurface.mockResolvedValue(undefined)
    surface.closeBrowserSurface.mockResolvedValue(undefined)
    surface.runBrowserSurfaceAction.mockResolvedValue(snapshot)
  })

  it("attaches once to the real connection and renders every live target", async () => {
    const { rerender } = render(
      <AuxPanelBrowserTab visible onExplicitClose={() => undefined} />
    )

    expect(await screen.findByText("One")).toBeInTheDocument()
    expect(screen.getByText("Two")).toBeInTheDocument()
    expect(surface.attachBrowserSurface).toHaveBeenCalledTimes(1)
    expect(surface.attachBrowserSurface).toHaveBeenCalledWith(
      "connection-a",
      expect.any(Function)
    )

    rerender(<AuxPanelBrowserTab visible onExplicitClose={() => undefined} />)
    expect(surface.attachBrowserSurface).toHaveBeenCalledTimes(1)
  })

  it("focuses inner targets and navigates through the same surface", async () => {
    render(<AuxPanelBrowserTab visible onExplicitClose={() => undefined} />)
    await screen.findByText("Two")
    fireEvent.click(screen.getByRole("button", { name: "Two" }))
    await waitFor(() => {
      expect(surface.runBrowserSurfaceAction).toHaveBeenCalledWith(
        "connection-a",
        { action: "focus", targetId: "t2" }
      )
    })

    const address = screen.getByRole("textbox", { name: "addressBar" })
    fireEvent.change(address, { target: { value: "example.com" } })
    fireEvent.keyDown(address, { key: "Enter" })
    await waitFor(() => {
      expect(surface.runBrowserSurfaceAction).toHaveBeenCalledWith(
        "connection-a",
        { action: "navigate", url: "https://example.com" }
      )
    })
  })

  it("detaches on hide without releasing targets", async () => {
    const { rerender } = render(
      <AuxPanelBrowserTab visible onExplicitClose={() => undefined} />
    )
    await screen.findByText("One")
    rerender(
      <AuxPanelBrowserTab visible={false} onExplicitClose={() => undefined} />
    )

    await waitFor(() => {
      expect(surface.detachBrowserSurface).toHaveBeenCalledWith("connection-a")
    })
    expect(surface.closeBrowserSurface).not.toHaveBeenCalled()
  })

  it("explicit close releases the whole Browser session", async () => {
    const onExplicitClose = vi.fn()
    render(<AuxPanelBrowserTab visible onExplicitClose={onExplicitClose} />)
    await screen.findByText("One")
    fireEvent.click(screen.getByRole("button", { name: "closeBrowser" }))

    await waitFor(() => {
      expect(surface.closeBrowserSurface).toHaveBeenCalledWith("connection-a")
      expect(onExplicitClose).toHaveBeenCalledWith("connection-a")
    })
  })

  it("accepts authoritative full snapshots from the stream", async () => {
    render(<AuxPanelBrowserTab visible onExplicitClose={() => undefined} />)
    await screen.findByText("Two")
    act(() => {
      emit?.({
        type: "snapshot",
        snapshot: {
          ...snapshot,
          tabs: [snapshot.tabs[1]!],
          activeTargetId: "t2",
          active: {
            ...snapshot.active!,
            tab: snapshot.tabs[1]!,
          },
        },
      })
    })

    expect(await screen.findByText("Two")).toBeInTheDocument()
    expect(screen.queryByText("One")).not.toBeInTheDocument()
  })

  it("resizes the real browser viewport to the rendered page region", async () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
    rect.mockReturnValue({
      width: 320,
      height: 620,
      top: 0,
      right: 320,
      bottom: 620,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    render(<AuxPanelBrowserTab visible onExplicitClose={() => undefined} />)

    await waitFor(() => {
      expect(surface.runBrowserSurfaceAction).toHaveBeenCalledWith(
        "connection-a",
        { action: "resize", width: 320, height: 620 }
      )
    })
    rect.mockRestore()
  })

  it("renders frames without non-uniform stretching", async () => {
    render(<AuxPanelBrowserTab visible onExplicitClose={() => undefined} />)
    await screen.findByText("One")
    act(() => {
      emit?.({
        type: "frame",
        frame: {
          targetId: "t1",
          data: "AA==",
          mimeType: "image/jpeg",
          deviceWidth: 1_600,
          deviceHeight: 900,
          pageScaleFactor: 1,
        },
      })
    })

    expect(screen.getByRole("application").querySelector("img")).toHaveClass(
      "object-contain"
    )
  })

  it.each([
    [320, 620],
    [320, 200],
    [620, 320],
  ])(
    "maps input directly when the page viewport matches a %d x %d surface",
    (width, height) => {
      expect(browserFramePoint(width, height, width, height, 0, 0)).toEqual({
        x: 0,
        y: 0,
      })
      expect(
        browserFramePoint(width, height, width, height, width / 2, height / 2)
      ).toEqual({ x: width / 2, y: height / 2 })
      expect(
        browserFramePoint(width, height, width, height, width, height)
      ).toEqual({ x: width, y: height })
    }
  )

  it("maps the fitted frame and rejects temporary letterbox coordinates", () => {
    expect(browserFramePoint(320, 620, 1_600, 900, 160, 310)).toEqual({
      x: 800,
      y: 450,
    })
    expect(browserFramePoint(320, 620, 1_600, 900, 160, 100)).toBeNull()
    expect(browserFramePoint(320, 200, 1_600, 900, -1, 100)).toBeNull()
    expect(browserFramePoint(320, 200, 1_600, 900, 321, 100)).toBeNull()
    expect(browserFramePoint(320, 200, 1_600, 900, 160, 201)).toBeNull()
  })
})
