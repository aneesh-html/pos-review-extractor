const { chromium } = require('playwright');
const fs = require('fs');

const APP_URL = 'https://play.google.com/store/apps/details?id=com.shopify.pos&hl=en';
const OUTPUT_FILE = 'shopify_pos_reviews_playstore.json';

async function extractPlayStoreReviews() {
    console.log('Launching browser...');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 900 }
    });
    const page = await context.newPage();

    try {
        console.log(`Navigating to ${APP_URL}`);
        await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);

        // Click "See all reviews" button
        console.log('Looking for "See all reviews" button...');
        try {
            await page.click('button:has-text("See all reviews")', { timeout: 10000 });
            console.log('Clicked "See all reviews" button');
        } catch (e) {
            console.log('Could not find See all reviews button');
        }
        
        await page.waitForTimeout(2000);

        // Wait for dialog to open
        const dialogExists = await page.locator('[role="dialog"]').count() > 0;
        if (!dialogExists) {
            throw new Error('Reviews dialog did not open');
        }
        console.log('Reviews dialog opened');

        // Scroll to load more reviews
        console.log('Scrolling to load more reviews...');
        let lastCount = 0;
        let sameCount = 0;
        
        for (let i = 0; i < 200; i++) {
            // Get current review count
            const count = await page.locator('[role="dialog"] div[role="img"][aria-label*="Rated"]').count();
            
            if (count === lastCount) {
                sameCount++;
                if (sameCount >= 8) {
                    console.log(`Scrolled to end - found ${count} reviews`);
                    break;
                }
            } else {
                sameCount = 0;
                lastCount = count;
                if (i % 10 === 0) {
                    console.log(`Found ${count} reviews so far...`);
                }
            }
            
            // Scroll within the dialog - try multiple approaches
            await page.evaluate(() => {
                const dialog = document.querySelector('[role="dialog"]');
                if (!dialog) return;
                
                // Find the scrollable container
                const containers = dialog.querySelectorAll('div');
                for (const container of containers) {
                    const style = window.getComputedStyle(container);
                    if (style.overflowY === 'auto' || style.overflowY === 'scroll' || 
                        container.scrollHeight > container.clientHeight + 100) {
                        container.scrollBy(0, 800);
                        break;
                    }
                }
            });
            
            await page.waitForTimeout(300);
        }

        // Extract all reviews
        console.log('Extracting review data...');
        const reviews = await page.evaluate(() => {
            const results = [];
            const dialog = document.querySelector('[role="dialog"]');
            if (!dialog) return results;
            
            // Find all rating elements
            const ratingDivs = dialog.querySelectorAll('div[role="img"][aria-label*="Rated"]');
            
            ratingDivs.forEach((ratingDiv, idx) => {
                try {
                    // Extract rating
                    const ariaLabel = ratingDiv.getAttribute('aria-label') || '';
                    const ratingMatch = ariaLabel.match(/Rated (\d+) stars/);
                    const rating = ratingMatch ? parseInt(ratingMatch[1]) : 0;
                    
                    // Go up to find the review container
                    let container = ratingDiv;
                    for (let i = 0; i < 8; i++) {
                        container = container.parentElement;
                        if (!container) break;
                        const text = container.textContent || '';
                        if (text.includes('Did you find this helpful') || text.includes('people found this review helpful')) {
                            break;
                        }
                    }
                    
                    if (!container) return;
                    const fullText = container.textContent || '';
                    
                    // Find author - look for leaf div near an img element at the top
                    let author = '';
                    const headerArea = container.querySelector('[role="banner"]') || container.children[0];
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
                    
                    // Date - look for date pattern
                    const dateMatch = fullText.match(/([A-Z][a-z]+ \d{1,2}, \d{4})/);
                    const date = dateMatch ? dateMatch[1] : '';
                    
                    // Helpful count
                    const helpfulMatch = fullText.match(/(\d+) people found this review helpful/);
                    const helpfulCount = helpfulMatch ? parseInt(helpfulMatch[1]) : 0;
                    
                    // Review content - leaf divs with substantial text
                    let content = '';
                    const allDivs = container.querySelectorAll('div');
                    for (const div of allDivs) {
                        if (div.children.length > 0) continue;
                        const text = div.textContent?.trim() || '';
                        if (text.length > 40 && text.length < 2000 &&
                            !text.includes('people found') &&
                            !text.includes('Did you find') &&
                            !text.includes('Shopify Inc') &&
                            !text.includes('help.shopify.com') &&
                            !text.match(/^[A-Z][a-z]+ \d{1,2}, \d{4}$/)) {
                            content = text;
                            break;
                        }
                    }
                    
                    // Developer response
                    let developerResponse = null;
                    if (fullText.includes('Shopify Inc.')) {
                        for (const div of allDivs) {
                            if (div.children.length > 0) continue;
                            const text = div.textContent?.trim() || '';
                            if (text.length > 40 && text.includes('help.shopify.com')) {
                                // Find dev response date
                                const devDateMatch = fullText.match(/Shopify Inc\.\s*([A-Z][a-z]+ \d{1,2}, \d{4})/);
                                developerResponse = {
                                    author: 'Shopify Inc.',
                                    date: devDateMatch ? devDateMatch[1] : '',
                                    content: text
                                };
                                break;
                            }
                        }
                    }
                    
                    if (rating > 0 && content) {
                        results.push({
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
        });

        // Deduplicate by content
        const uniqueReviews = [];
        const seen = new Set();
        for (const review of reviews) {
            const key = review.content.substring(0, 100);
            if (!seen.has(key)) {
                seen.add(key);
                uniqueReviews.push(review);
            }
        }

        console.log(`Extracted ${uniqueReviews.length} unique reviews`);

        // Save to JSON
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(uniqueReviews, null, 2));
        console.log(`Reviews saved to ${OUTPUT_FILE}`);

        return uniqueReviews;

    } catch (error) {
        console.error('Error extracting reviews:', error.message);
        throw error;
    } finally {
        await browser.close();
    }
}

// Run the extraction
extractPlayStoreReviews()
    .then(reviews => {
        console.log(`\nSuccessfully extracted ${reviews.length} reviews from Google Play Store`);
        if (reviews.length > 0) {
            console.log('\nSample review:');
            console.log(JSON.stringify(reviews[0], null, 2));
        }
    })
    .catch(error => {
        console.error('Failed to extract reviews:', error);
        process.exit(1);
    });
