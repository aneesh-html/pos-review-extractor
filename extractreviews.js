const { chromium } = require('playwright');
const fs = require('fs');

const APP_ID = '686830644';
const COUNTRY = 'au';
const APP_URL = `https://apps.apple.com/${COUNTRY}/app/shopify-point-of-sale-pos/id${APP_ID}?see-all=reviews&platform=iphone`;

// Apple's RSS feed for reviews - can fetch up to 500 reviews across 10 pages
async function fetchReviewsFromAPI(browser) {
  const allReviews = [];
  const page = await browser.newPage();
  
  // Apple RSS feed provides up to 50 reviews per page, 10 pages max
  for (let pageNum = 1; pageNum <= 10; pageNum++) {
    const feedUrl = `https://itunes.apple.com/${COUNTRY}/rss/customerreviews/page=${pageNum}/id=${APP_ID}/sortby=mostrecent/json`;
    
    try {
      console.log(`Fetching page ${pageNum} from Apple RSS feed...`);
      const response = await page.goto(feedUrl, { waitUntil: 'networkidle', timeout: 30000 });
      const content = await page.content();
      
      // Extract JSON from the page
      const bodyText = await page.evaluate(() => document.body.textContent);
      const data = JSON.parse(bodyText);
      
      if (!data.feed || !data.feed.entry) {
        console.log(`No more reviews on page ${pageNum}`);
        break;
      }
      
      const entries = Array.isArray(data.feed.entry) ? data.feed.entry : [data.feed.entry];
      
      // First entry might be app info, skip it
      const reviews = entries.filter(entry => entry['im:rating']);
      
      if (reviews.length === 0) {
        console.log(`No reviews found on page ${pageNum}`);
        break;
      }
      
      for (const entry of reviews) {
        allReviews.push({
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
      
      console.log(`Found ${reviews.length} reviews on page ${pageNum}`);
      
    } catch (error) {
      console.log(`Error fetching page ${pageNum}:`, error.message);
      break;
    }
  }
  
  await page.close();
  return allReviews;
}

async function extractReviews() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  
  // First try to get reviews from Apple's RSS feed (more reviews)
  console.log('\n--- Fetching reviews from Apple RSS Feed ---');
  const apiReviews = await fetchReviewsFromAPI(browser);
  
  if (apiReviews.length > 0) {
    console.log(`\nTotal reviews from RSS feed: ${apiReviews.length}`);
    await browser.close();
    return apiReviews;
  }
  
  // Fallback to scraping the web page
  console.log('\nRSS feed empty, falling back to web scraping...');
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    console.log('Navigating to reviews page...');
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 60000 });

    // Wait for reviews to load
    await page.waitForSelector('article', { timeout: 30000 });

    // Scroll to load more reviews if available
    console.log('Scrolling to load more reviews...');
    let previousHeight = 0;
    let scrollAttempts = 0;
    const maxScrollAttempts = 10;

    while (scrollAttempts < maxScrollAttempts) {
      const currentHeight = await page.evaluate(() => document.body.scrollHeight);
      if (currentHeight === previousHeight) break;
      
      previousHeight = currentHeight;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
      scrollAttempts++;
    }

    console.log('Extracting reviews...');
    const reviews = await page.evaluate(() => {
      const reviewElements = document.querySelectorAll('article');
      const extractedReviews = [];

      reviewElements.forEach((article) => {
        // Skip rating summary articles (they have different structure)
        const heading = article.querySelector('h3');
        if (!heading) return;

        const title = heading.textContent?.trim() || '';
        if (!title) return;

        // Extract star rating from ol.stars aria-label (e.g., "5 Stars")
        let rating = 0;
        const starList = article.querySelector('ol.stars[aria-label]');
        if (starList) {
          const ariaLabel = starList.getAttribute('aria-label');
          const match = ariaLabel?.match(/(\d+)\s*Star/i);
          if (match) {
            rating = parseInt(match[1], 10);
          }
        }

        // Extract date and author
        const timeElement = article.querySelector('time');
        const date = timeElement?.textContent?.trim() || '';

        // Author is typically in a paragraph next to time
        const authorParagraph = article.querySelector('time')?.parentElement?.querySelector('p');
        const author = authorParagraph?.textContent?.trim() || '';

        // Extract review content - find paragraphs that are direct children's content
        // The review content comes first, before developer response section
        const contentContainers = article.querySelectorAll('div > p, section > p');
        let content = '';
        let developerResponse = '';
        let inDevResponse = false;

        // Walk through all paragraphs in order
        const allParagraphs = article.querySelectorAll('p');
        const devResponseMarker = article.textContent?.indexOf('Developer Response') || -1;
        
        allParagraphs.forEach((p) => {
          const text = p.textContent?.trim() || '';
          if (!text || text === author || text.length < 20) return;
          
          // Check position relative to "Developer Response" text
          const pText = p.textContent || '';
          const parentText = p.parentElement?.textContent || '';
          
          // If this paragraph is inside a section with "Developer Response" label
          if (parentText.includes('Developer Response') && !pText.includes('Developer Response')) {
            if (!developerResponse) {
              developerResponse = text;
            }
          } else if (!content && text.length > 30 && !parentText.includes('Developer Response')) {
            // First substantial paragraph that's not in dev response is the review
            content = text;
          }
        });

        if (title && (content || rating)) {
          extractedReviews.push({
            title,
            rating,
            date,
            author,
            content,
            developerResponse
          });
        }
      });

      return extractedReviews;
    });

    console.log(`Found ${reviews.length} reviews from web scraping`);

    return reviews;
  } catch (error) {
    console.error('Error extracting reviews:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

// Run the extraction
extractReviews()
  .then((reviews) => {
    // Save to JSON file
    const outputPath = './shopify_pos_reviews.json';
    fs.writeFileSync(outputPath, JSON.stringify(reviews, null, 2));
    console.log(`Reviews saved to ${outputPath}`);

    // Print summary
    console.log('\n--- Reviews Summary ---');
    reviews.slice(0, 10).forEach((review, index) => {
      console.log(`\n${index + 1}. "${review.title}" - ${review.rating} star(s) by ${review.author} (${review.date})`);
      if (review.content) {
        console.log(`   ${review.content.substring(0, 100)}...`);
      }
    });
    if (reviews.length > 10) {
      console.log(`\n... and ${reviews.length - 10} more reviews`);
    }
    
    console.log(`\nSuccessfully extracted ${reviews.length} reviews`);
    process.exit(0);
  })
  .catch((error) => {
    console.error('Failed to extract reviews:', error);
    process.exit(1);
  });
