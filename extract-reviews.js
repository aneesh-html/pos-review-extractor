const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// App configurations
const APPS = {
    'shopify-pos': {
        name: 'Shopify POS',
        appStore: {
            id: '686830644',
            country: 'au',
            url: 'https://apps.apple.com/au/app/shopify-point-of-sale-pos/id686830644'
        },
        playStore: {
            id: 'com.shopify.pos',
            url: 'https://play.google.com/store/apps/details?id=com.shopify.pos&hl=en'
        }
    },
    'square-pos': {
        name: 'Square POS',
        appStore: {
            id: '335393788',
            country: 'us',
            url: 'https://apps.apple.com/us/app/square-point-of-sale-pos/id335393788'
        },
        playStore: {
            id: 'com.squareup',
            url: 'https://play.google.com/store/apps/details?id=com.squareup&hl=en'
        }
    }
};

// Extract App Store reviews via RSS feed
async function extractAppStoreReviews(appKey, config) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Extracting App Store reviews for: ${config.name}`);
    console.log(`${'='.repeat(60)}`);
    
    const browser = await chromium.launch({ headless: true });
    const allReviews = [];
    const page = await browser.newPage();
    
    const { id: appId, country } = config.appStore;
    
    // Apple RSS feed provides up to 50 reviews per page, 10 pages max = 500 reviews
    for (let pageNum = 1; pageNum <= 10; pageNum++) {
        const feedUrl = `https://itunes.apple.com/${country}/rss/customerreviews/page=${pageNum}/id=${appId}/sortby=mostrecent/json`;
        
        try {
            console.log(`Fetching page ${pageNum} from Apple RSS feed...`);
            await page.goto(feedUrl, { waitUntil: 'networkidle', timeout: 30000 });
            
            const bodyText = await page.evaluate(() => document.body.textContent);
            const data = JSON.parse(bodyText);
            
            if (!data.feed || !data.feed.entry) {
                console.log(`No more reviews on page ${pageNum}`);
                break;
            }
            
            const entries = Array.isArray(data.feed.entry) ? data.feed.entry : [data.feed.entry];
            const reviews = entries.filter(entry => entry['im:rating']);
            
            if (reviews.length === 0) {
                console.log(`No reviews found on page ${pageNum}`);
                break;
            }
            
            for (const entry of reviews) {
                allReviews.push({
                    app: config.name,
                    store: 'App Store',
                    title: entry.title?.label || '',
                    rating: parseInt(entry['im:rating']?.label || '0', 10),
                    date: entry.updated?.label || '',
                    author: entry.author?.name?.label || '',
                    content: entry.content?.label || '',
                    developerResponse: '',
                    version: entry['im:version']?.label || '',
                    voteCount: parseInt(entry['im:voteCount']?.label || '0', 10),
                    voteSum: parseInt(entry['im:voteSum']?.label || '0', 10)
                });
            }
            
            console.log(`Found ${reviews.length} reviews on page ${pageNum} (Total: ${allReviews.length})`);
            
        } catch (error) {
            console.log(`Error fetching page ${pageNum}:`, error.message);
            break;
        }
    }
    
    await browser.close();
    
    // Save to JSON
    const jsonFile = `${appKey}_appstore_reviews.json`;
    fs.writeFileSync(jsonFile, JSON.stringify(allReviews, null, 2));
    console.log(`\nSaved ${allReviews.length} App Store reviews to ${jsonFile}`);
    
    return allReviews;
}

// Extract Play Store reviews
async function extractPlayStoreReviews(appKey, config) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Extracting Play Store reviews for: ${config.name}`);
    console.log(`${'='.repeat(60)}`);
    
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 900 }
    });
    const page = await context.newPage();
    
    try {
        console.log(`Navigating to ${config.playStore.url}`);
        await page.goto(config.playStore.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
        
        // Click "See all reviews" button
        console.log('Looking for "See all reviews" button...');
        try {
            await page.click('button:has-text("See all reviews")', { timeout: 10000 });
            console.log('Clicked "See all reviews" button');
        } catch (e) {
            console.log('Could not find See all reviews button, extracting visible reviews...');
        }
        
        await page.waitForTimeout(2000);
        
        // Check if dialog opened
        const dialogExists = await page.locator('[role="dialog"]').count() > 0;
        if (dialogExists) {
            console.log('Reviews dialog opened');
            
            // Scroll to load more reviews
            console.log('Scrolling to load all reviews...');
            let lastCount = 0;
            let sameCount = 0;
            
            for (let i = 0; i < 500; i++) {
                const count = await page.locator('[role="dialog"] div[role="img"][aria-label*="Rated"]').count();
                
                if (count === lastCount) {
                    sameCount++;
                    if (sameCount >= 10) {
                        console.log(`Reached end - found ${count} reviews`);
                        break;
                    }
                } else {
                    sameCount = 0;
                    lastCount = count;
                    if (i % 20 === 0) {
                        console.log(`Loading... ${count} reviews`);
                    }
                }
                
                await page.evaluate(() => {
                    const dialog = document.querySelector('[role="dialog"]');
                    if (!dialog) return;
                    const containers = dialog.querySelectorAll('div');
                    for (const container of containers) {
                        if (container.scrollHeight > container.clientHeight + 50) {
                            container.scrollBy(0, 800);
                            break;
                        }
                    }
                });
                
                await page.waitForTimeout(200);
            }
        }
        
        // Extract reviews
        console.log('Extracting review data...');
        const reviews = await page.evaluate((appName) => {
            const results = [];
            const dialog = document.querySelector('[role="dialog"]');
            const container = dialog || document;
            
            const ratingDivs = container.querySelectorAll('div[role="img"][aria-label*="Rated"]');
            
            ratingDivs.forEach((ratingDiv, idx) => {
                try {
                    const ariaLabel = ratingDiv.getAttribute('aria-label') || '';
                    const ratingMatch = ariaLabel.match(/Rated (\d+) stars/);
                    const rating = ratingMatch ? parseInt(ratingMatch[1]) : 0;
                    
                    let reviewContainer = ratingDiv;
                    for (let i = 0; i < 8; i++) {
                        reviewContainer = reviewContainer.parentElement;
                        if (!reviewContainer) break;
                        const text = reviewContainer.textContent || '';
                        if (text.includes('Did you find this helpful') || text.includes('people found this review helpful')) {
                            break;
                        }
                    }
                    
                    if (!reviewContainer) return;
                    const fullText = reviewContainer.textContent || '';
                    
                    // Author
                    let author = '';
                    const headerArea = reviewContainer.querySelector('[role="banner"]') || reviewContainer.children[0];
                    if (headerArea) {
                        const imgs = headerArea.querySelectorAll('img');
                        for (const img of imgs) {
                            const sibling = img.nextElementSibling;
                            if (sibling) {
                                const text = sibling.textContent?.trim();
                                if (text && text.length > 2 && text.length < 50 && !text.includes('Rated')) {
                                    author = text;
                                    break;
                                }
                            }
                        }
                    }
                    
                    // Date
                    const dateMatch = fullText.match(/([A-Z][a-z]+ \d{1,2}, \d{4})/);
                    const date = dateMatch ? dateMatch[1] : '';
                    
                    // Helpful count
                    const helpfulMatch = fullText.match(/(\d+) people found this review helpful/);
                    const helpfulCount = helpfulMatch ? parseInt(helpfulMatch[1]) : 0;
                    
                    // Content
                    let content = '';
                    const allDivs = reviewContainer.querySelectorAll('div');
                    for (const div of allDivs) {
                        if (div.children.length > 0) continue;
                        const text = div.textContent?.trim() || '';
                        if (text.length > 40 && text.length < 3000 &&
                            !text.includes('people found') &&
                            !text.includes('Did you find') &&
                            !text.includes('help.') &&
                            !text.match(/^[A-Z][a-z]+ \d{1,2}, \d{4}$/)) {
                            // Skip if it looks like a developer name
                            if (!text.match(/^[A-Z][a-z]+ Inc\.$/) && !text.match(/^Square,? Inc\.?$/i)) {
                                content = text;
                                break;
                            }
                        }
                    }
                    
                    // Developer response
                    let developerResponse = null;
                    if (fullText.includes('Inc.') && fullText.includes('help.')) {
                        for (const div of allDivs) {
                            if (div.children.length > 0) continue;
                            const text = div.textContent?.trim() || '';
                            if (text.length > 40 && text.includes('help.')) {
                                developerResponse = text;
                                break;
                            }
                        }
                    }
                    
                    if (rating > 0 && content) {
                        results.push({
                            app: appName,
                            store: 'Play Store',
                            author: author || `Anonymous User ${idx + 1}`,
                            rating,
                            date,
                            content,
                            helpfulCount,
                            developerResponse
                        });
                    }
                } catch (e) {
                    // skip
                }
            });
            
            return results;
        }, config.name);
        
        // Deduplicate
        const uniqueReviews = [];
        const seen = new Set();
        for (const review of reviews) {
            const key = review.content.substring(0, 100);
            if (!seen.has(key)) {
                seen.add(key);
                uniqueReviews.push(review);
            }
        }
        
        // Save to JSON
        const jsonFile = `${appKey}_playstore_reviews.json`;
        fs.writeFileSync(jsonFile, JSON.stringify(uniqueReviews, null, 2));
        console.log(`\nSaved ${uniqueReviews.length} Play Store reviews to ${jsonFile}`);
        
        await browser.close();
        return uniqueReviews;
        
    } catch (error) {
        console.error('Error extracting Play Store reviews:', error.message);
        await browser.close();
        return [];
    }
}

// Convert JSON reviews to CSV
function convertToCSV(reviews, outputFile) {
    if (reviews.length === 0) {
        console.log('No reviews to convert to CSV');
        return;
    }
    
    // Define CSV headers
    const headers = ['app', 'store', 'author', 'rating', 'date', 'title', 'content', 'developerResponse', 'version', 'helpfulCount', 'voteCount', 'voteSum'];
    
    // Escape CSV field
    const escapeCSV = (field) => {
        if (field === null || field === undefined) return '';
        const str = String(field);
        if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    };
    
    // Build CSV content
    const rows = [headers.join(',')];
    for (const review of reviews) {
        const row = headers.map(header => escapeCSV(review[header] || ''));
        rows.push(row.join(','));
    }
    
    fs.writeFileSync(outputFile, rows.join('\n'));
    console.log(`Saved CSV to ${outputFile}`);
}

// Main extraction function
async function extractAllReviews(appKeys = null) {
    const targetApps = appKeys ? appKeys : Object.keys(APPS);
    const allReviews = {
        appStore: [],
        playStore: []
    };
    
    for (const appKey of targetApps) {
        const config = APPS[appKey];
        if (!config) {
            console.log(`Unknown app: ${appKey}`);
            continue;
        }
        
        // Extract App Store reviews
        const appStoreReviews = await extractAppStoreReviews(appKey, config);
        allReviews.appStore.push(...appStoreReviews);
        
        // Convert to CSV
        convertToCSV(appStoreReviews, `${appKey}_appstore_reviews.csv`);
        
        // Extract Play Store reviews
        const playStoreReviews = await extractPlayStoreReviews(appKey, config);
        allReviews.playStore.push(...playStoreReviews);
        
        // Convert to CSV
        convertToCSV(playStoreReviews, `${appKey}_playstore_reviews.csv`);
    }
    
    // Create combined files
    const allAppStoreReviews = allReviews.appStore;
    const allPlayStoreReviews = allReviews.playStore;
    const combinedReviews = [...allAppStoreReviews, ...allPlayStoreReviews];
    
    if (combinedReviews.length > 0) {
        fs.writeFileSync('all_reviews.json', JSON.stringify(combinedReviews, null, 2));
        convertToCSV(combinedReviews, 'all_reviews.csv');
        console.log(`\n${'='.repeat(60)}`);
        console.log(`SUMMARY`);
        console.log(`${'='.repeat(60)}`);
        console.log(`Total App Store reviews: ${allAppStoreReviews.length}`);
        console.log(`Total Play Store reviews: ${allPlayStoreReviews.length}`);
        console.log(`Combined total: ${combinedReviews.length}`);
    }
    
    return allReviews;
}

// CLI support
const args = process.argv.slice(2);
if (args.length > 0) {
    extractAllReviews(args);
} else {
    // Extract all configured apps
    extractAllReviews();
}

module.exports = { APPS, extractAppStoreReviews, extractPlayStoreReviews, extractAllReviews, convertToCSV };
