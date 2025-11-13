# RealmEye Service Module

This module provides a clean, DRY, and well-organized implementation of RealmEye profile scraping, inspired by the design of [RealmEyeSharper](https://github.com/Zwork101/RealmEye-Sharper) v1.0.0.

## Overview

The RealmEye service centralizes all HTML parsing and scraping logic for RealmEye.com player profiles. This ensures that:

- **DRY**: All RealmEye scraping logic is in one place
- **Robust**: Proper error handling for all edge cases
- **Maintainable**: Clean separation of concerns
- **Extensible**: Easy to add more profile fields in the future

## Architecture

Inspired by RealmEyeSharper's design:

```
services/realmeye/
├── index.ts      # Main scraper (like PlayerScraper.cs)
├── player.ts     # Types (like PlayerData.cs)
└── http.ts       # HTTP utilities (like Constants & client setup)
```

### Key Design Principles from RealmEyeSharper

1. **Structured Result Codes**: Instead of throwing exceptions, returns result codes (`Success`, `NotFound`, `Private`, `ServiceUnavailable`, `Error`)

2. **Description Line Parsing**: Mirrors RealmEyeSharper's approach of extracting description from `.line1`, `.line2`, `.line3` divs

3. **Proper HTTP Client**: Uses realistic browser User-Agent strings and proper headers

4. **Centralized Parsing**: All HTML structure knowledge is encapsulated in the scraper module

## Usage

### Basic Profile Fetching

```typescript
import { fetchRealmEyePlayerProfile } from './services/realmeye/index.js';

const profile = await fetchRealmEyePlayerProfile('PlayerName');

if (profile.resultCode === 'Success') {
    console.log('Description lines:', profile.descriptionLines);
    // descriptionLines is an array: ["line 1", "line 2", "line 3"]
} else {
    console.error('Error:', profile.errorMessage);
}
```

### Verification Code Checking

```typescript
import { checkVerificationCode } from './services/realmeye/index.js';

const result = await checkVerificationCode('PlayerName', 'ABC123XYZ');

if (result.found) {
    console.log('✅ Verification code found!');
} else {
    console.log('❌ Code not found:', result.errorMessage);
}
```

### Description Only

```typescript
import { fetchRealmEyeDescription } from './services/realmeye/index.js';

const descriptionLines = await fetchRealmEyeDescription('PlayerName');
// Returns empty array if profile doesn't exist or has no description
```

## Result Codes

The scraper returns structured result codes instead of throwing exceptions:

| Result Code | Meaning |
|------------|---------|
| `Success` | Profile fetched and parsed successfully |
| `NotFound` | Player does not exist on RealmEye |
| `Private` | Profile exists but is set to private |
| `ServiceUnavailable` | RealmEye is down or network error occurred |
| `Error` | Unexpected error during scraping |

## How It Works

### 1. HTTP Request
- Builds URL: `https://www.realmeye.com/player/{IGN}`
- Uses randomized browser User-Agent
- 10-second timeout
- Proper browser headers

### 2. HTML Parsing
Uses Cheerio (jQuery-like API) to parse HTML and extract description:

```typescript
// RealmEye stores descriptions in divs with classes: .line1, .line2, .line3
for (let i = 1; i <= 3; i++) {
    const text = $(`div.line${i}`).text().trim();
    if (text) lines.push(text);
}
```

This mirrors RealmEyeSharper's approach:
```csharp
// C# version (RealmEyeSharper)
for (int i = 1; i <= 3; i++) {
    var nodes = doc.DocumentNode.SelectNodes($"//div[contains(@class, 'line{i}')]");
    if (nodes?.Any() == true) {
        var text = HtmlEntity.DeEntitize(nodes.First().InnerText);
        finalDesc.Add(text);
    }
}
```

### 3. Error Handling
- Network errors → `ServiceUnavailable`
- Non-200 HTTP status → `ServiceUnavailable` or `NotFound`
- Private profile indicators in HTML → `Private`
- Not found indicators in HTML → `NotFound`
- Success → Parsed `descriptionLines` array

## Integration with Verification Flow

The existing `checkRealmEyeVerification()` function has been refactored to use this service:

**Before (brittle, ad-hoc):**
```typescript
// 100+ lines of regex patterns, HTML parsing, error handling mixed together
const html = await fetch(...).then(r => r.text());
const match = html.match(/<div[^>]*>\s*<div[^>]*>\s*Description:...
// Multiple fallback patterns, manual entity decoding, etc.
```

**After (clean, delegated):**
```typescript
import { fetchRealmEyePlayerProfile } from '../services/realmeye/index.js';

const profile = await fetchRealmEyePlayerProfile(ign);
if (profile.resultCode === 'Success') {
    const description = profile.descriptionLines.join('\n');
    const found = description.includes(code);
    // ...
}
```

## Testing

Run the test script to verify the scraper:

```bash
npm run test-realmeye <IGN> [code]
```

Example:
```bash
npm run test-realmeye Niegil
npm run test-realmeye Tallyho ABC123
```

The test script:
1. Fetches the profile using the new scraper
2. Shows the result code and description lines
3. Tests the legacy verification function for backward compatibility

## Future Extensions

The module is designed to be easily extended. To add more profile fields:

1. Add fields to `RealmEyePlayerProfile` interface in `player.ts`
2. Add parsing logic in `parseProfileData()` in `index.ts`
3. Keep the same result code pattern

Example future additions:
- `rank: number` - Player rank
- `guild: string` - Guild name
- `fame: number` - Total fame
- `characters: CharacterInfo[]` - Character list
- `skins: string[]` - Unlocked skins

All following the RealmEyeSharper structure.

## References

- [RealmEyeSharper GitHub](https://github.com/Zwork101/RealmEye-Sharper) - Original C# implementation this is based on
- [RealmEye.com](https://www.realmeye.com/) - The source website
- [Cheerio Documentation](https://cheerio.js.org/) - HTML parsing library used
