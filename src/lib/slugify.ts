/** Generate a URL-safe slug from a name, ensuring uniqueness within a scope. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

import { db } from './db'

/** Returns a unique slug by appending -2, -3, ... if taken. */
export async function uniqueSlug(
  base: string,
  model: 'organization' | 'company',
): Promise<string> {
  const slug = slugify(base) || 'workspace'
  let candidate = slug
  let n = 1
  while (true) {
    const exists =
      model === 'organization'
        ? await db.organization.findUnique({ where: { slug: candidate } })
        : await db.company.findUnique({ where: { slug: candidate } })
    if (!exists) return candidate
    n += 1
    candidate = `${slug}-${n}`
  }
}
