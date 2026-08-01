'use client'

import { useState, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { api, FetchError } from '@/lib/api-client'
import { useUnsavedChangesBeforeunload } from './use-unsaved-changes-beforeunload'
import { useNavigationInterceptor } from './use-navigation-interceptor'
import { useBrowserBackGuard } from './use-browser-back-guard'
import { UnsavedChangesModal } from '@/components/shared/unsaved-changes-modal'

export interface UseFormGuardOptions {
  /** Whether the form has unsaved changes (from RHF formState.isDirty or manual tracking) */
  isDirty: boolean
  /** Async function to save the form as a draft. Called when user clicks "Save as Draft". */
  onSaveDraft: () => Promise<void>
}

export interface UseFormGuardResult {
  /** Pre-wired confirmation modal — render at the form's root level */
  ConfirmModal: React.ReactNode
  /** Wrap any navigation action (sidebar link click, programmatic redirect) */
  attemptNavigation: (action: () => void) => void
}

/**
 * useFormGuard — the single public hook that composes all three interception
 * points (beforeunload, in-app navigation, browser back/forward) into one
 * unified confirmation modal.
 *
 * Usage:
 *   const { ConfirmModal, attemptNavigation } = useFormGuard({
 *     isDirty: form.formState.isDirty,
 *     onSaveDraft: async () => { await saveDraftAPI(form.getValues()) },
 *   })
 *
 *   // In JSX:
 *   <button onClick={() => attemptNavigation(() => navigate({ name: 'products' }))}>
 *     Back to Products
 *   </button>
 *   {ConfirmModal}
 */
export function useFormGuard(options: UseFormGuardOptions): UseFormGuardResult {
  const { isDirty, onSaveDraft } = options
  const [isSaving, setIsSaving] = useState(false)

  // 1. Browser-level exit (reload, tab close)
  useUnsavedChangesBeforeunload(isDirty)

  // 2. In-app navigation interceptor
  const navInterceptor = useNavigationInterceptor()

  // 3. Browser back/forward guard — triggers the same modal as in-app nav
  const handleBackAttempt = useCallback(() => {
    navInterceptor.attemptNavigation(() => {
      // If confirmed, perform the back navigation
      window.history.back()
    }, true)
  }, [navInterceptor])

  useBrowserBackGuard(isDirty, handleBackAttempt)

  // Modal action handlers
  const handleDiscard = useCallback(() => {
    // Clear the intercepting flag before proceeding
    if (typeof window !== 'undefined') {
      window.__formGuardIntercepting = false
    }
    navInterceptor.resolvePendingNavigation('discard')
  }, [navInterceptor])

  const handleKeepEditing = useCallback(() => {
    // Clear the intercepting flag — user chose to stay
    if (typeof window !== 'undefined') {
      window.__formGuardIntercepting = false
    }
    navInterceptor.resolvePendingNavigation('cancel')
  }, [navInterceptor])

  const handleSaveDraft = useCallback(async () => {
    setIsSaving(true)
    try {
      await onSaveDraft()
      toast.success('Draft saved.')
      // Clear the intercepting flag before proceeding
      if (typeof window !== 'undefined') {
        window.__formGuardIntercepting = false
      }
      // After saving, proceed with the pending navigation
      navInterceptor.resolvePendingNavigation('discard')
    } catch (err) {
      // Don't close the modal — let the user retry or choose another option
      toast.error(err instanceof FetchError ? err.message : 'Failed to save draft. Please try again.')
    } finally {
      setIsSaving(false)
    }
  }, [onSaveDraft, navInterceptor])

  // Wrap attemptNavigation so callers don't need to pass isDirty
  const attemptNavigation = useCallback(
    (action: () => void) => {
      navInterceptor.attemptNavigation(action, isDirty)
    },
    [navInterceptor, isDirty],
  )

  // Pre-wired modal — ready to render
  const ConfirmModal = useMemo(
    () => (
      <UnsavedChangesModal
        open={navInterceptor.isBlocked}
        onSaveDraft={handleSaveDraft}
        onDiscard={handleDiscard}
        onKeepEditing={handleKeepEditing}
        isSaving={isSaving}
      />
    ),
    [navInterceptor.isBlocked, handleSaveDraft, handleDiscard, handleKeepEditing, isSaving],
  )

  return { ConfirmModal, attemptNavigation }
}
