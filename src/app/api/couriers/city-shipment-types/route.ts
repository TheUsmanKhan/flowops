import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/couriers/city-shipment-types?providerKey=leopard&cityName=Lahore
 *
 * Returns the shipmentTypes array for a specific city from
 * courier_operational_cities. Used by the Order Creation form and
 * Send Exchange Shipment modal to populate the Leopard-specific
 * Shipment Type dropdown.
 *
 * Returns: { shipmentTypes: string[] } (empty array if city not found or
 * shipmentTypes is NULL — caller should show "no options" gracefully)
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')

    const url = new URL(req.url)
    const providerKey = url.searchParams.get('providerKey')
    const cityName = url.searchParams.get('cityName')

    if (!providerKey || !cityName) {
      throw new ApiError(400, 'providerKey and cityName query parameters are required')
    }

    const city = await db.courierOperationalCity.findFirst({
      where: {
        providerKey,
        cityName: { equals: cityName, mode: 'insensitive' },
      },
      select: { shipmentTypes: true },
    })

    if (!city?.shipmentTypes) {
      return Response.json({ shipmentTypes: [] })
    }

    let shipmentTypes: string[] = []
    try {
      shipmentTypes = JSON.parse(city.shipmentTypes)
    } catch {
      shipmentTypes = []
    }

    return Response.json({ shipmentTypes })
  } catch (err) {
    return handleError(err)
  }
}
