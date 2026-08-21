import { lookup as nodeLookup } from "node:dns/promises"
import { realpath } from "node:fs/promises"
import { isIP } from "node:net"
import { isAbsolute, relative, resolve, sep } from "node:path"

import ipaddr from "ipaddr.js"

import { BrowserError } from "./errors.js"

export interface LookupAddress {
  address: string
  family: 4 | 6
}

export type DnsLookup = (hostname: string) => Promise<LookupAddress[]>

export interface NavigationValidationOptions {
  lookup?: DnsLookup
  /** Exact hosts permitted only by deterministic tests; production passes none. */
  allowHosts?: ReadonlySet<string>
}

export type IpClassification = "public" | "private" | "special"

export function classifyIpAddress(address: string): IpClassification {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6
  try {
    parsed = ipaddr.parse(address.replace(/^\[|\]$/g, ""))
  } catch {
    return "special"
  }

  if (parsed.kind() === "ipv6") {
    const ipv6 = parsed as ipaddr.IPv6
    if (ipv6.isIPv4MappedAddress()) {
      parsed = ipv6.toIPv4Address()
    }
  }
  const range = parsed.range()
  if (range === "unicast") return "public"
  if (
    range === "private" ||
    range === "loopback" ||
    range === "linkLocal" ||
    range === "uniqueLocal" ||
    range === "carrierGradeNat"
  ) {
    return "private"
  }
  return "special"
}

function defaultLookup(hostname: string): Promise<LookupAddress[]> {
  return nodeLookup(hostname, { all: true, verbatim: true }) as Promise<
    LookupAddress[]
  >
}

function hostnameIsLocallyScoped(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "")
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".home.arpa")
  )
}

export async function validateNavigationUrl(
  input: string,
  options: NavigationValidationOptions = {}
): Promise<{ url: string; hostname: string; addresses: string[] }> {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch (error) {
    throw new BrowserError("URL_INVALID", "URL is invalid", { cause: error })
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BrowserError(
      "URL_SCHEME_BLOCKED",
      "Only http:// and https:// URLs are allowed"
    )
  }
  if (parsed.username || parsed.password) {
    throw new BrowserError(
      "URL_CREDENTIALS_BLOCKED",
      "Credentials embedded in URLs are not allowed"
    )
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (!hostname) {
    throw new BrowserError("URL_INVALID", "URL hostname is missing")
  }
  if (options.allowHosts?.has(hostname)) {
    return { url: parsed.toString(), hostname, addresses: [hostname] }
  }
  if (hostnameIsLocallyScoped(hostname)) {
    throw new BrowserError("SSRF_BLOCKED", "Local hostnames are blocked")
  }

  let addresses: LookupAddress[]
  if (isIP(hostname)) {
    addresses = [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
  } else {
    try {
      addresses = await (options.lookup ?? defaultLookup)(hostname)
    } catch (error) {
      throw new BrowserError(
        "DNS_FAILED",
        "URL hostname could not be resolved",
        {
          cause: error,
          retryable: true,
          recovery: "retry",
        }
      )
    }
  }
  if (addresses.length === 0) {
    throw new BrowserError("DNS_FAILED", "URL hostname returned no addresses")
  }
  for (const answer of addresses) {
    if (classifyIpAddress(answer.address) !== "public") {
      throw new BrowserError(
        "SSRF_BLOCKED",
        "URL resolves to a private or special-use address"
      )
    }
  }
  return {
    url: parsed.toString(),
    hostname,
    addresses: addresses.map((answer) => answer.address),
  }
}

export interface HeaderEntry {
  name: string
  value: string
}

const SENSITIVE_REDIRECT_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
])

export function sanitizeRedirectHeaders(
  previousUrl: string,
  nextUrl: string,
  headers: readonly HeaderEntry[]
): HeaderEntry[] {
  let sameOrigin = false
  try {
    sameOrigin = new URL(previousUrl).origin === new URL(nextUrl).origin
  } catch {
    sameOrigin = false
  }
  if (sameOrigin) return [...headers]
  return headers.filter(
    (header) => !SENSITIVE_REDIRECT_HEADERS.has(header.name.toLowerCase())
  )
}

export async function assertControlledPath(
  rootPath: string,
  candidatePath: string
): Promise<string> {
  const [rootReal, candidateReal] = await Promise.all([
    realpath(resolve(rootPath)),
    realpath(resolve(candidatePath)),
  ])
  const rel = relative(rootReal, candidateReal)
  if (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  ) {
    return candidateReal
  }
  throw new BrowserError(
    "PATH_ESCAPE",
    "Path escapes the controlled Browser directory"
  )
}
