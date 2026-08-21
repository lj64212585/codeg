import { EventEmitter } from "node:events"

import WebSocket from "ws"

import { BrowserError } from "./errors.js"

export interface CdpSocket {
  readonly readyState: number
  send(data: string): void
  close(): void
  on(event: string, listener: (...args: unknown[]) => void): this
  off(event: string, listener: (...args: unknown[]) => void): this
}

interface PendingCall {
  readonly reject: (error: BrowserError) => void
  readonly resolve: (value: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly signal?: AbortSignal
  readonly abortListener?: () => void
}

interface CdpResponse {
  readonly id?: number
  readonly method?: string
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: {
    readonly code?: number
    readonly message?: string
  }
}

export interface CdpCallOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

const DEFAULT_CALL_TIMEOUT_MS = 15_000
const SOCKET_OPEN = 1

export class CdpConnection {
  private readonly events = new EventEmitter()
  private readonly pending = new Map<number, PendingCall>()
  private nextId = 1
  private closed = false

  private readonly messageListener = (...args: unknown[]) => {
    this.handleMessage(args[0])
  }

  private readonly closeListener = () => {
    this.closeWithError(
      new BrowserError("BROWSER_CRASHED", "Chrome DevTools connection closed", {
        retryable: true,
        recovery: "recover_runtime",
      })
    )
  }

  private readonly errorListener = (...args: unknown[]) => {
    const cause = args[0]
    this.closeWithError(
      new BrowserError("BROWSER_CRASHED", "Chrome DevTools connection failed", {
        cause,
        retryable: true,
        recovery: "recover_runtime",
      })
    )
  }

  constructor(private readonly socket: CdpSocket) {
    socket.on("message", this.messageListener)
    socket.on("close", this.closeListener)
    socket.on("error", this.errorListener)
  }

  get pendingCount(): number {
    return this.pending.size
  }

  on<T = unknown>(method: string, listener: (params: T) => void): () => void {
    const wrapped = listener as (value: unknown) => void
    this.events.on(method, wrapped)
    return () => this.events.off(method, wrapped)
  }

  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: CdpCallOptions = {}
  ): Promise<T> {
    if (this.closed || this.socket.readyState !== SOCKET_OPEN) {
      throw new BrowserError(
        "BROWSER_CRASHED",
        "Chrome DevTools connection is not open",
        {
          retryable: true,
          recovery: "recover_runtime",
        }
      )
    }
    if (options.signal?.aborted) {
      throw new BrowserError("ABORTED", "Chrome DevTools request was aborted", {
        retryable: true,
        recovery: "retry",
      })
    }

    const id = this.nextId++
    const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectPending(
          id,
          new BrowserError(
            "TIMEOUT",
            `Chrome DevTools request timed out: ${method}`,
            {
              retryable: true,
              recovery: "retry",
            }
          )
        )
      }, timeoutMs)

      const abortListener = options.signal
        ? () => {
            this.rejectPending(
              id,
              new BrowserError(
                "ABORTED",
                "Chrome DevTools request was aborted",
                {
                  retryable: true,
                  recovery: "retry",
                }
              )
            )
          }
        : undefined

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        signal: options.signal,
        abortListener,
      })
      options.signal?.addEventListener("abort", abortListener!, { once: true })

      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        this.rejectPending(
          id,
          new BrowserError(
            "BROWSER_CRASHED",
            "Could not send Chrome DevTools request",
            {
              cause: error,
              retryable: true,
              recovery: "recover_runtime",
            }
          )
        )
      }
    })
  }

  close(): void {
    if (this.closed) return
    this.closeWithError(
      new BrowserError("ABORTED", "Chrome DevTools connection was closed", {
        retryable: true,
        recovery: "retry",
      })
    )
    this.socket.close()
  }

  private handleMessage(raw: unknown): void {
    let message: CdpResponse
    try {
      const text =
        typeof raw === "string"
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString("utf8")
            : raw instanceof ArrayBuffer
              ? Buffer.from(raw).toString("utf8")
              : String(raw)
      message = JSON.parse(text) as CdpResponse
    } catch {
      return
    }

    if (typeof message.id === "number") {
      const pending = this.takePending(message.id)
      if (!pending) return
      if (message.error) {
        pending.reject(
          new BrowserError(
            "INTERNAL_ERROR",
            `Chrome DevTools error ${message.error.code ?? "unknown"}: ${message.error.message ?? "Unknown protocol error"}`
          )
        )
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (message.method) {
      this.events.emit(message.method, message.params)
    }
  }

  private takePending(id: number): PendingCall | undefined {
    const pending = this.pending.get(id)
    if (!pending) return undefined
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener)
    }
    return pending
  }

  private rejectPending(id: number, error: BrowserError): void {
    this.takePending(id)?.reject(error)
  }

  private closeWithError(error: BrowserError): void {
    if (this.closed) return
    this.closed = true
    this.socket.off("message", this.messageListener)
    this.socket.off("close", this.closeListener)
    this.socket.off("error", this.errorListener)
    for (const id of [...this.pending.keys()]) {
      this.rejectPending(id, error)
    }
    this.events.removeAllListeners()
  }
}

export async function connectCdp(
  webSocketUrl: string,
  options: CdpCallOptions = {}
): Promise<CdpConnection> {
  const socket = new WebSocket(webSocketUrl, {
    handshakeTimeout: options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    maxPayload: 8 * 1024 * 1024,
  })

  await new Promise<void>((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    const timer = setTimeout(() => {
      cleanup()
      socket.terminate()
      reject(
        new BrowserError("TIMEOUT", "Timed out connecting to Chrome DevTools", {
          retryable: true,
          recovery: "retry",
        })
      )
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timer)
      socket.off("open", handleOpen)
      socket.off("error", handleError)
      options.signal?.removeEventListener("abort", handleAbort)
    }
    const handleOpen = () => {
      cleanup()
      resolve()
    }
    const handleError = (error: Error) => {
      cleanup()
      reject(
        new BrowserError(
          "BROWSER_CRASHED",
          "Could not connect to Chrome DevTools",
          {
            cause: error,
            retryable: true,
            recovery: "recover_runtime",
          }
        )
      )
    }
    const handleAbort = () => {
      cleanup()
      socket.terminate()
      reject(
        new BrowserError("ABORTED", "Chrome DevTools connection was aborted", {
          retryable: true,
          recovery: "retry",
        })
      )
    }

    socket.once("open", handleOpen)
    socket.once("error", handleError)
    options.signal?.addEventListener("abort", handleAbort, { once: true })
    if (options.signal?.aborted) handleAbort()
  })

  return new CdpConnection(socket)
}
