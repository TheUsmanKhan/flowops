'use client'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Loader2, Save, Trash2, Pencil } from 'lucide-react'

export interface UnsavedChangesModalProps {
  open: boolean
  onSaveDraft: () => void
  onDiscard: () => void
  onKeepEditing: () => void
  isSaving: boolean
}

/**
 * Unsaved Changes confirmation modal.
 *
 * Three actions:
 *   - Save as Draft (primary) — calls onSaveDraft, shows spinner while saving
 *   - Discard Changes (destructive) — calls onDiscard
 *   - Keep Editing (ghost) — calls onKeepEditing, closes modal
 *
 * Responsive: buttons stack vertically on mobile, horizontal on desktop.
 * Uses AlertDialog (not Dialog) to match the existing confirmation pattern.
 */
export function UnsavedChangesModal({
  open,
  onSaveDraft,
  onDiscard,
  onKeepEditing,
  isSaving,
}: UnsavedChangesModalProps) {
  return (
    <AlertDialog open={open}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
          <AlertDialogDescription>
            You have unsaved changes that will be lost if you leave this page.
            Save your progress as a draft, discard the changes, or keep editing.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-col sm:flex-row gap-2 sm:gap-2">
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault()
              onSaveDraft()
            }}
            disabled={isSaving}
            className="sm:mr-auto"
          >
            {isSaving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Saving…
              </>
            ) : (
              <>
                <Save className="h-4 w-4" /> Save as Draft
              </>
            )}
          </AlertDialogAction>
          <AlertDialogCancel
            onClick={onKeepEditing}
            disabled={isSaving}
            className="sm:order-first"
          >
            <Pencil className="h-4 w-4" /> Keep Editing
          </AlertDialogCancel>
          <button
            type="button"
            onClick={onDiscard}
            disabled={isSaving}
            className="inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors px-4 py-2 text-rose-600 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" /> Discard
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
