/**
 * Inbound Telegram images for the console surface.
 *
 * Telegram delivers one photo as several renditions of the same picture and
 * documents with a declared MIME type. This module picks the rendition worth
 * fetching, keeps only the image kinds the harness attachment store admits
 * (`image/png`, `image/jpeg`, `image/webp`, `image/gif`) and turns downloaded
 * bytes into a prompt content part — the same `sessions.prompt` shape the web
 * composer sends. Everything here is pure, so routing tests need neither a
 * live bot nor the network.
 * @module @maotsk/dsh-host-telegram/inbound-media
 */

import type { PromptContentPart } from './apiproxy-shim.ts'

/** Image media types the harness attachment store admits. */
export type SupportedImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Every accepted media type, in the order the replies list them. */
export const SUPPORTED_IMAGE_MEDIA_TYPES: readonly SupportedImageMediaType[] =
  ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Telegram's documented bot-download ceiling (`getFile`). */
export const TELEGRAM_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024

/** One photo rendition as the Bot API reports it. */
export interface TelegramPhotoSize {
  file_id: string
  file_size?: number
  width?: number
  height?: number
}

/** The document fields this surface reads. */
export interface TelegramDocument {
  file_id: string
  mime_type?: string
  file_name?: string
  file_size?: number
}

/** The message fields that can carry an image. */
export interface TelegramMediaMessage {
  photo?: readonly TelegramPhotoSize[]
  document?: TelegramDocument
}

/** One image to fetch: the Bot API file id plus the media type it will carry. */
export interface InboundImageFile {
  fileId: string
  mediaType: SupportedImageMediaType
  name?: string
  /** Byte size as Telegram declared it, when it did. */
  bytes?: number
}

/**
 * The harness media type of one declared MIME.
 * @param mime - the `mime_type` Telegram declared (or nothing for photos).
 * @returns the accepted media type, or undefined when the harness would reject it.
 */
export function imageMediaType(mime: string | undefined | null): SupportedImageMediaType | undefined {
  const normalized = String(mime ?? '').trim().toLowerCase()
  return (SUPPORTED_IMAGE_MEDIA_TYPES as readonly string[]).includes(normalized)
    ? normalized as SupportedImageMediaType
    : undefined
}

/**
 * The largest rendition of a photo message. Telegram repeats the same picture
 * at ascending sizes, so the last entry is the one worth downloading.
 * @param message - the inbound message.
 * @returns the file to fetch, or undefined for a message without a photo.
 */
export function photoImageFile(message: TelegramMediaMessage): InboundImageFile | undefined {
  const sizes = message.photo ?? []
  const largest = sizes[sizes.length - 1]
  if (largest === undefined) return undefined
  return {
    fileId: largest.file_id,
    mediaType: 'image/jpeg',
    name: 'photo.jpg',
    ...(largest.file_size === undefined ? {} : { bytes: largest.file_size }),
  }
}

/**
 * The image a document message carries, when its declared MIME is accepted.
 * @param message - the inbound message.
 * @returns the file to fetch, or undefined for a non-image document.
 */
export function documentImageFile(message: TelegramMediaMessage): InboundImageFile | undefined {
  const document = message.document
  if (document === undefined) return undefined
  const mediaType = imageMediaType(document.mime_type)
  if (mediaType === undefined) return undefined
  return {
    fileId: document.file_id,
    mediaType,
    ...(document.file_name === undefined ? {} : { name: document.file_name }),
    ...(document.file_size === undefined ? {} : { bytes: document.file_size }),
  }
}

/**
 * Whether a declared size fits Telegram's own download ceiling.
 * @param bytes - the declared size, or undefined when Telegram omitted it.
 * @returns true when the file is worth requesting.
 */
export function withinTelegramLimit(bytes: number | undefined): boolean {
  return bytes === undefined || bytes <= TELEGRAM_DOWNLOAD_MAX_BYTES
}

/**
 * One downloaded image as the prompt part `sessions.prompt` takes.
 * @param image - the fetched bytes plus the media type they carry.
 * @returns the base64 image content part.
 */
export function imagePart(image: { mediaType: SupportedImageMediaType, data: Uint8Array, name?: string }): PromptContentPart {
  return {
    type: 'image',
    mediaType: image.mediaType,
    data: Buffer.from(image.data).toString('base64'),
    ...(image.name === undefined ? {} : { name: image.name }),
  }
}
