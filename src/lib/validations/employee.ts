import { z } from 'zod'

export const inviteEmployeeSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  roleId: z.string().min(1, 'Select a role'),
  department: z.string().max(80).optional().or(z.literal('')),
  designation: z.string().max(80).optional().or(z.literal('')),
  message: z.string().max(500).optional().or(z.literal('')),
})
export type InviteEmployeeInput = z.infer<typeof inviteEmployeeSchema>

export const updateEmployeeSchema = z.object({
  roleId: z.string().min(1).optional(),
  department: z.string().max(80).optional().or(z.literal('')),
  designation: z.string().max(80).optional().or(z.literal('')),
  employeeCode: z.string().max(40).optional().or(z.literal('')),
  directManagerId: z.string().optional().or(z.literal('')),
})
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>

export const terminateEmployeeSchema = z.object({
  reason: z.string().min(3, 'Provide a termination reason').max(500),
})
export type TerminateEmployeeInput = z.infer<typeof terminateEmployeeSchema>
