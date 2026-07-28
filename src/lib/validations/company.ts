import { z } from 'zod'

export const createCompanySchema = z.object({
  orgName: z.string().min(2, 'Organization name is required').max(80),
  companyName: z.string().min(2, 'Company name is required').max(80),
  legalName: z.string().max(120).optional().or(z.literal('')),
  taxId: z.string().max(40).optional().or(z.literal('')),
  taxIdType: z.enum(['NTN', 'STRN']).optional(),
  baseCurrency: z.string().min(3).max(3).default('PKR'),
  countryCode: z.string().min(2).max(2).default('PK'),
  province: z.string().max(80).optional().or(z.literal('')),
  city: z.string().max(80).optional().or(z.literal('')),
  addressStreet: z.string().max(160).optional().or(z.literal('')),
  postalCode: z.string().max(20).optional().or(z.literal('')),
  timezone: z.string().default('Asia/Karachi'),
})
export type CreateCompanyInput = z.infer<typeof createCompanySchema>

export const updateCompanySchema = z.object({
  name: z.string().min(2).max(80).optional(),
  legalName: z.string().max(120).optional().or(z.literal('')),
  taxId: z.string().max(40).optional().or(z.literal('')),
  taxIdType: z.enum(['NTN', 'STRN']).optional(),
  baseCurrency: z.string().min(3).max(3).optional(),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().max(40).optional().or(z.literal('')),
  website: z.string().max(160).optional().or(z.literal('')),
  addressStreet: z.string().max(160).optional().or(z.literal('')),
  addressCity: z.string().max(80).optional().or(z.literal('')),
  addressProvince: z.string().max(80).optional().or(z.literal('')),
  addressPostalCode: z.string().max(20).optional().or(z.literal('')),
  addressCountry: z.string().max(2).optional().or(z.literal('')),
  // These fields exist on the Company model and are used by the PATCH route;
  // they were missing from the schema, causing TS errors when the route
  // handler referenced them.
  countryCode: z.string().min(2).max(2).optional(),
  timezone: z.string().max(50).optional(),
  fiscalYearStart: z.number().int().min(1).max(12).optional(),
  logoUrl: z.string().url().optional().or(z.literal('')),
})
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>
