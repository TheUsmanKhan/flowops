/**
 * Bootstrap file — runs BEFORE any other module via --require flag.
 *
 * Fixes the 'open EEXIST' crash on Hostinger production where process.stdin
 * is not available. Node.js lazily creates a Socket for stdin when first
 * accessed. On Hostinger, this fails with EEXIST.
 *
 * This file pre-patches process.stdin to return a dummy Readable stream,
 * preventing the lazy Socket creation and the subsequent crash.
 */
try {
  const { Readable } = require('stream')

  // Create a dummy stdin that never emits data (EOF immediately)
  const dummyStdin = new Readable({ read() {} })
  dummyStdin.push(null) // Signal EOF

  // Forcefully replace the stdin getter with our dummy stream.
  // Object.defineProperty works here because process.stdin is configurable
  // in Node.js (see lib/internal/bootstrap/switches/is_main_thread.js).
  Object.defineProperty(process, 'stdin', {
    value: dummyStdin,
    writable: false,
    configurable: false,
    enumerable: true,
  })
} catch (err) {
  // If patching fails, continue anyway — the error will surface as EEXIST
  // if something accesses stdin, but at least the server starts.
  console.error('[bootstrap] Failed to patch process.stdin:', err.message)
}
