import { z } from 'zod'

export const createRoleSchema = z.object({
  name: z
    .string()
    .min(2, 'Role name must be at least 2 characters')
    .max(60),
  description: z.string().max(280).optional().or(z.literal('')),
  permissions: z.array(z.string()).default([]),
})
export type CreateRoleInput = z.infer<typeof createRoleSchema>

export const updateRoleSchema = z.object({
  name: z.string().min(2).max(60).optional(),
  description: z.string().max(280).optional().or(z.literal('')),
  permissions: z.array(z.string()).optional(),
})
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>

export const acceptInviteSchema = z.object({
  token: z.string().min(1),
})
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>
