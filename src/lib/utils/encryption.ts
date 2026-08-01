import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'crypto'

/**
 * Integration credential encryption utility.
 *
 * Uses AES-256-GCM (authenticated encryption) with a key derived from the
 * INTEGRATION_ENCRYPTION_KEY environment variable. The key must be a 32-byte
 * hex string (64 hex characters) — generate one with:
 *   openssl rand -hex 32
 *
 * The encrypted output format is: base64(iv) + ':' + base64(authTag) + ':' + base64(ciphertext)
 * — this is stored in company_integrations.credentials_encrypted.
 *
 * CRITICAL: The INTEGRATION_ENCRYPTION_KEY must be set in the deployment
 * environment and must NEVER be committed to version control or exposed to
 * the client. If the key is lost or changed, all existing encrypted
 * credentials become undecryptable.
 */

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12 // GCM standard IV length

function getEncryptionKey(): Buffer {
  const keyHex = process.env.INTEGRATION_ENCRYPTION_KEY
  if (!keyHex || keyHex.length !== 64) {
    throw new Error(
      'INTEGRATION_ENCRYPTION_KEY must be set to a 32-byte hex string (64 hex characters). ' +
      'Generate one with: openssl rand -hex 32',
    )
  }
  return Buffer.from(keyHex, 'hex')
}

/**
 * Encrypt a credentials object to a string suitable for storing in
 * company_integrations.credentials_encrypted.
 *
 * Serializes to JSON, encrypts with AES-256-GCM, returns
 * base64(iv):base64(authTag):base64(ciphertext).
 */
export function encryptCredentials(credentials: Record<string, string>): string {
  const key = getEncryptionKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  const json = JSON.stringify(credentials)
  const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':')
}

/**
 * Decrypt an encrypted credentials string back to the credentials object.
 *
 * Throws a clear error if decryption fails (wrong key, corrupted data)
 * rather than silently returning garbage.
 */
export function decryptCredentials(encrypted: string): Record<string, string> {
  if (!encrypted || typeof encrypted !== 'string') {
    throw new Error('Encrypted credentials string is empty or invalid')
  }

  const parts = encrypted.split(':')
  if (parts.length !== 3) {
    throw new Error('Encrypted credentials string has invalid format (expected 3 colon-separated parts)')
  }

  const [ivB64, authTagB64, ciphertextB64] = parts
  const key = getEncryptionKey()

  try {
    const iv = Buffer.from(ivB64, 'base64')
    const authTag = Buffer.from(authTagB64, 'base64')
    const ciphertext = Buffer.from(ciphertextB64, 'base64')

    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const json = decrypted.toString('utf8')

    return JSON.parse(json) as Record<string, string>
  } catch (err) {
    throw new Error(
      'Failed to decrypt credentials — the encryption key may have changed or the data is corrupted: ' +
      (err instanceof Error ? err.message : String(err)),
    )
  }
}

/**
 * Generate a cryptographically random, URL-safe token for use as
 * webhook_endpoint_id. Uses 16 bytes of randomness (32 hex characters).
 */
export function generateWebhookEndpointId(): string {
  return randomBytes(16).toString('hex')
}

/**
 * Generate a random webhook secret for HMAC signature verification.
 * 32 bytes = 64 hex characters.
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex')
}
