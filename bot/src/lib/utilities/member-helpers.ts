/**
 * Member fetching helpers to reduce code duplication across bot commands
 */

import {
    Guild,
    GuildMember,
    ChatInputCommandInteraction,
    MessageFlags
} from 'discord.js';

/**
 * Safely fetches a guild member with error handling
 * @param guild - The guild to fetch from
 * @param userId - The user ID to fetch
 * @returns The guild member if found, null otherwise
 */
export async function fetchMember(
    guild: Guild,
    userId: string
): Promise<GuildMember | null> {
    try {
        return await guild.members.fetch(userId);
    } catch {
        return null;
    }
}

/**
 * Fetches a guild member or replies with an error message
 * @param guild - The guild to fetch from
 * @param userId - The user ID to fetch
 * @param interaction - The interaction to reply to if member not found
 * @param errorMessage - Custom error message (default: "Could not fetch your member information.")
 * @returns The guild member if found, null otherwise (with error reply sent)
 */
export async function fetchMemberOrReply(
    guild: Guild,
    userId: string,
    interaction: ChatInputCommandInteraction,
    errorMessage: string = 'Could not fetch your member information.'
): Promise<GuildMember | null> {
    const member = await fetchMember(guild, userId);
    
    if (!member) {
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(`❌ ${errorMessage}`);
        } else {
            await interaction.reply({
                content: `❌ ${errorMessage}`,
                flags: MessageFlags.Ephemeral
            });
        }
        return null;
    }
    
    return member;
}

/**
 * Fetches the interaction invoker's guild member with error handling
 * Convenience wrapper for the common pattern of fetching interaction.user
 * @param interaction - The interaction containing the guild and user
 * @returns The guild member if found, null otherwise (with error reply sent)
 */
export async function fetchInvokerMember(
    interaction: ChatInputCommandInteraction
): Promise<GuildMember | null> {
    if (!interaction.guild) {
        return null;
    }
    
    return fetchMemberOrReply(
        interaction.guild,
        interaction.user.id,
        interaction,
        'Could not fetch your member record. Try again in a moment.'
    );
}

/**
 * Strips common Discord nickname prefixes from a username.
 * Prefixes like "!!", "!", ">>", "||", etc. are commonly used in Discord for role-based name formatting.
 * This function removes these prefixes to allow for more flexible username matching.
 * 
 * @param name - The username or display name to strip prefixes from
 * @returns The name with prefixes removed and trimmed
 * 
 * @example
 * stripNicknamePrefix("!!SJKD") // returns "SJKD"
 * stripNicknamePrefix("!Admin") // returns "Admin"
 * stripNicknamePrefix("SJKD") // returns "SJKD"
 */
export function stripNicknamePrefix(name: string): string {
    if (!name) return '';
    
    // Strip leading special characters that are commonly used as prefixes
    // This regex matches one or more of the following characters at the start:
    // ! | > < ~ * + = - _ . : ; # @ $ % ^ & ( ) [ ] { }
    // This covers most common prefix patterns like: !!, !, >>, ||, ~~, **, ++, etc.
    return name.replace(/^[!|><~*+=\-_.:;#@$%^&()\[\]{}]+/, '').trim();
}

/**
 * Compares two usernames for matching, ignoring common Discord prefixes.
 * This is useful for finding users when their display name has prefixes but the search query doesn't.
 * 
 * @param search - The search query (e.g., "SJKD")
 * @param target - The target username to compare against (e.g., "!!SJKD")
 * @param caseSensitive - Whether the comparison should be case-sensitive (default: false)
 * @returns True if the names match after stripping prefixes
 * 
 * @example
 * matchUsernames("SJKD", "!!SJKD") // returns true
 * matchUsernames("sjkd", "!!SJKD", false) // returns true
 * matchUsernames("Admin", "!Admin") // returns true
 * matchUsernames("Test", "Example") // returns false
 */
export function matchUsernames(search: string, target: string, caseSensitive: boolean = false): boolean {
    if (!search || !target) return false;
    
    const strippedSearch = stripNicknamePrefix(search);
    const strippedTarget = stripNicknamePrefix(target);
    
    if (caseSensitive) {
        return strippedSearch === strippedTarget;
    } else {
        return strippedSearch.toLowerCase() === strippedTarget.toLowerCase();
    }
}

/**
 * Searches for a guild member by username, tag, or display name with flexible prefix handling.
 * This function performs multiple types of matching:
 * 1. Exact matching (with and without case sensitivity)
 * 2. Prefix-stripped matching (ignores common Discord prefixes like !!, !, etc.)
 * 3. Partial matching (contains)
 * 
 * The function prioritizes exact matches first, then prefix-stripped matches, then partial matches.
 * 
 * @param guild - The guild to search in
 * @param query - The search query (username, tag, or display name)
 * @returns The found guild member, or null if not found
 * 
 * @example
 * // If a user has displayName "!!SJKD"
 * findMemberByName(guild, "SJKD") // returns the member
 * findMemberByName(guild, "!!SJKD") // returns the member
 * findMemberByName(guild, "sjkd") // returns the member (case-insensitive)
 */
export function findMemberByName(
    guild: Guild,
    query: string
): GuildMember | null {
    if (!query) return null;
    
    const normalizedQuery = query.trim();
    const lowerQuery = normalizedQuery.toLowerCase();
    const strippedQuery = stripNicknamePrefix(normalizedQuery);
    const lowerStrippedQuery = strippedQuery.toLowerCase();
    
    // Priority 1: Exact matches (highest priority)
    // Check username, tag, and displayName for exact matches (case-insensitive)
    let member = guild.members.cache.find(
        (m) =>
            m.user.username.toLowerCase() === lowerQuery ||
            m.user.tag.toLowerCase() === lowerQuery ||
            m.displayName.toLowerCase() === lowerQuery
    );
    
    if (member) return member;
    
    // Priority 2: Prefix-stripped matches
    // Check if the stripped versions match (this handles cases like "SJKD" matching "!!SJKD")
    member = guild.members.cache.find((m) => {
        const strippedUsername = stripNicknamePrefix(m.user.username);
        const strippedTag = stripNicknamePrefix(m.user.tag);
        const strippedDisplayName = stripNicknamePrefix(m.displayName);
        
        return (
            strippedUsername.toLowerCase() === lowerStrippedQuery ||
            strippedTag.toLowerCase() === lowerStrippedQuery ||
            strippedDisplayName.toLowerCase() === lowerStrippedQuery
        );
    });
    
    if (member) return member;
    
    // Priority 3: Partial matches (contains)
    // This is a fallback for partial name matches
    member = guild.members.cache.find((m) => {
        const lowerUsername = m.user.username.toLowerCase();
        const lowerTag = m.user.tag.toLowerCase();
        const lowerDisplayName = m.displayName.toLowerCase();
        
        return (
            lowerUsername.includes(lowerQuery) ||
            lowerTag.includes(lowerQuery) ||
            lowerDisplayName.includes(lowerQuery) ||
            stripNicknamePrefix(lowerDisplayName).includes(lowerStrippedQuery)
        );
    });
    
    return member || null;
}
