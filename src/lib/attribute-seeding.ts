import { db } from '@/lib/db'

/**
 * Seeds default attributes for a new organization.
 * Called automatically at the end of createOrganization().
 *
 * Creates 4 attributes (Piece Type, Size, Color, Fabric) with sensible
 * starter values, plus the "Unstitched → One Size" conditional rule.
 *
 * These are just defaults — fully editable, deletable, extensible afterward.
 */
export async function seedDefaultAttributes(
  organizationId: string,
  createdById: string,
): Promise<void> {
  // 1. Piece Type attribute (display_order: 1)
  const pieceTypeAttr = await db.orgAttribute.create({
    data: {
      organizationId,
      name: 'Piece Type',
      displayName: 'Select Piece Type',
      attributeType: 'select',
      displayOrder: 1,
      createdById,
      values: {
        create: [
          { organizationId, value: 'Unstitched', displayValue: 'Unstitched', skuCode: 'UNST', displayOrder: 1 },
          { organizationId, value: 'Stitched', displayValue: 'Stitched', skuCode: 'ST', displayOrder: 2 },
        ],
      },
    },
    include: { values: true },
  })

  // 2. Size attribute (display_order: 2) — includes "One Size"
  const sizeAttr = await db.orgAttribute.create({
    data: {
      organizationId,
      name: 'Size',
      displayName: 'Select Size',
      attributeType: 'select',
      displayOrder: 2,
      createdById,
      values: {
        create: [
          { organizationId, value: 'One Size', displayValue: 'One Size', skuCode: 'OS', displayOrder: 1 },
          { organizationId, value: 'XS', displayValue: 'XS', skuCode: 'XS', displayOrder: 2 },
          { organizationId, value: 'S', displayValue: 'S', skuCode: 'S', displayOrder: 3 },
          { organizationId, value: 'M', displayValue: 'M', skuCode: 'M', displayOrder: 4 },
          { organizationId, value: 'L', displayValue: 'L', skuCode: 'L', displayOrder: 5 },
          { organizationId, value: 'XL', displayValue: 'XL', skuCode: 'XL', displayOrder: 6 },
          { organizationId, value: 'XXL', displayValue: 'XXL', skuCode: 'XXL', displayOrder: 7 },
          { organizationId, value: 'XXXL', displayValue: 'XXXL', skuCode: 'XXXL', displayOrder: 8 },
        ],
      },
    },
    include: { values: true },
  })

  // 3. Color attribute (display_order: 3)
  await db.orgAttribute.create({
    data: {
      organizationId,
      name: 'Color',
      displayName: 'Select Color',
      attributeType: 'color',
      displayOrder: 3,
      createdById,
      values: {
        create: [
          { organizationId, value: 'Red', displayValue: 'Red', skuCode: 'RED', colorHex: '#FF0000', displayOrder: 1 },
          { organizationId, value: 'Navy Blue', displayValue: 'Navy', skuCode: 'NAVY', colorHex: '#003087', displayOrder: 2 },
          { organizationId, value: 'Black', displayValue: 'Black', skuCode: 'BLACK', colorHex: '#000000', displayOrder: 3 },
          { organizationId, value: 'White', displayValue: 'White', skuCode: 'WHITE', colorHex: '#FAF9F6', displayOrder: 4 },
          { organizationId, value: 'Maroon', displayValue: 'Maroon', skuCode: 'MRN', colorHex: '#800000', displayOrder: 5 },
          { organizationId, value: 'Bottle Green', displayValue: 'Green', skuCode: 'GRN', colorHex: '#006A4E', displayOrder: 6 },
          { organizationId, value: 'Golden', displayValue: 'Golden', skuCode: 'GOLD', colorHex: '#D4AF37', displayOrder: 7 },
          { organizationId, value: 'Baby Pink', displayValue: 'Pink', skuCode: 'PINK', colorHex: '#F4C2C2', displayOrder: 8 },
          { organizationId, value: 'Sky Blue', displayValue: 'Sky Blue', skuCode: 'SKYBLUE', colorHex: '#87CEEB', displayOrder: 9 },
          { organizationId, value: 'Beige', displayValue: 'Beige', skuCode: 'BEIGE', colorHex: '#F5F5DC', displayOrder: 10 },
        ],
      },
    },
  })

  // 4. Fabric attribute (display_order: 4)
  await db.orgAttribute.create({
    data: {
      organizationId,
      name: 'Fabric',
      displayName: 'Select Fabric',
      attributeType: 'select',
      displayOrder: 4,
      createdById,
      values: {
        create: ['Lawn', 'Khaddar', 'Cotton', 'Silk', 'Chiffon', 'Linen', 'Georgette', 'Organza'].map((f, i) => ({
          organizationId,
          value: f,
          displayValue: f,
          skuCode: f.toUpperCase().replace(/\s+/g, ''),
          displayOrder: i + 1,
        })),
      },
    },
  })

  // 5. Create the "Unstitched → One Size" conditional rule
  const unstitchedValue = pieceTypeAttr.values.find((v) => v.value === 'Unstitched')
  const oneSizeValue = sizeAttr.values.find((v) => v.value === 'One Size')
  if (unstitchedValue && oneSizeValue) {
    await db.attributeValueRule.create({
      data: {
        organizationId,
        triggerAttributeValueId: unstitchedValue.id,
        forcesAttributeId: sizeAttr.id,
        forcesValueId: oneSizeValue.id,
      },
    })
  }
}
