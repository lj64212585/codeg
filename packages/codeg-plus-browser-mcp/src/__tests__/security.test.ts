import { mkdtemp, mkdir, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  assertControlledPath,
  classifyIpAddress,
  sanitizeRedirectHeaders,
  validateNavigationUrl,
} from "../security.js"

describe("navigation security", () => {
  it.each(["file:///etc/passwd", "data:text/plain,hello", "chrome://settings"])(
    "rejects privileged scheme %s",
    async (url) => {
      await expect(validateNavigationUrl(url)).rejects.toMatchObject({
        code: "URL_SCHEME_BLOCKED",
      })
    }
  )

  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])("classifies %s as blocked", (address) => {
    expect(classifyIpAddress(address)).not.toBe("public")
  })

  it("allows a public address", () => {
    expect(classifyIpAddress("8.8.8.8")).toBe("public")
    expect(classifyIpAddress("2606:4700:4700::1111")).toBe("public")
  })

  it("checks every DNS answer and blocks a rebound private answer", async () => {
    let attempt = 0
    const lookup = async () => {
      attempt += 1
      return attempt === 1
        ? [{ address: "93.184.216.34", family: 4 as const }]
        : [{ address: "127.0.0.1", family: 4 as const }]
    }

    await expect(
      validateNavigationUrl("https://example.test", { lookup })
    ).resolves.toMatchObject({ hostname: "example.test" })
    await expect(
      validateNavigationUrl("https://example.test", { lookup })
    ).rejects.toMatchObject({ code: "SSRF_BLOCKED" })
  })

  it("strips sensitive headers only across origins", () => {
    const headers = [
      { name: "Authorization", value: "Bearer secret" },
      { name: "Cookie", value: "session=secret" },
      { name: "Accept", value: "text/html" },
    ]
    expect(
      sanitizeRedirectHeaders(
        "https://a.example/path",
        "https://b.example/path",
        headers
      )
    ).toEqual([{ name: "Accept", value: "text/html" }])
    expect(
      sanitizeRedirectHeaders(
        "https://a.example/one",
        "https://a.example/two",
        headers
      )
    ).toEqual(headers)
  })
})

describe("controlled filesystem paths", () => {
  it("accepts a real path inside the controlled root", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeg-browser-root-"))
    const nested = join(root, "downloads")
    await mkdir(nested)
    await expect(assertControlledPath(root, nested)).resolves.toBe(
      await realpath(nested)
    )
  })

  it("rejects lexical path traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeg-browser-root-"))
    const outside = await mkdtemp(join(tmpdir(), "codeg-browser-outside-"))
    await expect(assertControlledPath(root, outside)).rejects.toMatchObject({
      code: "PATH_ESCAPE",
    })
  })
})
