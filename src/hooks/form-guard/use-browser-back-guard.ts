'use client'

import { useEffect, useRef } from 'react'

/**
 * useBrowserBackGuard
 *
 * Intercepts browser back/forward button presses via the `popstate` event.
 *
 * When `hasUnsavedChanges` is true:
 *   1. Immediately re-pushes the current URL onto the history stack to
 *      neutralize the back/forward navigation
 *   2. Invokes `onBeforeLeave` (which triggers the confirmation modal)
 *
 * If the user confirms discard afterward (handled by the caller), the caller
 * performs `window.history.back()` programmatically.
 *
 * When `hasUnsavedChanges` is false: does nothing — normal back/forward works.
 */
export function useBrowserBackGuard(
  hasUnsavedChanges: boolean,
  onBeforeLeave: () => void,
): void {
  const hasUnsavedChangesRef = useRef(hasUnsavedChanges)
  const onBeforeLeaveRef = useRef(onBeforeLeave)

  useEffect(() => {
    hasUnsavedChangesRef.current = hasUnsavedChanges
  }, [hasUnsavedChanges])

  useEffect(() => {
    onBeforeLeaveRef.current = onBeforeLeave
  }, [onBeforeLeave])

  useEffect(() => {
    function handlePopState() {
      if (!hasUnsavedChangesRef.current) return

      // Re-push the current state to neutralize the back/forward navigation
      // This keeps the user on the current page
      window.history.pushState(null, '', window.location.href)

      // Trigger the confirmation modal
      onBeforeLeaveRef.current()
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])
}
