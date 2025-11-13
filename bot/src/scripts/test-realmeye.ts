/**
 * Test script to debug RealmEye verification
 * Now uses the new centralized RealmEye scraper module
 * 
 * Usage: npm run test-realmeye <IGN> [code]
 */

import { fetchRealmEyePlayerProfile } from '../services/realmeye/index.js';
import { checkRealmEyeVerification } from '../lib/verification.js';

async function testRealmEye() {
    const args = process.argv.slice(2);
    
    if (args.length < 1) {
        console.error('Usage: npm run test-realmeye <IGN> [code]');
        console.error('Example: npm run test-realmeye "PlayerName" "testcode123"');
        process.exit(1);
    }

    const ign = args[0];
    const code = args[1] || 'TESTCODE';

    console.log('=== RealmEye Verification Test ===');
    console.log('IGN:', ign);
    console.log('Code to search for:', code);
    console.log('');

    try {
        // Test 1: Use the new centralized scraper directly
        console.log('--- Test 1: Direct scraper (fetchRealmEyePlayerProfile) ---');
        
        // First, let's peek at what RealmEye actually returns
        const url = `https://www.realmeye.com/player/${encodeURIComponent(ign)}`;
        const rawResponse = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
        });
        
        if (rawResponse.ok) {
            const rawHtml = await rawResponse.text();
            
            // Check for common error/not found indicators
            console.log('\nHTML Content Check:');
            console.log('  Contains "could not be found":', rawHtml.includes('could not be found'));
            console.log('  Contains "We could not find":', rawHtml.includes('We could not find'));
            console.log('  Contains "No such player":', rawHtml.includes('No such player'));
            console.log('  Contains "hidden":', rawHtml.includes('hidden'));
            console.log('  Contains "private":', rawHtml.includes('private'));
            
            // Show a snippet around any "not found" text
            const notFoundIndex = rawHtml.toLowerCase().indexOf('not found');
            if (notFoundIndex >= 0) {
                console.log('\nContext around "not found":');
                console.log(rawHtml.substring(Math.max(0, notFoundIndex - 50), notFoundIndex + 100));
            }
        }
        
        console.log('\n--- Now testing the scraper ---');
        const profile = await fetchRealmEyePlayerProfile(ign);
        
        console.log('\nProfile Result:');
        console.log('  Result Code:', profile.resultCode);
        console.log('  Name:', profile.name);
        console.log('  Description Lines Count:', profile.descriptionLines.length);
        console.log('  Description Lines:', profile.descriptionLines);
        
        if (profile.errorMessage) {
            console.log('  Error Message:', profile.errorMessage);
        }

        if (profile.resultCode === 'Success') {
            const fullDescription = profile.descriptionLines.join('\n');
            console.log('\nFull Description:\n---');
            console.log(fullDescription || '(empty)');
            console.log('---');
            console.log('\nContains code?', fullDescription.includes(code));
        }

        // Test 2: Use the legacy verification function (should now use the new scraper internally)
        console.log('\n\n--- Test 2: Legacy verification function (checkRealmEyeVerification) ---');
        const result = await checkRealmEyeVerification(ign, code);
        
        console.log('\nVerification Result:');
        console.log('  Found:', result.found);
        console.log('  Profile Exists:', result.profileExists);
        if (result.description !== undefined) {
            console.log('  Description:', result.description);
        }
        if (result.error) {
            console.log('  Error:', result.error);
        }

        console.log('\n=== Test Complete ===');
        if (result.found) {
            console.log('✅ Verification code found!');
        } else {
            console.log('❌ Verification code not found');
        }

    } catch (error) {
        console.error('\n❌ Error:', error);
        process.exit(1);
    }
}

testRealmEye();
