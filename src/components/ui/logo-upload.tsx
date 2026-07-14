'use client'

import { useState, useRef } from 'react'
import { Loader2, Upload, X } from 'lucide-react'
import { InitialsAvatar } from '@/components/ui/initials-avatar'
import { cn } from '@/lib/utils'

/**
 * Reusable logo upload field.
 * Uploads to /api/upload?type={type}&id={id} and calls onChange with the URL.
 * Shows a circular preview; supports removal.
 *
 * IMPORTANT: Real error messages from the server are surfaced — never
 * swallowed into a generic "Upload failed".
 */
export function LogoUpload({
  type,
  id,
  name,
  currentUrl,
  onChange,
  size = 120,
  disabled,
}: {
  type: 'organizations' | 'companies' | 'avatars'
  id: string
  name: string
  currentUrl: string | null
  onChange: (url: string | null) => void
  size?: number
  disabled?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleFile(file: File) {
    setError(null)

    // Client-side validation before upload attempt
    if (file.size > 2 * 1024 * 1024) {
      setError('File too large. Maximum 2 MB.')
      return
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Only JPG, PNG, and WebP images are allowed.')
      return
    }

    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`/api/upload?type=${type}&id=${id}`, {
        method: 'POST',
        body: fd,
      })

      const text = await res.text()
      let body: unknown = null
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          body = text
        }
      }

      if (!res.ok) {
        // Surface the REAL error message from the server
        const message =
          body && typeof body === 'object' && 'error' in body
            ? String((body as { error: unknown }).error)
            : typeof body === 'string'
              ? body
              : `Upload failed (HTTP ${res.status})`
        throw new Error(message)
      }

      const { url } = body as { url: string }
      onChange(url)
    } catch (e) {
      // Surface the actual error, not a generic message
      const msg = e instanceof Error ? e.message : 'Network error during upload'
      setError(msg)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative group" style={{ width: size, height: size }}>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || uploading}
          className={cn(
            'relative w-full h-full rounded-full overflow-hidden border-2 border-dashed border-border hover:border-primary/50 transition-colors flex items-center justify-center bg-muted/30',
            currentUrl && 'border-solid',
            (disabled || uploading) && 'opacity-60 cursor-not-allowed',
          )}
        >
          {currentUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={currentUrl}
              alt={`${name} logo`}
              className="w-full h-full object-cover"
            />
          ) : uploading ? (
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          ) : (
            <div className="flex flex-col items-center gap-1 text-muted-foreground">
              {name ? (
                <InitialsAvatar name={name} id={id} size="lg" rounded className="!h-full !w-full !rounded-full opacity-30" />
              ) : (
                <Upload className="h-5 w-5" />
              )}
            </div>
          )}
          {!disabled && !uploading && (
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center text-white text-xs gap-1">
              <Upload className="h-4 w-4" />
              <span>Upload</span>
            </div>
          )}
        </button>
        {currentUrl && !disabled && (
          <button
            type="button"
            onClick={() => {
              setError(null)
              onChange(null)
            }}
            className="absolute -top-1 -right-1 h-6 w-6 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center shadow-sm hover:scale-110 transition-transform"
            aria-label="Remove logo"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) handleFile(f)
            e.target.value = ''
          }}
        />
      </div>
      {error && (
        <p className="text-xs text-destructive text-center max-w-[200px]">{error}</p>
      )}
      <p className="text-xs text-muted-foreground text-center">
        {currentUrl ? 'Click to replace' : 'Click or drag to upload'}
        <br />
        JPG, PNG — max 2MB
      </p>
    </div>
  )
}
