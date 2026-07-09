import { z } from 'zod'

/**
 * Organization & Company validation schemas.
 * Used by create-organization, create-company, and settings pages.
 */

export const createOrganizationSchema = z.object({
  org_name: z.string().min(2, 'Organization name must be at least 2 characters').max(100),
  org_description: z.string().max(500).optional().or(z.literal('')),
  org_website: z.string().url('Enter a valid URL').optional().or(z.literal('')),
  company_name: z.string().min(2, 'Company name must be at least 2 characters').max(100),
  company_legal_name: z.string().max(150).optional().or(z.literal('')),
  base_currency: z.string().length(3, 'Select a currency'),
  country_code: z.string().length(2, 'Select a country'),
  province: z.string().max(80).optional().or(z.literal('')),
  city: z.string().max(80).optional().or(z.literal('')),
  address: z.string().max(200).optional().or(z.literal('')),
  phone: z.string().max(40).optional().or(z.literal('')),
  email: z.string().email('Enter a valid email').optional().or(z.literal('')),
  website: z.string().url('Enter a valid URL').optional().or(z.literal('')),
  ntn: z.string().max(40).optional().or(z.literal('')),
  strn: z.string().max(40).optional().or(z.literal('')),
  timezone: z.string().default('Asia/Karachi'),
  fiscal_year_start: z.number().int().min(1).max(12).default(1),
})
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>

export const createCompanySchema = createOrganizationSchema
  .omit({ org_name: true, org_description: true, org_website: true })
  .extend({ organization_id: z.string().min(1, 'Select an organization') })
export type CreateCompanyInput = z.infer<typeof createCompanySchema>

export const updateCompanySchema = z.object({
  company_id: z.string().min(1),
  name: z.string().min(2).max(100).optional(),
  legalName: z.string().max(150).optional().or(z.literal('')),
  baseCurrency: z.string().length(3).optional(),
  countryCode: z.string().length(2).optional(),
  addressStreet: z.string().max(200).optional().or(z.literal('')),
  addressCity: z.string().max(80).optional().or(z.literal('')),
  addressProvince: z.string().max(80).optional().or(z.literal('')),
  addressPostalCode: z.string().max(20).optional().or(z.literal('')),
  addressCountry: z.string().max(2).optional().or(z.literal('')),
  phone: z.string().max(40).optional().or(z.literal('')),
  email: z.string().email().optional().or(z.literal('')),
  website: z.string().url().optional().or(z.literal('')),
  taxId: z.string().max(40).optional().or(z.literal('')),
  taxIdType: z.enum(['NTN', 'STRN', 'VAT', 'GST', 'EIN', 'OTHER']).optional(),
  timezone: z.string().optional(),
  fiscalYearStart: z.number().int().min(1).max(12).optional(),
  logoUrl: z.string().url().optional().or(z.literal('')).nullable(),
})
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>

export const updateOrganizationSchema = z.object({
  org_id: z.string().min(1),
  name: z.string().min(2).max(100).optional(),
  description: z.string().max(500).optional().or(z.literal('')),
  website: z.string().url().optional().or(z.literal('')),
  logoUrl: z.string().url().optional().or(z.literal('')).nullable(),
})
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>

export const archiveSchema = z.object({
  id: z.string().min(1),
  confirmation_text: z.string().min(1, 'Type the name to confirm'),
})
export type ArchiveInput = z.infer<typeof archiveSchema>
