'use client'

import { useCallback, useRef } from 'react'
import { useMutation, type UseMutationOptions, type UseMutationResult } from '@tanstack/react-query'
import { api } from '@/lib/api-client'

/**
 * Shared idempotent mutation hook for creation endpoints.
 *
 * Wraps useMutation with automatic idempotency-key generation and injection.
 * The key is generated ONCE per component instance (useRef) and sent as the
 * `Idempotency-Key` header on every submission attempt. The server uses this
 * key to guarantee only ONE successful creation happens, even under genuine
 * concurrent double-clicks.
 *
 * Key semantics:
 * - The key persists across re-renders (useRef) but is fresh per mount.
 *   When the component unmounts (e.g., navigating away after success) and
 *   remounts (e.g., opening a fresh create form), a new key is generated
 *   automatically — no manual reset needed.
 * - For "stay on this form after success" patterns (e.g., "Create & Add
 *   Another"), call `regenerateKey()` after a successful submission to get
 *   a fresh key for the next record.
 *
 * Usage (drop-in replacement for useMutation in creation flows):
 * ```typescript
 * const mutation = useIdempotentMutation({
 *   url: '/api/orders',
 *   onSuccess: (data) => { ... },
 *   onError: (err) => { ... },
 * })
 *
 * // In the submit handler:
 * mutation.mutate(orderData)
 *
 * // Disable the submit button while pending:
 * <Button disabled={mutation.isPending}>Create Order</Button>
 *
 * // For "Create & Add Another" patterns:
 * if (mutation.isSuccess) {
 *   mutation.regenerateKey()
 *   mutation.reset()
 * }
 * ```
 */

interface UseIdempotentMutationParams<TData, TVariables> {
  /** The API URL to POST to (e.g., '/api/orders'). */
  url: string
  /** Standard useMutation options (onSuccess, onError, etc.). */
  mutationOptions?: Omit<UseMutationOptions<TData, Error, TVariables>, 'mutationFn'>
}

interface UseIdempotentMutationResult<TData, TVariables>
  extends Omit<UseMutationResult<TData, Error, TVariables>, 'mutate'> {
  /** The current idempotency key (for debugging/display if needed). */
  idempotencyKey: string
  /** Regenerate the idempotency key (for "Create & Add Another" patterns). */
  regenerateKey: () => void
  /** Same as useMutation's mutate, but automatically injects the idempotency key header. */
  mutate: (variables: TVariables) => void
  mutateAsync: (variables: TVariables) => Promise<TData>
}

export function useIdempotentMutation<TData, TVariables = unknown>({
  url,
  mutationOptions,
}: UseIdempotentMutationParams<TData, TVariables>): UseIdempotentMutationResult<TData, TVariables> {
  // Generate the idempotency key ONCE per component instance.
  // useRef ensures it survives re-renders without regenerating.
  // A fresh key is generated automatically when the component remounts
  // (new useRef initialization).
  const keyRef = useRef<string>(crypto.randomUUID())

  const regenerateKey = useCallback(() => {
    keyRef.current = crypto.randomUUID()
  }, [])

  const mutation = useMutation<TData, Error, TVariables>({
    ...mutationOptions,
    mutationFn: async (variables: TVariables) => {
      return api.post<TData>(url, variables, {
        'Idempotency-Key': keyRef.current,
      })
    },
  })

  // Read the ref inside a callback so we don't access it during render
  // (React Compiler flags direct ref access during render).
  const getIdempotencyKey = useCallback(() => keyRef.current, [])

  return {
    ...mutation,
    get idempotencyKey() {
      return getIdempotencyKey()
    },
    regenerateKey,
    // Wrap mutate to match the signature (variables only, no extra options needed)
    mutate: (variables: TVariables) => mutation.mutate(variables),
    mutateAsync: (variables: TVariables) => mutation.mutateAsync(variables),
  }
}
