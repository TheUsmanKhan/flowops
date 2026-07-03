import crypto from 'crypto'

/** Password hashing using Node's built-in scrypt (no extra deps). */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}.${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split('.')
  if (!salt || !hash) return false
  const computed = crypto.scryptSync(password, salt, 64).toString('hex')
  const a = Buffer.from(hash, 'hex')
  const b = Buffer.from(computed, 'hex')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
