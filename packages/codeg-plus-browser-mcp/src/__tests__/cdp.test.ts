import { EventEmitter } from "node:events"

import { describe, expect, it, vi } from "vitest"

import { CdpConnection, type CdpSocket } from "../cdp.js"

class FakeSocket extends EventEmitter implements CdpSocket {
  readonly sent: string[] = []
  readyState = 1

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.emit("close")
  }

  receive(value: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(value)))
  }
}

describe("CdpConnection", () => {
  it("matches responses to requests", async () => {
    const socket = new FakeSocket()
    const cdp = new CdpConnection(socket)
    const pending = cdp.call("Page.getNavigationHistory", {})
    const request = JSON.parse(socket.sent[0] ?? "{}") as {
      id: number
      method: string
    }
    expect(request.method).toBe("Page.getNavigationHistory")

    socket.receive({ id: request.id, result: { currentIndex: 1 } })
    await expect(pending).resolves.toEqual({ currentIndex: 1 })
  })

  it("dispatches protocol events", () => {
    const socket = new FakeSocket()
    const cdp = new CdpConnection(socket)
    const listener = vi.fn()
    cdp.on("Page.loadEventFired", listener)

    socket.receive({ method: "Page.loadEventFired", params: { timestamp: 42 } })
    expect(listener).toHaveBeenCalledWith({ timestamp: 42 })
  })

  it("times out a request without leaking the pending call", async () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    const cdp = new CdpConnection(socket)
    const pending = cdp.call("Runtime.evaluate", {}, { timeoutMs: 50 })
    const assertion = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" })

    await vi.advanceTimersByTimeAsync(51)
    await assertion
    expect(cdp.pendingCount).toBe(0)
    vi.useRealTimers()
  })

  it("rejects all pending requests when the socket closes", async () => {
    const socket = new FakeSocket()
    const cdp = new CdpConnection(socket)
    const first = cdp.call("Page.enable")
    const second = cdp.call("DOM.enable")

    socket.close()
    await expect(first).rejects.toMatchObject({ code: "BROWSER_CRASHED" })
    await expect(second).rejects.toMatchObject({ code: "BROWSER_CRASHED" })
    expect(cdp.pendingCount).toBe(0)
  })

  it("aborts an in-flight request", async () => {
    const socket = new FakeSocket()
    const cdp = new CdpConnection(socket)
    const controller = new AbortController()
    const pending = cdp.call("Page.navigate", {}, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" })
    expect(cdp.pendingCount).toBe(0)
  })
})
