import { NextRequest } from 'next/server'
import { handleError, readBody } from '@/lib/workspace'
import {
  listPickupAddresses,
  addPickupAddress,
} from '@/lib/actions/courier-address-book.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/integrations/[id]/pickup-addresses — list saved addresses */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const result = await listPickupAddresses(id)
    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 })
    }
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}

/** POST /api/integrations/[id]/pickup-addresses — add a new address */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await readBody<{
      label: string
      address: string
      cityName: string
      contactPersonName: string
      phone1: string
      phone2?: string
    }>(req)

    if (!body.label || !body.address || !body.cityName || !body.contactPersonName || !body.phone1) {
      return Response.json(
        { error: 'label, address, cityName, contactPersonName, and phone1 are required' },
        { status: 400 },
      )
    }

    const result = await addPickupAddress(id, {
      label: body.label,
      address: body.address,
      cityName: body.cityName,
      contactPersonName: body.contactPersonName,
      phone1: body.phone1,
      phone2: body.phone2,
    })

    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 })
    }
    return Response.json(result.data, { status: 201 })
  } catch (err) {
    return handleError(err)
  }
}
