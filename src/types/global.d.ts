/**
 * Global type declarations for FlowOps.
 *
 * Extends the Window interface with custom properties used by
 * the Unsaved Changes Guard system.
 */

declare global {
  interface Window {
    /**
     * Set to `true` by use-browser-back-guard when it intercepts a
     * popstate event (browser back/forward while a form is dirty).
     * The page-level popstate handler (URL sync) checks this flag
     * and skips its sync logic to avoid fighting the guard.
     * Cleared by use-form-guard when the modal is resolved.
     */
    __formGuardIntercepting?: boolean
  }
}

export {}
