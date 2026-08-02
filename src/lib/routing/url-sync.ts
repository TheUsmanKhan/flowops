'use client'

import { type AppRoute } from '@/stores/app-store'

/**
 * URL Sync Utility — Strategy B (Query-String Navigation)
 *
 * Serializes the Zustand route state into a URL query string and vice versa,
 * so that the browser's back/forward buttons, bookmarks, and hard refreshes
 * all correctly restore the user's current view.
 *
 * URL format: /?view=<route_name>&id=<optional_id>&token=<optional_token>&orgId=<optional_orgId>
 *
 * Examples:
 *   /?view=dashboard                     → { name: 'dashboard' }
 *   /?view=orders                        → { name: 'orders' }
 *   /?view=order-detail&id=abc123        → { name: 'order-detail', id: 'abc123' }
 *   /?view=reset&token=xyz               → { name: 'reset', token: 'xyz' }
 *   /?view=create-company&orgId=org123   → { name: 'create-company', orgId: 'org123' }
 *   /                                    → { name: 'login' } (default when no query)
 */

/**
 * Serialize an AppRoute into a URL query string.
 * Returns just the query portion (e.g. "?view=orders&id=abc123") or empty string.
 */
export function routeToQuery(route: AppRoute): string {
  const params = new URLSearchParams()
  params.set('view', route.name)

  if ('id' in route && route.id) {
    params.set('id', route.id)
  }
  if ('token' in route && route.token) {
    params.set('token', route.token)
  }
  if ('orgId' in route && route.orgId) {
    params.set('orgId', route.orgId)
  }
  if ('draftId' in route && route.draftId) {
    params.set('draftId', route.draftId)
  }

  return `?${params.toString()}`
}

/**
 * Deserialize the current window.location.search into an AppRoute.
 * Returns null if no valid route is found in the URL.
 */
export function queryToRoute(): AppRoute | null {
  if (typeof window === 'undefined') return null

  const params = new URLSearchParams(window.location.search)
  const view = params.get('view')

  if (!view) return null

  const idParam = params.get('id')
  const tokenParam = params.get('token')
  const orgIdParam = params.get('orgId')
  const draftIdParam = params.get('draftId')

  const routesWithId = [
    'employee-detail', 'role-edit', 'product-detail',
    'inventory-location-detail', 'inventory-supplier-detail',
    'inventory-po-detail', 'inventory-loss-detail',
    'order-detail', 'exchange-detail', 'customer-detail',
  ]
  const routesWithToken = ['reset', 'accept-invite']
  const routesWithOrgId = ['create-company']
  const routesWithDraftId = ['product-create', 'order-create']

  if (routesWithId.includes(view) && idParam) {
    return { name: view as AppRoute['name'], id: idParam } as AppRoute
  }
  if (routesWithToken.includes(view) && tokenParam) {
    return { name: view as AppRoute['name'], token: tokenParam } as AppRoute
  }
  if (routesWithOrgId.includes(view)) {
    return { name: view as AppRoute['name'], orgId: orgIdParam || undefined } as AppRoute
  }
  if (routesWithDraftId.includes(view)) {
    return { name: view as AppRoute['name'], draftId: draftIdParam || undefined } as AppRoute
  }

  return { name: view as AppRoute['name'] } as AppRoute
}

/**
 * Push a new URL state (without a full page navigation) to the browser history.
 * Uses window.history.pushState so Next.js doesn't re-render the server component.
 */
export function pushRouteToURL(route: AppRoute): void {
  if (typeof window === 'undefined') return
  const query = routeToQuery(route)
  const newURL = query || '/'
  if (window.location.search !== query) {
    window.history.pushState({ route: JSON.stringify(route) }, '', newURL)
  }
}

/**
 * Replace the current URL state (without adding a history entry).
 * Used for the initial load when restoring from a bookmark/refresh.
 */
export function replaceRouteInURL(route: AppRoute): void {
  if (typeof window === 'undefined') return
  const query = routeToQuery(route)
  const newURL = query || '/'
  window.history.replaceState({ route: JSON.stringify(route) }, '', newURL)
}
