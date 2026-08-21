"use client"

import { memo, useCallback, useMemo, useState } from "react"
import Image from "next/image"
import {
  AlertCircle,
  Download,
  Globe2,
  ImageIcon,
  RotateCcw,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Tool, ToolContent, ToolHeader } from "@/components/ai-elements/tool"
import { ImagePreviewDialog } from "@/components/ui/image-preview-dialog"
import type { AdaptedToolCallPart } from "@/lib/adapters/ai-elements-adapter"
import {
  browserScreenshotImages,
  parseBrowserToolView,
} from "@/lib/browser-tool"
import { toErrorMessage } from "@/lib/app-error"
import { downloadImage } from "@/lib/image-download"

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export const BrowserToolCard = memo(function BrowserToolCard({
  part,
}: {
  part: AdaptedToolCallPart
}) {
  const t = useTranslations("Folder.chat.messageList")
  const [manualOpen, setManualOpen] = useState(false)
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const view = useMemo(
    () =>
      parseBrowserToolView({
        toolName: part.toolName,
        input: part.input,
        output: part.output,
        errorText: part.errorText,
      }),
    [part.toolName, part.input, part.output, part.errorText]
  )
  const images = useMemo(
    () => browserScreenshotImages(part.images),
    [part.images]
  )

  const handleDownload = useCallback(
    async (index: number) => {
      const image = images[index]
      if (!image) return
      try {
        await downloadImage({
          data: image.data,
          mime_type: image.mime_type,
          suggestedName: `browser-screenshot-${index + 1}.${
            image.mime_type === "image/jpeg" ? "jpg" : "png"
          }`,
        })
      } catch (error) {
        window.alert(t("downloadFailed", { message: toErrorMessage(error) }))
      }
    },
    [images, t]
  )

  if (!view) return null

  const inFlight =
    part.state === "input-available" || part.state === "input-streaming"
  const outputObject = asObject(view.output)
  const data = asObject(outputObject?.data)
  const tabs = Array.isArray(data?.tabs) ? data.tabs.length : null
  const nodes = Array.isArray(data?.nodes) ? data.nodes.length : null
  const runtimeState =
    typeof data?.state === "string"
      ? data.state
      : typeof outputObject?.state === "string"
        ? outputObject.state
        : null
  const open =
    manualOpen ||
    inFlight ||
    view.error !== null ||
    images.length > 0 ||
    view.downloads.length > 0
  const previewImage =
    previewIndex === null ? null : (images[previewIndex] ?? null)

  return (
    <Tool open={open} onOpenChange={setManualOpen}>
      <ToolHeader
        type="dynamic-tool"
        state={part.state}
        toolName={view.name}
        title={`Browser · ${view.name}`}
        icon={<Globe2 className="size-4" aria-hidden="true" />}
      />
      <ToolContent>
        <div className="space-y-3 text-xs">
          {view.input.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {view.input.map((item, index) => (
                <span
                  key={`${item.label}-${index}`}
                  className="rounded-full border bg-muted/30 px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                >
                  {item.label}={item.value}
                </span>
              ))}
            </div>
          ) : null}
          {view.tab ? (
            <div className="grid gap-1 rounded-lg border bg-muted/30 p-2.5">
              {view.tab.title ? (
                <div className="truncate font-medium" title={view.tab.title}>
                  {view.tab.title}
                </div>
              ) : null}
              {view.tab.url ? (
                <div
                  className="break-all font-mono text-muted-foreground select-all"
                  title={view.tab.url}
                >
                  {view.tab.url}
                </div>
              ) : null}
              {view.tab.id ? (
                <div className="font-mono text-[11px] text-muted-foreground">
                  Tab {view.tab.id}
                </div>
              ) : null}
            </div>
          ) : null}

          {runtimeState || tabs !== null || nodes !== null ? (
            <div className="flex flex-wrap gap-2 text-muted-foreground">
              {runtimeState ? (
                <span className="rounded-full border px-2 py-0.5">
                  {runtimeState}
                </span>
              ) : null}
              {tabs !== null ? <span>{tabs} tabs</span> : null}
              {nodes !== null ? <span>{nodes} semantic nodes</span> : null}
            </div>
          ) : null}

          {view.downloads.map((download, index) => (
            <div
              key={download.guid ?? `${download.filename}-${index}`}
              className="flex gap-2 rounded-lg border bg-muted/30 p-2.5"
            >
              <Download
                className="mt-0.5 size-3.5 shrink-0"
                aria-hidden="true"
              />
              <div className="min-w-0 space-y-0.5">
                <div className="truncate font-medium">
                  {download.filename ?? download.guid}
                </div>
                <div className="text-muted-foreground">
                  {download.state ?? "unknown"}
                  {download.totalBytes !== null
                    ? ` · ${download.receivedBytes ?? 0}/${download.totalBytes} bytes`
                    : ""}
                </div>
                {download.path ? (
                  <div className="break-all font-mono text-[11px] text-muted-foreground select-all">
                    {download.path}
                  </div>
                ) : null}
                {download.errorCode ? (
                  <div className="text-destructive">{download.errorCode}</div>
                ) : null}
              </div>
            </div>
          ))}

          {images.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {images.map((image, index) => (
                <div
                  key={`${image.mime_type}-${index}`}
                  className="group relative overflow-hidden rounded-lg border bg-muted/30"
                >
                  <button
                    type="button"
                    className="block w-full cursor-pointer"
                    onClick={() => setPreviewIndex(index)}
                    aria-label={`Open Browser screenshot ${index + 1}`}
                  >
                    <Image
                      src={`data:${image.mime_type};base64,${image.data}`}
                      alt={`Browser screenshot ${index + 1}`}
                      width={640}
                      height={400}
                      unoptimized
                      className="max-h-80 w-full object-contain"
                    />
                  </button>
                  <div className="absolute right-1 top-1 flex items-center gap-1 rounded-full bg-background/85 p-1 shadow-sm">
                    <ImageIcon className="size-3.5" aria-hidden="true" />
                    <button
                      type="button"
                      onClick={() => void handleDownload(index)}
                      className="rounded-full p-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={t("downloadImage")}
                      title={t("downloadImage")}
                    >
                      <Download className="size-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {view.error ? (
            <div
              role="alert"
              className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-destructive"
            >
              <div className="flex items-center gap-1.5 font-medium">
                <AlertCircle className="size-3.5" aria-hidden="true" />
                {view.error.code ?? "BROWSER_ERROR"}
              </div>
              {view.error.message ? <div>{view.error.message}</div> : null}
              {view.error.recovery ? (
                <div className="flex items-center gap-1 text-muted-foreground">
                  <RotateCcw className="size-3" aria-hidden="true" />
                  {view.error.recovery}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </ToolContent>

      <ImagePreviewDialog
        src={
          previewImage
            ? `data:${previewImage.mime_type};base64,${previewImage.data}`
            : ""
        }
        alt={
          previewIndex === null ? "" : `Browser screenshot ${previewIndex + 1}`
        }
        open={previewImage !== null}
        onOpenChange={(next) => {
          if (!next) setPreviewIndex(null)
        }}
        onDownload={
          previewIndex === null
            ? undefined
            : () => void handleDownload(previewIndex)
        }
        downloadLabel={t("downloadImage")}
      />
    </Tool>
  )
})
