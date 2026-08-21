"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from "react"
import {
  ArrowLeft,
  ArrowRight,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { recoverBrowserRuntime } from "@/lib/api"
import {
  attachBrowserSurface,
  closeBrowserSurface,
  detachBrowserSurface,
  runBrowserSurfaceAction,
  type BrowserSurfaceAction,
  type BrowserSurfaceEvent,
  type BrowserSurfaceFrame,
  type BrowserSurfaceInput,
  type BrowserSurfaceSnapshot,
} from "@/lib/browser-surface"
import { toErrorMessage } from "@/lib/app-error"
import { useTabStore } from "@/contexts/tab-context"
import { useConnection } from "@/hooks/use-connection"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

interface AuxPanelBrowserTabProps {
  visible: boolean
  onExplicitClose: (connectionId: string) => void
  onSessionAttached?: (connectionId: string) => void
}

interface QueuedBrowserInput {
  connectionId: string
  generation: number
  input: BrowserSurfaceInput
}

function normalizeAddress(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || /^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

function modifiers(event: {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  )
}

export function browserFramePoint(
  containerWidth: number,
  containerHeight: number,
  frameWidth: number,
  frameHeight: number,
  offsetX: number,
  offsetY: number
): { x: number; y: number } | null {
  if (
    containerWidth <= 0 ||
    containerHeight <= 0 ||
    frameWidth <= 0 ||
    frameHeight <= 0
  ) {
    return null
  }

  if (
    offsetX < 0 ||
    offsetX > containerWidth ||
    offsetY < 0 ||
    offsetY > containerHeight
  ) {
    return null
  }

  const scale = Math.min(
    containerWidth / frameWidth,
    containerHeight / frameHeight
  )
  const renderedWidth = frameWidth * scale
  const renderedHeight = frameHeight * scale
  const insetX = (containerWidth - renderedWidth) / 2
  const insetY = (containerHeight - renderedHeight) / 2
  if (
    offsetX < insetX ||
    offsetX > insetX + renderedWidth ||
    offsetY < insetY ||
    offsetY > insetY + renderedHeight
  ) {
    return null
  }

  return {
    x: (offsetX - insetX) / scale,
    y: (offsetY - insetY) / scale,
  }
}

export function AuxPanelBrowserTab({
  visible,
  onExplicitClose,
  onSessionAttached,
}: AuxPanelBrowserTabProps) {
  const t = useTranslations("BrowserSurface")
  const activeTabId = useTabStore((state) => state.activeTabId)
  const { connectionId } = useConnection(activeTabId ?? "browser-no-active-tab")
  const [snapshot, setSnapshot] = useState<BrowserSurfaceSnapshot | null>(null)
  const [frame, setFrame] = useState<BrowserSurfaceFrame | null>(null)
  const [address, setAddress] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [retryKey, setRetryKey] = useState(0)
  const generation = useRef(0)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const inputQueue = useRef<QueuedBrowserInput[]>([])
  const inputQueueRunning = useRef(false)
  const lastViewport = useRef<{
    connectionId: string
    width: number
    height: number
  } | null>(null)
  const onSessionAttachedRef = useRef(onSessionAttached)
  onSessionAttachedRef.current = onSessionAttached

  useEffect(() => {
    if (!visible || !connectionId) return
    const currentGeneration = ++generation.current
    let disposed = false
    let resizeObserver: ResizeObserver | null = null
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    setError(null)
    const acceptSnapshot = (next: BrowserSurfaceSnapshot) => {
      if (
        disposed ||
        generation.current !== currentGeneration ||
        next.sessionId !== connectionId
      ) {
        return
      }
      setSnapshot(next)
    }
    const onEvent = (event: BrowserSurfaceEvent) => {
      if (event.type === "snapshot") {
        acceptSnapshot(event.snapshot)
      } else if (event.type === "frame") {
        if (!disposed && generation.current === currentGeneration) {
          setFrame(event.frame)
        }
      } else if (!disposed && generation.current === currentGeneration) {
        setError(`${event.code}: ${event.message}`)
      }
    }
    void attachBrowserSurface(connectionId, onEvent)
      .then((next) => {
        if (disposed || generation.current !== currentGeneration) return
        acceptSnapshot(next)
        onSessionAttachedRef.current?.(connectionId)
        const syncViewport = () => {
          if (disposed || generation.current !== currentGeneration) return
          const element = surfaceRef.current
          if (!element) return
          const rect = element.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) return
          const width = Math.min(4_096, Math.max(1, Math.round(rect.width)))
          const height = Math.min(4_096, Math.max(1, Math.round(rect.height)))
          const previous = lastViewport.current
          if (
            previous?.connectionId === connectionId &&
            previous.width === width &&
            previous.height === height
          ) {
            return
          }
          lastViewport.current = { connectionId, width, height }
          void runBrowserSurfaceAction(connectionId, {
            action: "resize",
            width,
            height,
          }).catch((cause) => {
            if (!disposed && generation.current === currentGeneration) {
              setError(toErrorMessage(cause))
            }
          })
        }
        lastViewport.current = null
        syncViewport()
        const element = surfaceRef.current
        if (element) {
          resizeObserver = new ResizeObserver(() => {
            if (resizeTimer) clearTimeout(resizeTimer)
            resizeTimer = setTimeout(syncViewport, 50)
          })
          resizeObserver.observe(element)
        }
      })
      .catch((cause) => {
        if (!disposed && generation.current === currentGeneration) {
          setError(toErrorMessage(cause))
        }
      })
    return () => {
      disposed = true
      generation.current += 1
      resizeObserver?.disconnect()
      if (resizeTimer) clearTimeout(resizeTimer)
      void detachBrowserSurface(connectionId).catch(() => undefined)
    }
  }, [connectionId, retryKey, visible])

  const active = snapshot?.active ?? null
  useEffect(() => {
    setAddress(active?.tab.url ?? "")
  }, [active?.tab.url])

  const run = useCallback(
    async (action: BrowserSurfaceAction) => {
      if (!connectionId) return
      setBusy(true)
      setError(null)
      try {
        setSnapshot(await runBrowserSurfaceAction(connectionId, action))
      } catch (cause) {
        setError(toErrorMessage(cause))
      } finally {
        setBusy(false)
      }
    },
    [connectionId]
  )

  const flushInputQueue = useCallback(async () => {
    if (inputQueueRunning.current) return
    inputQueueRunning.current = true
    try {
      let next: QueuedBrowserInput | undefined
      while ((next = inputQueue.current.shift())) {
        if (generation.current !== next.generation) continue
        try {
          await runBrowserSurfaceAction(next.connectionId, {
            action: "input",
            input: next.input,
          })
        } catch (cause) {
          if (generation.current === next.generation) {
            setError(toErrorMessage(cause))
          }
        }
      }
    } finally {
      inputQueueRunning.current = false
    }
  }, [])

  const sendInput = useCallback(
    (input: BrowserSurfaceInput) => {
      if (!connectionId) return
      const next = {
        connectionId,
        generation: generation.current,
        input,
      }
      const pending = inputQueue.current
      const last = pending[pending.length - 1]
      if (
        input.kind === "mouse" &&
        input.event === "moved" &&
        last?.connectionId === connectionId &&
        last.input.kind === "mouse" &&
        last.input.event === "moved"
      ) {
        pending[pending.length - 1] = next
      } else {
        pending.push(next)
      }
      void flushInputQueue()
    },
    [connectionId, flushInputQueue]
  )

  const frameSource = useMemo(() => {
    if (!frame || frame.targetId !== snapshot?.activeTargetId) return null
    return `data:${frame.mimeType};base64,${frame.data}`
  }, [frame, snapshot?.activeTargetId])

  const pointerInput = useCallback(
    (event: PointerEvent<HTMLDivElement>, phase: "pressed" | "released") => {
      if (!frame) return
      const rect = event.currentTarget.getBoundingClientRect()
      const point = browserFramePoint(
        rect.width,
        rect.height,
        frame.deviceWidth,
        frame.deviceHeight,
        event.clientX - rect.left,
        event.clientY - rect.top
      )
      if (!point) return
      const button =
        event.button === 1 ? "middle" : event.button === 2 ? "right" : "left"
      sendInput({
        kind: "mouse",
        event: "moved",
        x: point.x,
        y: point.y,
        button: "none",
        modifiers: modifiers(event),
      })
      sendInput({
        kind: "mouse",
        event: phase,
        x: point.x,
        y: point.y,
        button,
        modifiers: modifiers(event),
      })
      event.currentTarget.focus()
      event.preventDefault()
    },
    [frame, sendInput]
  )

  const pointerMoveInput = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!frame) return
      const rect = event.currentTarget.getBoundingClientRect()
      const point = browserFramePoint(
        rect.width,
        rect.height,
        frame.deviceWidth,
        frame.deviceHeight,
        event.clientX - rect.left,
        event.clientY - rect.top
      )
      if (!point) return
      sendInput({
        kind: "mouse",
        event: "moved",
        x: point.x,
        y: point.y,
        button: "none",
        modifiers: modifiers(event),
      })
      event.preventDefault()
    },
    [frame, sendInput]
  )

  const wheelInput = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (!frame) return
      const rect = event.currentTarget.getBoundingClientRect()
      const point = browserFramePoint(
        rect.width,
        rect.height,
        frame.deviceWidth,
        frame.deviceHeight,
        event.clientX - rect.left,
        event.clientY - rect.top
      )
      if (!point) return
      sendInput({
        kind: "mouse",
        event: "wheel",
        x: point.x,
        y: point.y,
        button: "none",
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers: modifiers(event),
      })
      event.preventDefault()
    },
    [frame, sendInput]
  )

  const keyInput = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Tab") return
      const common = {
        kind: "key" as const,
        key: event.key,
        code: event.code,
        modifiers: modifiers(event),
      }
      sendInput({
        ...common,
        event: "down",
        text:
          event.key.length === 1 && !event.ctrlKey && !event.metaKey
            ? event.key
            : undefined,
      })
      sendInput({ ...common, event: "up" })
      event.preventDefault()
    },
    [sendInput]
  )

  if (!connectionId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {t("noActiveSession")}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-1 border-b p-1.5">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("back")}
          disabled={busy || !active?.canGoBack}
          onClick={() => void run({ action: "back" })}
        >
          <ArrowLeft />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("forward")}
          disabled={busy || !active?.canGoForward}
          onClick={() => void run({ action: "forward" })}
        >
          <ArrowRight />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={active?.loading ? t("stop") : t("reload")}
          disabled={busy || !active}
          onClick={() =>
            void run({ action: active?.loading ? "stop" : "reload" })
          }
        >
          {active?.loading ? <Square /> : <RefreshCw />}
        </Button>
        <Input
          className="h-7 min-w-0 flex-1 px-2 text-xs"
          aria-label={t("addressBar")}
          value={address}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            const url = normalizeAddress(address)
            if (url) void run({ action: "navigate", url })
          }}
        />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("closeBrowser")}
          onClick={() => {
            void closeBrowserSurface(connectionId)
              .then(() => onExplicitClose(connectionId))
              .catch((cause) => setError(toErrorMessage(cause)))
          }}
        >
          <X />
        </Button>
      </div>

      <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b px-1">
        {snapshot?.tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              "flex h-6 min-w-20 max-w-48 shrink-0 items-center rounded-md border",
              tab.id === snapshot.activeTargetId
                ? "bg-muted text-foreground"
                : "border-transparent text-muted-foreground"
            )}
          >
            <button
              type="button"
              className="min-w-0 flex-1 truncate px-2 text-left text-[11px]"
              aria-label={tab.title || tab.url || t("newTab")}
              title={`${tab.title || t("newTab")}\n${tab.url}`}
              onClick={() => void run({ action: "focus", targetId: tab.id })}
            >
              {tab.title || tab.url || t("newTab")}
            </button>
            <button
              type="button"
              className="mr-0.5 rounded p-0.5 hover:bg-foreground/10"
              aria-label={t("closeTab", { title: tab.title || tab.url })}
              onClick={() => void run({ action: "close", targetId: tab.id })}
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <Button
          size="icon-sm"
          variant="ghost"
          className="size-6 shrink-0"
          aria-label={t("openTab")}
          onClick={() => void run({ action: "open" })}
        >
          <Plus />
        </Button>
      </div>

      {error ? (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
        >
          <span className="min-w-0 truncate">{error}</span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              void recoverBrowserRuntime()
                .then(() => setRetryKey((value) => value + 1))
                .catch((cause) => setError(toErrorMessage(cause)))
            }}
          >
            <RotateCcw />
            {t("recover")}
          </Button>
        </div>
      ) : null}

      <div
        ref={surfaceRef}
        className="relative min-h-0 flex-1 touch-none overflow-hidden bg-muted/30 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        role="application"
        tabIndex={0}
        aria-label={t("page")}
        onPointerDown={(event) => pointerInput(event, "pressed")}
        onPointerMove={pointerMoveInput}
        onPointerUp={(event) => pointerInput(event, "released")}
        onWheel={wheelInput}
        onKeyDown={keyInput}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text")
          if (text) sendInput({ kind: "text", text })
          event.preventDefault()
        }}
        onContextMenu={(event) => event.preventDefault()}
      >
        {frameSource ? (
          // The frame is the same CDP target the Agent controls. The target's
          // viewport follows this display region; contain is only a safe fallback
          // while a resized frame is in flight. Input uses the same fitted rect.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={frameSource}
            alt=""
            draggable={false}
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
            {busy || active?.loading ? (
              <span className="inline-flex items-center gap-2">
                <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                {t("loading")}
              </span>
            ) : (
              t("waitingForFrame")
            )}
          </div>
        )}
      </div>
    </div>
  )
}
