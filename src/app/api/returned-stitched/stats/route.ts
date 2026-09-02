import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Stats for the returned stitched inventory page header. */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

    const [available, totalValue, writtenOffThisMonth] = await Promise.all([
      db.returnedStitchedInventory.aggregate({
        where: { companyId, status: 'available' },
        _sum: { quantity: true },
      }),
      db.returnedStitchedInventory.aggregate({
        where: { companyId, status: 'available' },
        _sum: { totalCost: true },
      }),
      db.returnedStitchedInventory.count({
        where: {
          companyId,
          status: 'written_off',
          writtenOffAt: { gte: startOfMonth },
        },
      }),
    ])

    return Response.json({
      availableCount: available._sum.quantity ?? 0,
      totalValue: Number(totalValue._sum.totalCost ?? 0),
      writtenOffThisMonth,
    })
  } catch (err) {
    return handleError(err)
  }
}
