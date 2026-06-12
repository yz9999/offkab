const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// ─── Configuration ───────────────────────────────────────────────
const BASE_URL = 'https://sukebei.nyaa.si';
const USER_URL = `${BASE_URL}/user/offkab`;
const SEARCH_PARAMS = 'f=0&c=0_0&q=fc2';
// Image hosts use varying domains but always /upload/ path pattern
const IMAGES_DIR = path.join(__dirname, 'public', 'images');
const DATA_FILE = path.join(__dirname, 'public', 'data.json');
const SOURCE_DIR = __dirname; // where local source files live
const DELAY_MS = 1500; // delay between requests
const USE_LOCAL_FIRST = true; // prefer local source files if they exist

// ─── Helpers ─────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchHTML(url) {
  console.log(`  📥 Fetching: ${url}`);
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

/**
 * Try to read from a local source file first; fall back to network fetch.
 * Local files are named by their URL key:
 *   - Listing pages: "offkab" (main listing), "offkab_p2", "offkab_p3", etc.
 *   - View pages: "4609637" (the view ID)
 *   - Image pages: "xbXI0KoItbaHpXi-FC2-PPV-4908119.jpg" (the filename part)
 */
function tryReadLocal(localFilename) {
  const localPath = path.join(SOURCE_DIR, localFilename);
  if (fs.existsSync(localPath)) {
    console.log(`  📂 Reading local source: ${localFilename}`);
    return fs.readFileSync(localPath, 'utf-8');
  }
  return null;
}

async function getHTML(url, localKey) {
  if (USE_LOCAL_FIRST && localKey) {
    const local = tryReadLocal(localKey);
    if (local) return local;
  }
  return await fetchHTML(url);
}

async function downloadImage(url, filepath) {
  console.log(`  📷 Downloading image: ${path.basename(filepath)}`);
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Referer': url,
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filepath, buffer);
  console.log(`  ✅ Saved: ${path.basename(filepath)} (${(buffer.length / 1024).toFixed(1)} KB)`);
}

function decodeHTMLEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#10;/g, '\n')
    .replace(/&#39;/g, "'");
}

// ─── Step 1: Scrape listing pages ────────────────────────────────
async function scrapeListingPage(page) {
  const url = `${USER_URL}?${SEARCH_PARAMS}&p=${page}`;
  console.log(`\n📄 Scraping listing page ${page}...`);

  // Local file: "offkab" for page 1/default, "offkab_p2", "offkab_p3", etc.
  const localKey = page === 1 ? 'offkab' : `offkab_p${page}`;
  const html = await getHTML(url, localKey);
  const $ = cheerio.load(html);
  const items = [];

  $('table.torrent-list tbody tr').each((_, row) => {
    const $row = $(row);
    const $titleLink = $row.find('td[colspan="2"] a');
    if (!$titleLink.length) return;

    const viewPath = $titleLink.attr('href');
    const title = $titleLink.attr('title') || $titleLink.text().trim();
    const viewId = viewPath ? viewPath.replace('/view/', '') : null;

    // Magnet link
    const $magnetLink = $row.find('a[href^="magnet:"]');
    let magnet = $magnetLink.attr('href') || '';
    magnet = decodeHTMLEntities(magnet);

    // Size and stats
    const $cells = $row.find('td.text-center');
    const size = $cells.eq(1).text().trim();
    const date = $cells.eq(2).text().trim();
    const seeders = parseInt($cells.eq(3).text().trim()) || 0;
    const leechers = parseInt($cells.eq(4).text().trim()) || 0;
    const downloads = parseInt($cells.eq(5).text().trim()) || 0;

    if (viewId) {
      items.push({
        viewId,
        viewUrl: `${BASE_URL}${viewPath}`,
        title,
        magnet,
        size,
        date,
        seeders,
        leechers,
        downloads,
        thumbnailUrls: [],
        fullImageUrls: [],
        localImages: []
      });
    }
  });

  // Check if there are more pages
  const hasNextPage = $('ul.pagination li:last-child').not('.disabled').length > 0 && items.length > 0;
  return { items, hasNextPage };
}

async function scrapeAllListings(existingIds) {
  let allItems = [];
  let page = 1;

  while (true) {
    try {
      const { items, hasNextPage } = await scrapeListingPage(page);
      if (items.length === 0) {
        console.log(`  📭 No items found on page ${page}, stopping.`);
        break;
      }
      const newItemsOnPage = items.filter(item => !existingIds.has(item.viewId));
      allItems = allItems.concat(items);
      console.log(`  ✅ Found ${items.length} items on page ${page} (${newItemsOnPage.length} new) (total: ${allItems.length})`);

      // If there are no new items on this page, it means we've caught up with our local DB
      // We can safely stop crawling further pages.
      if (newItemsOnPage.length === 0) {
        console.log(`  ⏭️  All items on page ${page} already exist locally. Stopping pagination to save time!`);
        break;
      }

      if (!hasNextPage) {
        console.log(`  🏁 No more pages after page ${page}.`);
        break;
      }
      page++;
      await sleep(DELAY_MS);
    } catch (err) {
      console.error(`  ❌ Error on page ${page}:`, err.message);
      break;
    }
  }

  return allItems;
}

// ─── Step 2: Scrape view pages for image URLs ────────────────────
async function scrapeViewPage(item) {
  console.log(`\n🔍 Scraping view page: ${item.viewId} - ${item.title.substring(0, 50)}...`);

  try {
    // Local file key is the view ID, e.g., "4609637"
    const html = await getHTML(item.viewUrl, item.viewId);
    const $ = cheerio.load(html);

    // Extract image URLs from description - offkab uses many image hosts
    // but they all follow the pattern: https://DOMAIN/upload/RANDOM-FC2-PPV-XXXX.jpg
    const fullHtml = $.html();
    const imgRegex = /https?:\/\/[a-z0-9.-]+\.[a-z]{2,}\/upload\/[A-Za-z0-9_-]+-FC2[^\s"'<>\]]*\.(?:jpg|jpeg|png|gif|webp)/gi;
    const matches = fullHtml.match(imgRegex) || [];

    // Deduplicate
    const uniqueUrls = [...new Set(matches)];
    item.thumbnailUrls = uniqueUrls;
    console.log(`  📸 Found ${uniqueUrls.length} thumbnail URLs`);
  } catch (err) {
    console.error(`  ❌ Error scraping view ${item.viewId}:`, err.message);
  }
}

// ─── Step 3: Resolve actual image URLs from hosting pages ────────
async function resolveImageUrl(thumbnailUrl) {
  // Convert thumbnail URL to the /en/ viewer page URL
  // e.g., https://hentai-manga.org/upload/xbXI0KoItbaHpXi-FC2-PPV-4908119.jpg
  //     → https://hentai-manga.org/upload/en/xbXI0KoItbaHpXi-FC2-PPV-4908119.jpg
  const urlObj = new URL(thumbnailUrl);
  const host = urlObj.origin; // e.g., https://hentai-manga.org or https://xxpics.org
  const pathParts = urlObj.pathname.split('/');
  const filename = pathParts[pathParts.length - 1];

  // Construct the /en/ page URL
  const viewerUrl = `${host}/upload/en/${filename}`;

  try {
    // Local file key is the filename, e.g., "xbXI0KoItbaHpXi-FC2-PPV-4908119.jpg"
    const html = await getHTML(viewerUrl, filename);
    const $ = cheerio.load(html);

    // Method 1: Extract from og:image meta tag
    let actualUrl = $('meta[property="og:image"]').attr('content');

    // Method 2: Extract from the main image src
    if (!actualUrl) {
      actualUrl = $('div.fileviewer-file img').attr('src');
    }

    // Method 3: Look for the Application/storage path
    if (!actualUrl) {
      const imgMatch = html.match(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}\/upload\/Application\/storage\/[^\s"'<>]+\.(?:jpg|jpeg|png|gif|webp)/i);
      if (imgMatch) actualUrl = imgMatch[0];
    }

    if (actualUrl) {
      console.log(`  🔗 Resolved: ${filename} → ${path.basename(actualUrl)}`);
      return { thumbnailUrl, viewerUrl, actualUrl, filename };
    }
  } catch (err) {
    console.error(`  ❌ Error resolving ${filename}:`, err.message);
  }

  return { thumbnailUrl, viewerUrl, actualUrl: null, filename };
}

// ─── Step 4: Download images ─────────────────────────────────────
async function downloadImages(item) {
  if (!item.thumbnailUrls.length) return;

  console.log(`\n💾 Downloading images for: ${item.viewId}`);

  for (const thumbUrl of item.thumbnailUrls) {
    try {
      const resolved = await resolveImageUrl(thumbUrl);
      await sleep(DELAY_MS);

      if (resolved.actualUrl) {
        const ext = path.extname(resolved.actualUrl.split('?')[0]) || '.jpg';
        const localFilename = `${item.viewId}_${resolved.filename.replace(/\.[^.]+$/, '')}${ext}`;
        const localPath = path.join(IMAGES_DIR, localFilename);

        if (!fs.existsSync(localPath)) {
          await downloadImage(resolved.actualUrl, localPath);
          await sleep(DELAY_MS);
        } else {
          console.log(`  ⏭️  Already exists: ${localFilename}`);
        }

        item.fullImageUrls.push(resolved.actualUrl);
        item.localImages.push(`/images/${localFilename}`);
      }
    } catch (err) {
      console.error(`  ❌ Error downloading image:`, err.message);
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Offkab FC2 Scraper Starting...\n');
  console.log('═══════════════════════════════════════════════════');
  console.log(`   Local source mode: ${USE_LOCAL_FIRST ? 'ON (prefer local files)' : 'OFF (network only)'}`);

  // Ensure directories exist
  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  // Scan for available local source files
  const localFiles = fs.readdirSync(SOURCE_DIR).filter(f => {
    const p = path.join(SOURCE_DIR, f);
    return fs.statSync(p).isFile() && !f.endsWith('.js') && !f.endsWith('.json') && !f.endsWith('.css') && !f.startsWith('.');
  });
  if (localFiles.length > 0) {
    console.log(`   Found ${localFiles.length} local source file(s): ${localFiles.join(', ')}`);
  }

  // Load existing data if available (for resuming)
  let existingData = [];
  if (fs.existsSync(DATA_FILE)) {
    try {
      existingData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      console.log(`📂 Loaded ${existingData.length} existing entries from data.json`);
    } catch (e) {
      console.log('📂 Starting fresh (no existing data)');
    }
  }
  const existingIds = new Set(existingData.map(e => e.viewId));

  // Load blacklist
  const blacklistFile = path.join(__dirname, 'public', 'blacklist.json');
  if (fs.existsSync(blacklistFile)) {
    try {
      const blacklist = JSON.parse(fs.readFileSync(blacklistFile, 'utf-8'));
      blacklist.forEach(id => existingIds.add(id));
      console.log(`🚫 Loaded ${blacklist.length} blacklisted items (will be skipped)`);
    } catch (e) {}
  }

  // Step 1: Scrape all listing pages
  console.log('\n═══ Step 1: Scraping listing pages ═══════════════');
  const allItems = await scrapeAllListings(existingIds);
  console.log(`\n📊 Total items scanned: ${allItems.length}`);

  // Filter out already scraped items
  let newItems = allItems.filter(item => !existingIds.has(item.viewId));

  // Check for command line limits (e.g. manual mode limits to 20)
  const limitArg = process.argv.find(arg => arg.startsWith('--limit='));
  if (limitArg) {
    const limit = parseInt(limitArg.split('=')[1], 10);
    if (limit && limit > 0 && newItems.length > limit) {
      console.log(`\n🛑 限制获取数量为: ${limit} (找到 ${newItems.length} 个新项目)`);
      newItems = newItems.slice(0, limit);
    }
  }
  
  if (newItems.length === 0) {
    console.log(`\n🎉 No new items to scrape. Everything is up to date!`);
    return;
  }

  console.log(`📊 New items to process: ${newItems.length}`);

  // Step 2: Scrape view pages for image URLs
  console.log('\n═══ Step 2: Scraping view pages for images ═══════');
  for (let i = 0; i < newItems.length; i++) {
    const item = newItems[i];
    console.log(`\n[${i + 1}/${newItems.length}]`);
    await scrapeViewPage(item);
    await sleep(DELAY_MS);
  }

  // Step 3 & 4: Resolve and download images
  console.log('\n═══ Step 3: Resolving & downloading images ════════');
  for (let i = 0; i < newItems.length; i++) {
    const item = newItems[i];
    console.log(`\n[${i + 1}/${newItems.length}]`);
    await downloadImages(item);
  }

  // Merge with existing data
  const finalData = [...existingData, ...newItems];

  // Save data
  console.log('\n═══ Saving data ═══════════════════════════════════');
  fs.writeFileSync(DATA_FILE, JSON.stringify(finalData, null, 2), 'utf-8');
  console.log(`✅ Saved ${finalData.length} entries to data.json`);

  // Summary
  console.log('\n═══════════════════════════════════════════════════');
  console.log('🎉 Scraping complete!');
  console.log(`   Total entries: ${finalData.length}`);
  console.log(`   New entries: ${newItems.length}`);
  const totalImages = finalData.reduce((sum, item) => sum + item.localImages.length, 0);
  console.log(`   Total images: ${totalImages}`);
  console.log(`\n   Run "npm start" to launch the gallery server.`);
}

main().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
