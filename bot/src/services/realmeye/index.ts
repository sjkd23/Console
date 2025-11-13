/**
 * RealmEye Player Profile Scraper
 * 
 * This module provides a clean, DRY implementation of RealmEye scraping,
 * inspired by the design of RealmEyeSharper (v1.0.0).
 * 
 * Key design principles from RealmEyeSharper:
 * - Centralized HTML parsing logic
 * - Structured result codes (Success, Private, NotFound, etc.)
 * - Description extracted from .line1, .line2, .line3 divs
 * - Proper User-Agent and HTTP client setup
 * 
 * @see https://github.com/Zwork101/RealmEye-Sharper
 */

import * as cheerio from 'cheerio';
import type { RealmEyePlayerProfile, RealmEyeResultCode } from './player.js';
import { buildPlayerUrl, fetchRealmEyePage } from './http.js';

/**
 * Fetch and parse a RealmEye player profile.
 * 
 * This is the main function analogous to RealmEyeSharper's ScrapePlayerProfileAsync.
 * It handles all the cases:
 * - Service unavailable (RealmEye down or network error)
 * - Profile not found (404 or "player not found" message)
 * - Profile private (hidden profile message)
 * - Success (profile parsed with description lines)
 * 
 * @param ign The player's in-game name
 * @returns A RealmEyePlayerProfile object with result code and data
 */
export async function fetchRealmEyePlayerProfile(ign: string): Promise<RealmEyePlayerProfile> {
    const url = buildPlayerUrl(ign);
    
    console.log(`[RealmEye] Fetching profile for "${ign}": ${url}`);

    // Attempt to fetch the page
    const response = await fetchRealmEyePage(url);

    if (!response) {
        // Network error or timeout
        return {
            name: ign,
            descriptionLines: [],
            resultCode: 'ServiceUnavailable',
            errorMessage: 'Failed to connect to RealmEye. Please try again later.',
        };
    }

    // Check HTTP status
    if (!response.ok) {
        if (response.status === 404) {
            return {
                name: ign,
                descriptionLines: [],
                resultCode: 'NotFound',
                errorMessage: `RealmEye profile for "${ign}" not found. Check the IGN spelling.`,
            };
        }

        // Other HTTP error
        return {
            name: ign,
            descriptionLines: [],
            resultCode: 'ServiceUnavailable',
            errorMessage: `RealmEye returned HTTP ${response.status}. Try again later.`,
        };
    }

    // Parse the HTML
    const html = await response.text();
    
    // Check for "not found" / "could not be found" message
    // RealmEye returns 200 OK but shows a message when profile doesn't exist
    if (html.includes('could not be found in the database') ||
        html.includes('We could not find') ||
        html.includes('No such player')) {
        return {
            name: ign,
            descriptionLines: [],
            resultCode: 'NotFound',
            errorMessage: `Player "${ign}" does not exist on RealmEye.`,
        };
    }
    
    // Check for private profile
    // RealmEyeSharper checks for specific text indicating privacy
    if (html.includes('This profile is hidden') || 
        html.includes('profile is private')) {
        return {
            name: ign,
            descriptionLines: [],
            resultCode: 'Private',
            errorMessage: `The RealmEye profile for "${ign}" is private. Please make it public.`,
        };
    }

    // Parse description lines
    const descriptionLines = parseDescriptionLines(html);

    console.log(`[RealmEye] Profile fetch result:`, {
        ign,
        resultCode: 'Success',
        descriptionLinesCount: descriptionLines.length,
        sample: descriptionLines.slice(0, 3),
    });

    return {
        name: ign,
        descriptionLines,
        resultCode: 'Success',
    };
}

/**
 * Parse description lines from RealmEye HTML.
 * 
 * RealmEye stores descriptions in divs with classes: .line1, .line2, .line3
 * This mirrors RealmEyeSharper's approach:
 * - For i = 1 to 3, select nodes with class "line{i}"
 * - If node exists and has non-empty text, decode HTML entities and add to list
 * 
 * @param html The HTML content of the profile page
 * @returns Array of description lines (0-3 lines)
 */
function parseDescriptionLines(html: string): string[] {
    const $ = cheerio.load(html);
    const lines: string[] = [];

    // RealmEyeSharper pattern: loop through line1, line2, line3
    for (let i = 1; i <= 3; i++) {
        // Select div with class "line{i}"
        // CSS selector: div.line1, div.line2, div.line3
        const selector = `div.line${i}`;
        const element = $(selector);

        if (element.length > 0) {
            // Get text content, cheerio automatically decodes HTML entities
            const text = element.text().trim();

            if (text.length > 0) {
                lines.push(text);
            }
        }
    }

    return lines;
}

/**
 * Convenience function to fetch just the description lines.
 * Useful when you only care about the description and not other profile data.
 * 
 * @param ign The player's in-game name
 * @returns Array of description lines, or empty array if profile couldn't be fetched
 */
export async function fetchRealmEyeDescription(ign: string): Promise<string[]> {
    const profile = await fetchRealmEyePlayerProfile(ign);
    return profile.descriptionLines;
}

/**
 * Check if a verification code exists in a player's RealmEye description.
 * 
 * This is a high-level helper that encapsulates the verification logic,
 * making it trivial to check for codes.
 * 
 * @param ign The player's in-game name
 * @param code The verification code to search for
 * @returns Object indicating whether the code was found, plus profile status
 */
export async function checkVerificationCode(
    ign: string,
    code: string
): Promise<{
    found: boolean;
    resultCode: RealmEyeResultCode;
    errorMessage?: string;
}> {
    const profile = await fetchRealmEyePlayerProfile(ign);

    // Handle non-success cases
    if (profile.resultCode !== 'Success') {
        return {
            found: false,
            resultCode: profile.resultCode,
            errorMessage: profile.errorMessage,
        };
    }

    // Join all description lines into a single searchable string
    const fullDescription = profile.descriptionLines.join('\n');

    // Case-sensitive search for the code
    const found = fullDescription.includes(code);

    return {
        found,
        resultCode: 'Success',
    };
}
