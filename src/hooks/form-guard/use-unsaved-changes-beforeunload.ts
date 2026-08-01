'use client'

import { useEffect, useRef } from 'react'

/**
 * useUnsavedChangesBeforeunload
 *
 * Registers the native `beforeunload` event listener when `hasUnsavedChanges`
 * is true. Browsers do not allow custom messages here — only the browser's
 * generic confirmation dialog will appear. This is a platform limitation.
 *
 * When `hasUnsavedChanges` is false, the listener is removed so clean forms
 * allow reload/navigation with zero interruption.
 */
export function useUnsavedChangesBeforeunload(hasUnsavedChanges: boolean): void {
  const hasUnsavedChangesRef = useRef(hasUnsavedChanges)

  // Keep the ref in sync so the event listener always sees the latest value
  useEffect(() => {
    hasUnsavedChangesRef.current = hasUnsavedChanges
  }, [hasUnsavedChanges])

  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (!hasUnsavedChangesRef.current) return
      // Standard way to trigger the browser's confirmation dialog
      e.preventDefault()
      e.returnValue = ''
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])
}
