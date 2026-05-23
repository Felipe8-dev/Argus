// Shared sighting regex patterns used by both Ghost.social (SERP) and the
// Harvest layer (post-comment scrape). Centralised so adding a new
// Spanish/English signal lights up both at once.

export const SIGHTING_REGEX_TAGS: Array<{ pattern: RegExp; weight: number; tag: string }> = [
  { pattern: /\b(vi|vimos|vieron|visto)\s+(a\s+)?(esta|este|ese|esa|la|el)?\s*(persona|chica|chico|mujer|hombre|joven)?/i, weight: 0.7, tag: 'sighting_verb' },
  { pattern: /\b(estuvo|estuvieron|estaba|estaban|esta|está)\s+(en|cerca|por)/i, weight: 0.6, tag: 'location_verb' },
  { pattern: /\b(encontraron|encontrada|encontrado|hallaron|hallada|aparecio|apareció)/i, weight: 0.85, tag: 'found' },
  { pattern: /\b(desaparecid[ao]|extraviad[ao]|missing|secuestrad[ao])/i, weight: 0.9, tag: 'missing' },
  { pattern: /\b(alguien|alguno|alguna)\s+(la|lo|le)\s+(ha\s+)?(visto|vió|vio|reconoce)/i, weight: 0.75, tag: 'request_help' },
  { pattern: /\b(seen|spotted|found|missing)\b/i, weight: 0.55, tag: 'sighting_en' },
  { pattern: /\b(ayuden|ayúdenme|ayudame|por\s+favor|please\s+help|comparte|compartan)/i, weight: 0.4, tag: 'plea' },
  // Tip-style phrases more common in comments than in indexed posts:
  { pattern: /\b(creo\s+que|me\s+parece\s+que|puede\s+ser)\b.{0,40}\b(vi|esta|era|fue)/i, weight: 0.55, tag: 'tentative_tip' },
  { pattern: /\b(la\s+vi|lo\s+vi|los\s+vi|las\s+vi)\b/i, weight: 0.85, tag: 'direct_sighting' },
  { pattern: /\b(zona|barrio|sector|calle|esquina|parque|plaza)\s+de?\s+\w+/i, weight: 0.5, tag: 'place_mention' },
];
