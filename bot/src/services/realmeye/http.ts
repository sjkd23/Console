/**
 * HTTP utilities for RealmEye scraping.
 * Inspired by RealmEyeSharper's HTTP client configuration.
 */

/**
 * Base URL for RealmEye.
 * Mirrors RealmEyeSharper's Constants.BaseUrl
 */
export const REALMEYE_BASE_URL = 'https://www.realmeye.com';

/**
 * Player profile path segment.
 * Mirrors RealmEyeSharper's Constants.PlayerSegment
 */
export const PLAYER_SEGMENT = 'player';

/**
 * Browser User-Agent strings for HTTP requests.
 * RealmEyeSharper uses randomized User-Agent to appear more like a real browser.
 * We'll use a single modern browser UA for consistency.
 */
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

/**
 * Get a random User-Agent string.
 * Mirrors RealmEyeSharper's approach to randomizing requests.
 */
function getRandomUserAgent(): string {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Build the full URL for a player profile.
 * @param ign The player's in-game name
 * @returns Full URL to the player's RealmEye profile
 */
export function buildPlayerUrl(ign: string): string {
    return `${REALMEYE_BASE_URL}/${PLAYER_SEGMENT}/${encodeURIComponent(ign)}`;
}

/**
 * Fetch a RealmEye page with proper headers.
 * Analogous to RealmEyeSharper's HTTP client setup.
 * 
 * @param url The URL to fetch
 * @returns Response object or null if request failed
 */
export async function fetchRealmEyePage(url: string): Promise<Response | null> {
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
            },
            // Reasonable timeout
            signal: AbortSignal.timeout(10000), // 10 seconds
        });

        return response;
    } catch (error) {
        // Network error, timeout, or other fetch failure
        console.error('[RealmEye HTTP] Failed to fetch page:', error);
        return null;
    }
}
