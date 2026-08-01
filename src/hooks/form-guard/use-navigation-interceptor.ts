'use client'

import { useCallback, useState } from 'react'

/**
 * useNavigationInterceptor
 *
 * Manages the state for intercepting in-app navigation (sidebar link clicks,
 * programmatic redirects) when the user has unsaved changes.
 *
 * Exposes:
 *   - isBlocked: whether a confirmation modal should be shown
 *   - attemptNavigation(action): if blocked, stores the action + shows modal;
 *     if not blocked, runs the action immediately
 *   - resolvePendingNavigation(choice): "discard" executes the pending action;
 *     "cancel" clears it
 */

export interface NavigationInterceptorState {
  /** Whether the confirmation modal is currently showing */
  isBlocked: boolean
  /** The pending navigation action to execute if the user confirms */
  pendingAction: (() => void) | null
  /** Attempt to navigate — if dirty, shows the modal; otherwise runs immediately */
  attemptNavigation: (action: () => void, isDirty: boolean) => void
  /** Resolve the pending navigation: "discard" proceeds, "cancel" stays */
  resolvePendingNavigation: (choice: 'discard' | 'cancel') => void
}

export function useNavigationInterceptor(): NavigationInterceptorState {
  const [isBlocked, setIsBlocked] = useState(false)
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null)

  const attemptNavigation = useCallback(
    (action: () => void, isDirty: boolean) => {
      if (isDirty) {
        setPendingAction(() => action)
        setIsBlocked(true)
      } else {
        action()
      }
    },
    [],
  )

  const resolvePendingNavigation = useCallback((choice: 'discard' | 'cancel') => {
    if (choice === 'discard' && pendingAction) {
      pendingAction()
    }
    setPendingAction(null)
    setIsBlocked(false)
  }, [pendingAction])

  return {
    isBlocked,
    pendingAction,
    attemptNavigation,
    resolvePendingNavigation,
  }
}
