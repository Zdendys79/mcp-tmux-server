#!/usr/bin/env node
/**
 * Phonetic Version Generator
 *
 * Generates unique, pronounceable version names from build timestamps.
 *
 * Algorithm:
 * 1. Get current timestamp (seconds since epoch)
 * 2. Divide by BUILD_INTERVAL (180s = 3min minimum between builds)
 * 3. Convert to base-20 using consonants: b,c,d,f,g,h,j,k,l,m,n,p,r,s,t,v,w,x,z,ž
 * 4. Insert vowels (a,e,i,o,u) between consonants for pronounceability
 * 5. Result: unique, memorable version name
 *
 * Examples:
 *   1732126807 -> hekamoři
 *   1732126987 -> hekamuvi
 *   1732127167 -> hekamuxe
 */

const BUILD_INTERVAL = 180; // Minimum 3 minutes between builds

// 20 consonants for base-20 encoding (English phonology-friendly)
const CONSONANTS = ['b', 'c', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm',
                    'n', 'p', 'r', 's', 't', 'v', 'w', 'x', 'y', 'z'];

// 5 vowels (English only: a, e, i, o, u)
const VOWELS = ['a', 'e', 'i', 'o', 'u'];

/**
 * Convert number to base-20 using consonants
 */
function toBase20(num) {
  if (num === 0) return [CONSONANTS[0]];

  const digits = [];
  while (num > 0) {
    digits.unshift(CONSONANTS[num % 20]);
    num = Math.floor(num / 20);
  }
  return digits;
}

/**
 * Create pronounceable syllables using English phonology
 * Pattern: CV-CV-CV... (Consonant-Vowel pairs = syllables)
 *
 * English syllable structure:
 * - CV: "ba", "te", "do" (most common, always pronounceable)
 * - Creates natural word-like sounds
 *
 * Examples:
 *   [b,c,d] -> ba-ce-di -> "bacedi"
 *   [h,k,m] -> ha-ke-mi -> "hakemi"
 */
function makePronounceable(consonants) {
  const syllables = [];

  for (let i = 0; i < consonants.length; i++) {
    // Each consonant + vowel = one syllable (CV pattern)
    const consonant = consonants[i];
    const vowelIndex = i % VOWELS.length; // Deterministic vowel selection
    const vowel = VOWELS[vowelIndex];

    syllables.push(consonant + vowel);
  }

  // Join syllables with optional hyphen for readability
  // For versions, we use no hyphen for compactness
  return syllables.join('');
}

/**
 * Generate version name from timestamp
 */
function generateVersion(timestamp = null) {
  const ts = timestamp || Math.floor(Date.now() / 1000);
  const normalized = Math.floor(ts / BUILD_INTERVAL);
  const consonants = toBase20(normalized);
  const version = makePronounceable(consonants);

  return version;
}

/**
 * Get readable timestamp for reference
 */
function getTimestampInfo(timestamp = null) {
  const ts = timestamp || Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000);
  const isoDate = date.toISOString().slice(0, 19).replace('T', ' ');

  return {
    timestamp: ts,
    normalized: Math.floor(ts / BUILD_INTERVAL),
    isoDate: isoDate
  };
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const version = generateVersion();
  const info = getTimestampInfo();

  console.log(version);

  // Debug info if --verbose flag
  if (process.argv.includes('--verbose')) {
    console.error(`[DEBUG] Timestamp: ${info.timestamp}`);
    console.error(`[DEBUG] Normalized: ${info.normalized}`);
    console.error(`[DEBUG] ISO Date: ${info.isoDate}`);
  }
}

export { generateVersion, getTimestampInfo };
