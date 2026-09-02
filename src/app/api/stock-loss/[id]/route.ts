import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Get a single stock loss record with full detail. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const { id } = await params
    const record = await db.stockLossRecord.findFirst({
      where: { id, companyId },
      include: {
        orgVariant: { select: { id: true, sku: true, product: { select: { title: true } } } },
        location: { select: { id: true, name: true } },
        reportedBy: { select: { user: { select: { fullName: true } } } },
        resolvedBy: { select: { user: { select: { fullName: true } } } },
        inventoryTxn: { select: { id: true, quantity: true, costPerUnit: true, recordedAt: true } },
        supplierReturn: {
          select: {
            id: true,
            supplier: { select: { name: true } },
            reason: true,
            status: true,
            quantity: true,
            costPerUnit: true,
          },
        },
      },
    })
    if (!record) throw new ApiError(404, 'Stock loss record not found.')

    return Response.json({
      record: {
        id: record.id,
        lossType: record.lossType,
        subType: record.subType,
        damageType: record.damageType,
        quantity: record.quantity,
        costPerUnit: Number(record.costPerUnit),
        totalLossValue: Number(record.costPerUnit) * record.quantity,
        investigationStatus: record.investigationStatus,
        resolution: record.resolution,
        responsibleParty: record.responsibleParty,
        policeReportRef: record.policeReportRef,
        insuranceClaimRef: record.insuranceClaimRef,
        insuranceRecovered: Number(record.insuranceRecovered),
        courierClaimRef: record.courierClaimRef,
        courierClaimStatus: record.courierClaimStatus,
        courierRecovered: Number(record.courierRecovered),
        evidenceUrls: JSON.parse(record.evidenceUrls),
        notes: record.notes,
        orderReferenceId: record.orderReferenceId,
        supplierReturnId: record.supplierReturnId,
        variant: {
          id: record.orgVariant.id,
          sku: record.orgVariant.sku,
          productTitle: record.orgVariant.product.title,
        },
        location: record.location,
        reportedBy: record.reportedBy.user.fullName,
        resolvedBy: record.resolvedBy?.user.fullName ?? null,
        inventoryTxn: record.inventoryTxn
          ? {
              id: record.inventoryTxn.id,
              quantity: record.inventoryTxn.quantity,
              costPerUnit: Number(record.inventoryTxn.costPerUnit),
              recordedAt: record.inventoryTxn.recordedAt.toISOString(),
            }
          : null,
        supplierReturn: record.supplierReturn
          ? {
              id: record.supplierReturn.id,
              supplierName: record.supplierReturn.supplier.name,
              reason: record.supplierReturn.reason,
              status: record.supplierReturn.status,
              quantity: record.supplierReturn.quantity,
              costPerUnit: Number(record.supplierReturn.costPerUnit),
            }
          : null,
        createdAt: record.createdAt.toISOString(),
        resolvedAt: record.resolvedAt?.toISOString() ?? null,
      },
    })
  } catch (err) {
    return handleError(err)
  }
}
