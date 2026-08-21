"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import {
  loadPersistedPanelState,
  savePersistedPanelState,
} from "@/lib/panel-state-storage"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { detectPlatform } from "@/hooks/use-platform"
import { isDesktop } from "@/lib/platform"
import { subscribe } from "@/lib/platform"

export type AuxPanelTab =
  | "session_details"
  | "file_tree"
  | "changes"
  | "git_log"
  | "browser"

const STORAGE_KEY = "workspace:right-sidebar"
const BROWSER_SESSIONS_STORAGE_KEY = "workspace:right-sidebar:browser-sessions"

const DEFAULT_WIDTH = 320
const MIN_WIDTH = 200
const MAX_WIDTH = 900
const DEFAULT_IS_OPEN = false

// The tabs now sit on their own row below the fixed top-right window-chrome
// overlay (terminal/aux/settings), so they no longer need extra width to clear
// it. The minimum only has to keep that overlay — and, on Windows/Linux, the
// native caption strip beside it (~116 + 138) — from spilling past the panel's
// left edge over the middle column. Elsewhere the base 200 is plenty.
function resolveAuxMinWidth(): number {
  const platform = detectPlatform()
  if (isDesktop() && (platform === "windows" || platform === "linux")) {
    return 260
  }
  return MIN_WIDTH
}

interface AuxPanelContextValue {
  isOpen: boolean
  restored: boolean
  width: number
  minWidth: number
  maxWidth: number
  activeTab: AuxPanelTab
  toggle: () => void
  /** Imperatively set the panel open/closed (used by the chat-mode auto-hide). */
  setOpen: (open: boolean) => void
  setWidth: (w: number) => void
  setActiveTab: (tab: AuxPanelTab) => void
  openTab: (tab: AuxPanelTab) => void
  pendingRevealPath: string | null
  revealInFileTree: (path: string) => void
  consumePendingRevealPath: () => void
  browserSessionIds: ReadonlySet<string>
  setBrowserSessionOpen: (connectionId: string, open: boolean) => void
}

const AuxPanelContext = createContext<AuxPanelContextValue | null>(null)

export function useAuxPanelContext() {
  const ctx = useContext(AuxPanelContext)
  if (!ctx) {
    throw new Error("useAuxPanelContext must be used within AuxPanelProvider")
  }
  return ctx
}

function clampWidth(width: number, minWidth: number) {
  return Math.max(minWidth, Math.min(MAX_WIDTH, width))
}

interface AuxPanelProviderProps {
  children: ReactNode
}

export function AuxPanelProvider({ children }: AuxPanelProviderProps) {
  const storageKey = STORAGE_KEY
  const { activeFolderId } = useActiveFolder()
  const [isOpen, setIsOpen] = useState(DEFAULT_IS_OPEN)
  const [width, setWidthState] = useState(DEFAULT_WIDTH)
  const [restored, setRestored] = useState(false)
  const [activeTab, setActiveTab] = useState<AuxPanelTab>("session_details")
  const [pendingRevealPath, setPendingRevealPath] = useState<string | null>(
    null
  )
  const [browserSessionIds, setBrowserSessionIds] = useState<Set<string>>(
    () => new Set()
  )
  // Platform-derived minimum (see resolveAuxMinWidth); stable for the session.
  const minWidth = useMemo(() => resolveAuxMinWidth(), [])

  const toggle = useCallback(() => setIsOpen((prev) => !prev), [])

  const setOpen = useCallback((open: boolean) => setIsOpen(open), [])

  const setWidth = useCallback(
    (w: number) => {
      setWidthState(clampWidth(w, minWidth))
    },
    [minWidth]
  )

  const openTab = useCallback((tab: AuxPanelTab) => {
    setActiveTab(tab)
    setIsOpen(true)
  }, [])

  const revealInFileTree = useCallback((path: string) => {
    setPendingRevealPath(path)
    setActiveTab("file_tree")
    setIsOpen(true)
  }, [])

  const consumePendingRevealPath = useCallback(() => {
    setPendingRevealPath(null)
  }, [])

  const setBrowserSessionOpen = useCallback(
    (connectionId: string, open: boolean) => {
      setBrowserSessionIds((current) => {
        if (current.has(connectionId) === open) return current
        const next = new Set(current)
        if (open) next.add(connectionId)
        else next.delete(connectionId)
        try {
          localStorage.setItem(
            BROWSER_SESSIONS_STORAGE_KEY,
            JSON.stringify([...next].slice(-100))
          )
        } catch {
          // Private mode or storage quota: the Tauri registry remains authoritative.
        }
        return next
      })
    },
    []
  )

  useEffect(() => {
    const stored = loadPersistedPanelState(storageKey)
    const isMobileViewport = window.innerWidth < 768
    const defaultOpen = isMobileViewport ? false : DEFAULT_IS_OPEN
    // Hydrate from localStorage after mount to keep SSR/CSR markup consistent.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsOpen(isMobileViewport ? false : (stored?.isOpen ?? defaultOpen))
    setWidthState(clampWidth(stored?.width ?? DEFAULT_WIDTH, minWidth))
    try {
      const parsed = JSON.parse(
        localStorage.getItem(BROWSER_SESSIONS_STORAGE_KEY) ?? "[]"
      ) as unknown
      if (Array.isArray(parsed)) {
        setBrowserSessionIds(
          new Set(
            parsed.filter(
              (value): value is string =>
                typeof value === "string" &&
                value.length > 0 &&
                value.length <= 256 &&
                /^[A-Za-z0-9._:-]+$/.test(value)
            )
          )
        )
      }
    } catch {
      setBrowserSessionIds(new Set())
    }
    setRestored(true)
  }, [storageKey, minWidth])

  useEffect(() => {
    if (!restored) return
    savePersistedPanelState(storageKey, { isOpen, width })
  }, [isOpen, restored, storageKey, width])

  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | null = null
    void subscribe<{ connectionId: string }>(
      "browser://session-activity",
      ({ connectionId }) => {
        if (!disposed) setBrowserSessionOpen(connectionId, true)
      }
    ).then((next) => {
      if (disposed) next()
      else unsubscribe = next
    })
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [setBrowserSessionOpen])

  // Reset pending reveal path when the active folder changes; file tree
  // state is content-driven by the workspace contexts and will refetch
  // naturally via its folder-path dependency.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingRevealPath(null)
  }, [activeFolderId])

  const value = useMemo(
    () => ({
      isOpen,
      restored,
      width,
      minWidth,
      maxWidth: MAX_WIDTH,
      activeTab,
      toggle,
      setOpen,
      setWidth,
      setActiveTab,
      openTab,
      pendingRevealPath,
      revealInFileTree,
      consumePendingRevealPath,
      browserSessionIds,
      setBrowserSessionOpen,
    }),
    [
      isOpen,
      restored,
      width,
      minWidth,
      activeTab,
      toggle,
      setOpen,
      setWidth,
      openTab,
      pendingRevealPath,
      revealInFileTree,
      consumePendingRevealPath,
      browserSessionIds,
      setBrowserSessionOpen,
    ]
  )

  return (
    <AuxPanelContext.Provider value={value}>
      {children}
    </AuxPanelContext.Provider>
  )
}
