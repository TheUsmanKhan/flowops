export interface LeopardTransactionNotePrefs {
  enabled: boolean
  includeProductName: boolean
  includeProductCode: boolean
  includeColor: boolean
  includeQuantity: boolean
  position: 'start' | 'end'
  separator: string
}

export interface LeopardPreferences {
  transactionNote: LeopardTransactionNotePrefs
}

export const DEFAULT_LEOPARD_PREFERENCES: LeopardPreferences = {
  transactionNote: {
    enabled: false,
    includeProductName: true,
    includeProductCode: true,
    includeColor: true,
    includeQuantity: true,
    position: 'start',
    separator: ' | ',
  },
}

export function parseLeopardPreferences(json: string | null | undefined): LeopardPreferences {
  if (!json) return DEFAULT_LEOPARD_PREFERENCES
  try {
    const parsed = JSON.parse(json) as Partial<LeopardPreferences>
    return {
      transactionNote: {
        ...DEFAULT_LEOPARD_PREFERENCES.transactionNote,
        ...parsed.transactionNote,
      },
    }
  } catch {
    return DEFAULT_LEOPARD_PREFERENCES
  }
}

export function buildLeopardSpecialInstructions(
  userNotes: string,
  items: Array<{
    productTitle: string
    sku: string
    attributeValues: string | null
    quantity: number
  }>,
  prefs: LeopardTransactionNotePrefs,
): string {
  if (!prefs.enabled) {
    return userNotes.trim()
  }
  const parts: string[] = []
  for (const item of items) {
    const segments: string[] = []
    if (prefs.includeProductName) segments.push(item.productTitle)
    if (prefs.includeProductCode) segments.push(item.sku)
    if (prefs.includeColor) {
      let color: string | null = null
      if (item.attributeValues) {
        try {
          const attrs = JSON.parse(item.attributeValues) as Record<string, string>
          const colorKey = Object.keys(attrs).find(k => k.toLowerCase() === 'color')
          color = colorKey ? attrs[colorKey] : null
        } catch {}
      }
      if (color) segments.push(`Color: ${color}`)
    }
    if (prefs.includeQuantity) segments.push(`×${item.quantity}`)
    parts.push(segments.join(', '))
  }
  const productSummary = parts.join(' | ')
  const trimmedUserNotes = userNotes.trim()
  const sep = prefs.separator || ' | '
  if (!productSummary) return trimmedUserNotes
  if (!trimmedUserNotes) return productSummary
  if (prefs.position === 'start') {
    return `${productSummary}${sep}${trimmedUserNotes}`
  } else {
    return `${trimmedUserNotes}${sep}${productSummary}`
  }
}
