import { spawn, type ChildProcess } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import { access, mkdir, readFile, rm, stat } from "node:fs/promises"
import { basename, join, resolve } from "node:path"

import { BrowserError } from "./errors.js"

export interface ChromeProcessOptions {
  profileDir: string
  downloadDir: string
  browserPath?: string
  startupTimeoutMs?: number
  headless?: boolean
}

export interface ChromeProcessInfo {
  executable: string
  name: string
  pid: number
  port: number
}

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const details = await stat(path)
    if (!details.isFile()) return false
    await access(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function discoverBrowserPath(
  configuredPath?: string
): Promise<string> {
  if (configuredPath) {
    const path = resolve(configuredPath)
    if (await isExecutableFile(path)) return path
    throw new BrowserError(
      "BROWSER_NOT_FOUND",
      "The configured browser executable does not exist or cannot be executed",
      { recovery: "check_settings" }
    )
  }

  const candidates: string[] = []
  const programFiles = process.env.PROGRAMFILES
  const programFilesX86 = process.env["PROGRAMFILES(X86)"]
  const localAppData = process.env.LOCALAPPDATA
  for (const root of [programFiles, programFilesX86, localAppData]) {
    if (!root) continue
    candidates.push(
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
      join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(root, "Chromium", "Application", "chrome.exe")
    )
  }
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    )
  }
  if (process.platform === "linux") {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/microsoft-edge",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser"
    )
  }

  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) return candidate
  }
  throw new BrowserError(
    "BROWSER_NOT_FOUND",
    "No supported Chrome, Edge, or Chromium installation was found",
    { recovery: "check_settings" }
  )
}

function browserName(executable: string): string {
  const name = basename(executable).toLowerCase()
  if (name.includes("edge")) return "Microsoft Edge"
  if (name.includes("chromium")) return "Chromium"
  return "Google Chrome"
}

export class ManagedChromeProcess {
  private child: ChildProcess | null = null
  private infoValue: ChromeProcessInfo | null = null
  private stopping = false
  private crashListener: ((code: number | null) => void) | undefined

  constructor(private readonly options: ChromeProcessOptions) {}

  get info(): ChromeProcessInfo | null {
    return this.infoValue
  }

  onCrash(listener: (code: number | null) => void): void {
    this.crashListener = listener
  }

  async start(): Promise<ChromeProcessInfo> {
    if (this.infoValue) return this.infoValue
    const executable = await discoverBrowserPath(this.options.browserPath)
    const profileDir = resolve(this.options.profileDir)
    const downloadDir = resolve(this.options.downloadDir)
    await Promise.all([
      mkdir(profileDir, { recursive: true }),
      mkdir(downloadDir, { recursive: true }),
    ])

    const portFile = join(profileDir, "DevToolsActivePort")
    await rm(portFile, { force: true })
    const chromeArgs = [
      ...(this.options.headless
        ? ["--headless=new", "--window-size=1440,900"]
        : []),
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--metrics-recording-only",
      "about:blank",
    ]
    const child = spawn(executable, chromeArgs, {
      detached: false,
      windowsHide: true,
      stdio: "ignore",
    })
    if (!child.pid) {
      throw new BrowserError(
        "RUNTIME_START_FAILED",
        "The browser process did not return a process identifier",
        { recovery: "check_settings" }
      )
    }
    this.child = child
    this.stopping = false
    child.once("exit", (code) => {
      const unexpected = !this.stopping
      this.child = null
      this.infoValue = null
      if (unexpected) this.crashListener?.(code)
    })

    try {
      const port = await this.waitForPort(
        portFile,
        this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
        child
      )
      this.infoValue = {
        executable,
        name: browserName(executable),
        pid: child.pid,
        port,
      }
      return this.infoValue
    } catch (error) {
      await this.stop()
      if (error instanceof BrowserError) throw error
      throw new BrowserError(
        "RUNTIME_START_FAILED",
        "The browser did not expose its DevTools endpoint",
        { cause: error, recovery: "check_settings" }
      )
    }
  }

  async stop(): Promise<void> {
    const child = this.child
    this.stopping = true
    this.child = null
    this.infoValue = null
    if (!child?.pid || child.exitCode !== null) return
    await killProcessTree(child.pid)
  }

  private async waitForPort(
    portFile: string,
    timeoutMs: number,
    child: ChildProcess
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new BrowserError(
          "RUNTIME_START_FAILED",
          "The browser exited before DevTools became ready",
          { recovery: "check_settings" }
        )
      }
      try {
        const [line] = (await readFile(portFile, "utf8")).split(/\r?\n/)
        const port = Number(line)
        if (Number.isInteger(port) && port > 0 && port <= 65_535) return port
      } catch {
        // Chrome writes this file only after DevTools is listening.
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new BrowserError(
      "TIMEOUT",
      "Timed out waiting for the browser DevTools endpoint",
      { recovery: "check_settings" }
    )
  }
}

async function killProcessTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === "win32") {
    await new Promise<void>((resolveDone) => {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      })
      killer.once("error", () => resolveDone())
      killer.once("exit", () => resolveDone())
    })
    return
  }
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    return
  }
  await new Promise((resolveDone) => setTimeout(resolveDone, 750))
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // The process already exited.
  }
}
