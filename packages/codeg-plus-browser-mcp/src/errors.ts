export type BrowserErrorCode =
  | "INVALID_ARGS"
  | "UNKNOWN_TOOL"
  | "RUNTIME_NOT_READY"
  | "RUNTIME_START_FAILED"
  | "BROWSER_NOT_FOUND"
  | "BROWSER_CRASHED"
  | "SESSION_STALE"
  | "SURFACE_ALREADY_ATTACHED"
  | "TAB_NOT_FOUND"
  | "REF_NOT_FOUND"
  | "URL_INVALID"
  | "URL_SCHEME_BLOCKED"
  | "URL_CREDENTIALS_BLOCKED"
  | "DNS_FAILED"
  | "SSRF_BLOCKED"
  | "PATH_ESCAPE"
  | "DOWNLOAD_FAILED"
  | "TIMEOUT"
  | "ABORTED"
  | "RESULT_TOO_LARGE"
  | "INTERNAL_ERROR"

export class BrowserError extends Error {
  readonly code: BrowserErrorCode
  readonly retryable: boolean
  readonly recovery?: "retry" | "recover_runtime" | "check_settings"
  readonly cause?: unknown

  constructor(
    code: BrowserErrorCode,
    message: string,
    options: {
      cause?: unknown
      retryable?: boolean
      recovery?: "retry" | "recover_runtime" | "check_settings"
    } = {}
  ) {
    super(message)
    this.name = "BrowserError"
    this.code = code
    this.retryable = options.retryable ?? false
    this.recovery = options.recovery
    this.cause = options.cause
  }
}

export function asBrowserError(error: unknown): BrowserError {
  if (error instanceof BrowserError) return error
  if (error instanceof Error && error.name === "AbortError") {
    return new BrowserError("ABORTED", "Browser operation was aborted", {
      cause: error,
      retryable: true,
      recovery: "retry",
    })
  }
  return new BrowserError("INTERNAL_ERROR", "Browser operation failed", {
    cause: error,
    recovery: "recover_runtime",
  })
}
