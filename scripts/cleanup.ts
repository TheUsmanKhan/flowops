import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

await p.auditLog.deleteMany({})
await p.metricEvent.deleteMany({})
await p.rolePermission.deleteMany({})
await p.employee.deleteMany({ where: { user: { email: { not: 'usman@flowops.pk' } } } })
await p.invitation.deleteMany({})
await p.role.deleteMany({ where: { company: { name: { not: 'Usman Commerce' } } } })
await p.userSetting.deleteMany({ where: { user: { email: { not: 'usman@flowops.pk' } } } })
await p.company.deleteMany({ where: { name: { not: 'Usman Commerce' } } })
await p.organization.deleteMany({ where: { name: { not: 'Usman Group' } } })
await p.profile.deleteMany({ where: { email: { not: 'usman@flowops.pk' } } })

const cs = await p.company.findMany({ select: { name: true, _count: { select: { roles: true } } } })
for (const c of cs) console.log('  remaining:', c.name, '| roles:', c._count.roles)
console.log('cleaned OK')
await p.$disconnect()
