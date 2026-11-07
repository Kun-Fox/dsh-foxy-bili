/**
 * Interest filtering for the Bilibili scan.
 *
 * Bilibili's popular feed is broad; users can narrow it by title/description
 * keywords or by the video's partition name (`tname`). An empty filter means
 * "browse the normal popular feed".
 */

export function normalizeTextList(value, max = 30) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,，\n]/)
      : []
  const out = []
  const seen = new Set()
  for (const entry of raw) {
    const text = String(entry ?? '').trim()
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= max) break
  }
  return out
}

export function hasInterestFilters(config = {}) {
  return Boolean(
    (Array.isArray(config.interestKeywords) && config.interestKeywords.length) ||
      (Array.isArray(config.interestCategories) && config.interestCategories.length),
  )
}

export function matchesInterest(item = {}, config = {}) {
  if (!hasInterestFilters(config)) return true
  const title = String(item.title || '')
  const desc = String(item.desc || '')
  const tname = String(item.tname || '')
  const haystack = `${title}\n${desc}\n${tname}`.toLowerCase()
  const keywords = Array.isArray(config.interestKeywords) ? config.interestKeywords : []
  const categories = Array.isArray(config.interestCategories) ? config.interestCategories : []
  const keywordHit = keywords.some((keyword) => haystack.includes(String(keyword).toLowerCase()))
  const categoryHit = categories.some((category) =>
    tname.toLowerCase().includes(String(category).toLowerCase()),
  )
  return keywordHit || categoryHit
}
