/**
 * Text decoding for files that carry no encoding declaration: valid UTF-8 is
 * read as UTF-8, and anything else is read as GBK, which is what the older
 * Chinese documents in a working library are saved as.
 * @module cyberself/parse/encoding
 */

const UTF8 = new TextDecoder('utf-8', { fatal: true })
const GBK = new TextDecoder('gbk', { fatal: true })
const LOSSY = new TextDecoder('utf-8')

function attempt(decoder: TextDecoder, bytes: Uint8Array): string | null {
  try {
    return decoder.decode(bytes)
  } catch {
    return null
  }
}

/** Decode one text file, falling back to GBK when the bytes are not valid UTF-8. */
export function decodeText(bytes: Uint8Array): string {
  const utf8 = attempt(UTF8, bytes)
  if (utf8 !== null) return utf8
  const gbk = attempt(GBK, bytes)
  if (gbk !== null) return gbk
  return LOSSY.decode(bytes)
}
