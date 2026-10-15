/**
 * Inbound image helpers: rendition pick, MIME filter, limits, and the
 * byte → prompt-part conversion.
 */

import { describe, expect, it } from 'vitest'
import {
  SUPPORTED_IMAGE_MEDIA_TYPES,
  TELEGRAM_DOWNLOAD_MAX_BYTES,
  documentImageFile,
  imageMediaType,
  imagePart,
  photoImageFile,
  withinTelegramLimit,
} from '../src/inbound-media.ts'

describe('imageMediaType', () => {
  it('accepts exactly the media types the harness admits, case-insensitively', () => {
    expect(SUPPORTED_IMAGE_MEDIA_TYPES).toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
    expect(imageMediaType('image/JPEG')).toBe('image/jpeg')
    expect(imageMediaType(' Image/WebP ')).toBe('image/webp')
  })

  it('rejects everything else, including absent MIME types', () => {
    expect(imageMediaType('application/pdf')).toBeUndefined()
    expect(imageMediaType('image/svg+xml')).toBeUndefined()
    expect(imageMediaType(undefined)).toBeUndefined()
    expect(imageMediaType(null)).toBeUndefined()
    expect(imageMediaType('')).toBeUndefined()
  })
})

describe('photoImageFile', () => {
  it('picks the largest rendition Telegram listed', () => {
    const file = photoImageFile({
      photo: [
        { file_id: 'small', file_size: 100, width: 90, height: 60 },
        { file_id: 'large', file_size: 9000, width: 1280, height: 853 },
      ],
    })
    expect(file).toEqual({ fileId: 'large', mediaType: 'image/jpeg', name: 'photo.jpg', bytes: 9000 })
  })

  it('returns nothing for a message without a photo', () => {
    expect(photoImageFile({})).toBeUndefined()
    expect(photoImageFile({ photo: [] })).toBeUndefined()
  })
})

describe('documentImageFile', () => {
  it('carries the declared image MIME and file name', () => {
    expect(documentImageFile({
      document: { file_id: 'doc', mime_type: 'image/png', file_name: 'shot.png', file_size: 42 },
    })).toEqual({ fileId: 'doc', mediaType: 'image/png', name: 'shot.png', bytes: 42 })
  })

  it('ignores documents the harness cannot accept', () => {
    expect(documentImageFile({ document: { file_id: 'doc', mime_type: 'application/pdf' } })).toBeUndefined()
    expect(documentImageFile({ document: { file_id: 'doc' } })).toBeUndefined()
    expect(documentImageFile({})).toBeUndefined()
  })
})

describe('withinTelegramLimit', () => {
  it('allows unknown sizes and the documented ceiling itself', () => {
    expect(withinTelegramLimit(undefined)).toBe(true)
    expect(withinTelegramLimit(TELEGRAM_DOWNLOAD_MAX_BYTES)).toBe(true)
    expect(withinTelegramLimit(TELEGRAM_DOWNLOAD_MAX_BYTES + 1)).toBe(false)
  })
})

describe('imagePart', () => {
  it('base64-encodes the bytes and keeps the name when there is one', () => {
    expect(imagePart({ mediaType: 'image/png', data: new Uint8Array([1, 2, 3]), name: 'a.png' }))
      .toEqual({ type: 'image', mediaType: 'image/png', data: 'AQID', name: 'a.png' })
    expect(imagePart({ mediaType: 'image/jpeg', data: new Uint8Array([]) }))
      .toEqual({ type: 'image', mediaType: 'image/jpeg', data: '' })
  })
})
