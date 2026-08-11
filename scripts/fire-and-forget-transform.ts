/**
 * Mechanical transform: convert blocking audit/metric calls to fire-and-forget.
 *
 * For every `insertAuditLog(` / `insertMetricEvent(` call site:
 *   1. Remove a preceding `await ` (if present)
 *   2. Remove a trailing `.catch(...)` chain (if present) — the helpers now
 *      catch internally via fireAndForget(), so the call-site catch is dead
 *      code AND a TypeScript error (void has no .catch).
 *
 * Uses paren-matching (not regex) so nested parens/braces/strings are
 * handled correctly. Idempotent — running twice is a no-op.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'fs'
import { join } from 'path'

const SRC = '/home/z/my-project/src'
const TARGETS = ['insertAuditLog', 'insertMetricEvent']

let totalAwaitRemoved = 0
let totalCatchRemoved = 0
let filesTouched = 0

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p)
  }
  return out
}

/**
 * Given source + index of '(' (the opening paren of the call), return the
 * index of the matching ')'. Respects strings, template literals, comments.
 */
function findMatchingParen(src: string, openIdx: number): number {
  let depth = 1
  let i = openIdx + 1
  let inString: '"' | "'" | '`' | null = null
  let inLineComment = false
  let inBlockComment = false
  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]
    if (inLineComment) {
      if (ch === '\n') inLineComment = false
      i++
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i += 2; continue }
      i++
      continue
    }
    if (inString) {
      if (ch === '\\') { i += 2; continue }
      if (ch === inString) inString = null
      i++
      continue
    }
    if (ch === '/' && next === '/') { inLineComment = true; i += 2; continue }
    if (ch === '/' && next === '*') { inBlockComment = true; i += 2; continue }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch as any; i++; continue }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

/**
 * Check if `await ` precedes `callStart` (the index of the function name),
 * allowing whitespace/newlines between `await` and the name. Returns the
 * index of `a` in `await` if present, else -1.
 */
function findAwaitPrefix(src: string, callStart: number): number {
  // Walk backwards skipping whitespace
  let i = callStart - 1
  while (i >= 0 && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r')) i--
  // Check for 'await' keyword
  const word = 'await'
  if (i - word.length + 1 < 0) return -1
  const candidate = src.slice(i - word.length + 1, i + 1)
  if (candidate === word) {
    // Ensure it's a word boundary (char before 'await' is not alphanumeric)
    const before = src[i - word.length]
    if (before && /[a-zA-Z0-9_$]/.test(before)) return -1
    return i - word.length + 1
  }
  return -1
}

/**
 * After the call's closing ')', skip whitespace and check if '.catch('
 * follows. If so, return [startOfDot, matchingParenOfCatch]. Else null.
 */
function findCatchChain(src: string, closeParenIdx: number): [number, number] | null {
  let i = closeParenIdx + 1
  while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++
  if (src.slice(i, i + 7) !== '.catch(') return null
  const catchOpen = i + 6 // index of '(' in .catch(
  const catchClose = findMatchingParen(src, catchOpen)
  if (catchClose === -1) return null
  return [i, catchClose]
}

function transformFile(filePath: string): boolean {
  let src = readFileSync(filePath, 'utf8')
  let changed = false
  let awaitRemoved = 0
  let catchRemoved = 0

  for (const target of TARGETS) {
    // Find each occurrence of `target(` that is a CALL (not a definition/import).
    // We look for the identifier preceded by a word boundary and followed by '('
    // (ignoring whitespace).
    let searchFrom = 0
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const idx = src.indexOf(target, searchFrom)
      if (idx === -1) break
      searchFrom = idx + target.length

      // Word boundary before
      const before = src[idx - 1]
      if (before && /[a-zA-Z0-9_$]/.test(before)) continue
      // Skip if it's a definition (e.g. `function insertAuditLog` or `export function`)
      const preceding = src.slice(Math.max(0, idx - 30), idx)
      if (/function\s+$/.test(preceding)) continue
      if (/export\s+function\s+$/.test(preceding)) continue

      // Find '(' (the opening paren of the call) — skip whitespace
      let j = idx + target.length
      while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++
      if (src[j] !== '(') continue
      const openParen = j
      const closeParen = findMatchingParen(src, openParen)
      if (closeParen === -1) continue

      // Check for .catch( chain after the closing paren
      const catchChain = findCatchChain(src, closeParen)

      // Check for `await ` before
      const awaitIdx = findAwaitPrefix(src, idx)

      // Apply removals (from end to start so indices stay valid)
      if (catchChain) {
        // Remove `.catch(...)` — but keep any trailing newline? We remove
        // from catchChain[0] to catchChain[1] inclusive. Also strip a
        // trailing space if the `.catch` was on its own segment.
        const [cStart, cEnd] = catchChain
        // If removing leaves a trailing dot-like remnant, also strip one
        // preceding space if the char before cStart is a space and the
        // char after cEnd is a newline (keeps line clean).
        src = src.slice(0, cStart) + src.slice(cEnd + 1)
        catchRemoved++
        changed = true
      }

      if (awaitIdx !== -1) {
        // Remove `await ` (the word + the following whitespace)
        // Find end of the whitespace after 'await'
        let wEnd = awaitIdx + 5
        while (wEnd < src.length && (src[wEnd] === ' ' || src[wEnd] === '\t' || src[wEnd] === '\n')) wEnd++
        src = src.slice(0, awaitIdx) + src.slice(wEnd)
        awaitRemoved++
        changed = true
        // Adjust searchFrom since we shortened the string
        searchFrom -= (wEnd - awaitIdx)
      }
    }
  }

  if (changed) {
    writeFileSync(filePath, src)
    filesTouched++
    totalAwaitRemoved += awaitRemoved
    totalCatchRemoved += catchRemoved
    console.log(`  ${filePath}: -${awaitRemoved} await, -${catchRemoved} catch`)
  }
  return changed
}

console.log('Scanning src/ for fire-and-forget transform...')
for (const f of walk(SRC)) {
  transformFile(f)
}
console.log('---')
console.log(`Files touched:    ${filesTouched}`)
console.log(`await removed:    ${totalAwaitRemoved}`)
console.log(`.catch() removed: ${totalCatchRemoved}`)
