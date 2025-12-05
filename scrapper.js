import { execSync } from "child_process";
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import pLimit from "p-limit";
import { pipeline } from "stream/promises";
import { parse } from "csv-parse/sync";

const MAX_CONCURRENT_DOWNLOADS = 6;
const SCROLL_PAUSE_MS = 500;
const MAX_SCROLLS = 80;
const USE_PROXY = false;
const HEADLESS = false;
const MIN_WIDTH = 1;
const MIN_HEIGHT = 1;

function getProxy() {
  if (!USE_PROXY) return null;
  try {
    const proxy = execSync("python freeproxies.py").toString().trim();
    console.log("Using proxy:", proxy);
    return proxy;
  } catch (err) {
    console.error("Could not fetch proxy:", err.message);
    return null;
  }
}

let fetchFn = globalThis.fetch;

function sanitizeFilename(name) {
  if (!name) return 'unnamed';
  return name.replace(/[:\/\\?%*|"<>]/g, '-').slice(0, 220);
}

function sanitizeFolderName(name) {
  if (!name) return 'unnamed';
  return name.replace(/[:\/\\?%*|"<>]/g, '-').trim();
}

async function autoScroll(page) {
  await page.evaluate(({ SCROLL_PAUSE_MS, MAX_SCROLLS }) => {
    return new Promise(async (resolve) => {
      const distance = Math.max(300, Math.floor(window.innerHeight * 0.8));
      let lastHeight = document.body.scrollHeight;
      
      for (let i = 0; i < MAX_SCROLLS; i++) {
        window.scrollBy(0, distance);
        await new Promise(res => setTimeout(res, SCROLL_PAUSE_MS));
        
        const currentHeight = document.body.scrollHeight;
        if ((window.innerHeight + window.scrollY) >= currentHeight - 100) {
          await new Promise(res => setTimeout(res, SCROLL_PAUSE_MS * 2));
          if (currentHeight === lastHeight) break;
        }
        lastHeight = currentHeight;
      }
      
      for (let i = 0; i < 5; i++) {
        window.scrollBy(0, -window.innerHeight);
        await new Promise(res => setTimeout(res, SCROLL_PAUSE_MS));
      }
      
      window.scrollTo({ top: 0, behavior: 'instant' });
      await new Promise(res => setTimeout(res, 500));
      resolve();
    });
  }, { SCROLL_PAUSE_MS, MAX_SCROLLS });
}

async function waitForImages(page) {
  try {
    await page.waitForFunction(() => {
      const images = Array.from(document.querySelectorAll('img'));
      if (images.length === 0) return false;
      const loaded = images.filter(img => img.complete && img.naturalHeight > 0);
      return loaded.length > 0;
    }, { timeout: 10000 });
  } catch (e) {
    // Timeout is okay, continue
  }
}

async function extractFromDOM(page, minWidth, minHeight) {
  return page.evaluate(({ minWidth, minHeight }) => {
    function pickBestFromSrcset(srcset) {
      if (!srcset) return null;
      const parts = srcset.split(',').map(s => s.trim()).filter(Boolean);
      let best = parts[parts.length - 1]?.split(' ')[0];
      try {
        let bestW = 0;
        for (const p of parts) {
          const [url, desc] = p.split(/\s+/);
          if (!desc) { best = url; continue; }
          const m = desc.match(/(\d+)w/);
          if (m) {
            const w = parseInt(m[1], 10);
            if (w > bestW) { bestW = w; best = url; }
          } else {
            best = url;
          }
        }
      } catch (e) { /* ignore */ }
      return best;
    }

    const urlMap = new Map();
    const stats = { 
      imgTags: 0, 
      sources: 0, 
      backgrounds: 0, 
      meta: 0, 
      dataAttrs: 0,
      lazyImages: 0,
      filtered: 0
    };

    try {
      const imgElements = document.querySelectorAll('img');
      stats.imgTags = imgElements.length;
      
      imgElements.forEach(img => {
        // Check dimensions
        const width = img.naturalWidth || img.width || 0;
        const height = img.naturalHeight || img.height || 0;
        
        if (width < minWidth || height < minHeight) {
          stats.filtered++;
          return;
        }
        
        const dimensions = { width, height };
        
        const attrs = [
          'src', 'data-src', 'data-original', 'data-lazy-src', 
          'data-srcset', 'data-original-src', 'data-fallback-src',
          'data-lazy', 'data-lazy-srcset', 'data-desktop-src',
          'data-mobile-src', 'data-tablet-src', 'data-retina-src',
          'data-img-src', 'data-image-src', 'data-zoom-image',
          'data-full-src', 'data-high-res-src'
        ];
        
        let foundAny = false;
        attrs.forEach(attr => {
          const val = img.getAttribute(attr);
          if (val && val.trim() && !val.startsWith('data:')) {
            urlMap.set(val.trim(), dimensions);
            foundAny = true;
          }
        });
        
        if (foundAny) stats.lazyImages++;

        if (img.currentSrc && !img.currentSrc.startsWith('data:')) {
          urlMap.set(img.currentSrc, dimensions);
        }
        if (img.src && !img.src.startsWith('data:')) {
          urlMap.set(img.src, dimensions);
        }
        
        const srcset = img.getAttribute('srcset');
        if (srcset) {
          srcset.split(',').forEach(part => {
            const url = part.trim().split(/\s+/)[0];
            if (url && !url.startsWith('data:')) urlMap.set(url, dimensions);
          });
        }
      });
    } catch (e) { 
      console.error('Error extracting img tags:', e);
    }

    try {
      const sources = document.querySelectorAll('picture source, source, picture img');
      stats.sources = sources.length;
      
      sources.forEach(s => {
        const width = s.naturalWidth || s.width || 0;
        const height = s.naturalHeight || s.height || 0;
        
        if (width < minWidth || height < minHeight) {
          stats.filtered++;
          return;
        }
        
        const dimensions = { width, height };
        
        const attrs = ['src', 'data-src', 'srcset', 'data-srcset', 'data-original'];
        attrs.forEach(attr => {
          const val = s.getAttribute(attr);
          if (val && !val.startsWith('data:')) {
            if (attr.includes('srcset')) {
              val.split(',').forEach(part => {
                const url = part.trim().split(/\s+/)[0];
                if (url) urlMap.set(url, dimensions);
              });
            } else {
              urlMap.set(val, dimensions);
            }
          }
        });
      });
    } catch (e) { 
      console.error('Error extracting sources:', e);
    }

    try {
      const allElements = document.querySelectorAll('*');
      allElements.forEach(el => {
        try {
          const width = el.offsetWidth || 0;
          const height = el.offsetHeight || 0;
          
          if (width < minWidth || height < minHeight) return;
          
          const dimensions = { width, height };
          
          const inlineStyle = el.getAttribute('style');
          if (inlineStyle && inlineStyle.includes('background')) {
            const re = /url\(['"]?(.*?)['"]?\)/g;
            let m;
            while ((m = re.exec(inlineStyle)) !== null) {
              if (m[1] && !m[1].startsWith('data:')) {
                urlMap.set(m[1], dimensions);
                stats.backgrounds++;
              }
            }
          }
          
          if (width > 200 && height > 200) {
            const cs = getComputedStyle(el);
            const bg = cs.backgroundImage;
            if (bg && bg !== 'none') {
              const re = /url\(['"]?(.*?)['"]?\)/g;
              let m;
              while ((m = re.exec(bg)) !== null) {
                if (m[1] && !m[1].startsWith('data:')) {
                  urlMap.set(m[1], dimensions);
                  stats.backgrounds++;
                }
              }
            }
          }
        } catch (e) { /* ignore */ }
      });
    } catch (e) { 
      console.error('Error extracting backgrounds:', e);
    }

    try {
      const selectors = [
        'meta[property="og:image"]',
        'meta[property="og:image:secure_url"]',
        'meta[name="twitter:image"]',
        'meta[name="twitter:image:src"]',
        'link[rel="image_src"]',
        'link[rel="apple-touch-icon"]'
      ];
      
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          const content = el.content || el.href;
          if (content && !content.startsWith('data:')) {
            urlMap.set(content, { meta: true });
            stats.meta++;
          }
        });
      });
    } catch (e) { 
      console.error('Error extracting meta:', e);
    }

    try {
      document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
        try {
          const data = JSON.parse(script.textContent);
          const findImages = (obj) => {
            if (!obj || typeof obj !== 'object') return;
            if (Array.isArray(obj)) {
              obj.forEach(findImages);
            } else {
              Object.keys(obj).forEach(key => {
                if ((key === 'image' || key === 'thumbnail' || key === 'url') && typeof obj[key] === 'string') {
                  if (!obj[key].startsWith('data:')) urlMap.set(obj[key], { jsonLD: true });
                } else if (typeof obj[key] === 'object') {
                  findImages(obj[key]);
                }
              });
            }
          };
          findImages(data);
        } catch (e) { /* ignore */ }
      });
    } catch (e) {
      console.error('Error extracting JSON-LD:', e);
    }

    const results = [];
    for (const [u, dimensions] of urlMap.entries()) {
      try {
        const cleaned = u.trim();
        if (!cleaned || cleaned === 'about:blank' || cleaned.startsWith('data:')) continue;
        
        let absolute;
        try {
          absolute = new URL(cleaned, document.baseURI).toString();
        } catch {
          absolute = new URL(cleaned).toString();
        }
        
        results.push({ url: absolute, dimensions });
      } catch (e) { 
        if (u.includes('http')) {
          console.warn('Invalid URL skipped:', u.substring(0, 100));
        }
      }
    }
    
    return {
      images: results,
      stats,
      pageInfo: {
        title: document.title,
        url: window.location.href,
        imgTagsVisible: Array.from(document.querySelectorAll('img')).filter(img => 
          img.offsetWidth > 0 && img.offsetHeight > 0
        ).length
      }
    };
  }, { minWidth, minHeight });
}

function setupNetworkCapture(page, networkSet) {
  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return;
      
      const ct = (response.headers()['content-type'] || '').toLowerCase();
      
      if (ct.startsWith('image/') || ct.startsWith('video/')) {
        networkSet.add(url);
        return;
      }
      
      const urlLower = url.toLowerCase();
      const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif'];
      if (imageExts.some(ext => urlLower.includes(ext))) {
        networkSet.add(url);
      }
    } catch (e) { /* ignore */ }
  });
  
  page.on('request', request => {
    try {
      const url = request.url();
      const resourceType = request.resourceType();
      if (resourceType === 'image' && url.startsWith('http')) {
        networkSet.add(url);
      }
    } catch (e) { /* ignore */ }
  });
}

async function downloadToFile(url, outFolder, referer, cookies, index) {
  try {
    const u = new URL(url);
    const ext = path.extname(u.pathname) || '';
    const baseCandidate = path.basename(u.pathname) || `image-${index}`;
    let fname = sanitizeFilename(baseCandidate);
    if (!path.extname(fname) && ext) fname = fname + ext;
    
    fs.mkdirSync(outFolder, { recursive: true });
    
    const filename = path.join(outFolder, `${String(index).padStart(4, '0')}-${fname}`);
    
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': referer || u.origin,
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br'
    };
    
    if (cookies && cookies.length) {
      headers['Cookie'] = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    }
    
    const res = await fetchFn(url, { 
      headers, 
      redirect: 'follow',
      signal: AbortSignal.timeout(30000)
    });
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const dest = fs.createWriteStream(filename);
    await pipeline(res.body, dest);
    return { ok: true, url, filename };
  } catch (err) {
    return { ok: false, url, error: err?.message || String(err) };
  }
}

async function scrapeWebsite(target, folderName, browser, baseOutputDir) {
  const outDir = path.join(baseOutputDir, sanitizeFolderName(folderName));
  fs.mkdirSync(outDir, { recursive: true });
  
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🎯 Processing: ${folderName}`);
  console.log(`🌐 URL: ${target}`);
  console.log(`📁 Output: ${outDir}`);
  console.log(`📐 Min Resolution: ${MIN_WIDTH}x${MIN_HEIGHT}`);
  console.log('='.repeat(80));
  
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      permissions: ['geolocation'],
      colorScheme: 'light',
      deviceScaleFactor: 1
    });
    
    const page = await context.newPage();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {} };
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );
    });

    const networkImgs = new Set();
    setupNetworkCapture(page, networkImgs);

    console.log('🌐 Navigating to page...');
    
    try {
      await page.goto(target, { waitUntil: 'load', timeout: 60000 });
      console.log('✓ Page loaded');
    } catch (err) {
      console.log('⚠️  Initial load timeout, trying domcontentloaded...');
      try {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch (err2) {
        console.log('⚠️  Navigation had issues, continuing anyway...');
      }
    }

    console.log('⏳ Waiting for dynamic content...');
    await page.waitForTimeout(3000);
    await waitForImages(page);
    
    console.log('📜 Scrolling to load lazy content...');
    await autoScroll(page);
    await page.waitForTimeout(2000);

    console.log('🔍 Extracting image URLs...');
    const domResult = await extractFromDOM(page, MIN_WIDTH, MIN_HEIGHT);
    const domImages = domResult.images;
    
    const netImgsArr = Array.from(networkImgs);
    
    const imageMap = new Map();
    domImages.forEach(({ url, dimensions }) => {
      imageMap.set(url, dimensions);
    });
    
    netImgsArr.forEach(url => {
      if (!imageMap.has(url)) {
        imageMap.set(url, {});
      }
    });
    
    let images = Array.from(imageMap.keys())
      .filter(url => url && (url.startsWith('http://') || url.startsWith('https://')));
    
    images = images.filter((url) => {
      const lowerUrl = url.toLowerCase();
      if (lowerUrl.match(/\/[\w-]*(?:track|analytics|beacon|pixel|1x1)[\w-]*/)) return false;
      if (lowerUrl.match(/doubleclick|googleads|googlesyndication/)) return false;
      return true;
    });

    console.log(`\n✨ Found ${images.length} images (≥${MIN_WIDTH}x${MIN_HEIGHT})`);
    if (domResult.stats.filtered > 0) {
      console.log(`🔍 Filtered out ${domResult.stats.filtered} images below resolution threshold`);
    }

    if (images.length === 0) {
      console.log('\n❌ No images found meeting resolution criteria.');
      
      const screenshotPath = path.join(outDir, 'debug-screenshot.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`📸 Debug screenshot: ${screenshotPath}`);
      
      await context.close();
      return {
        folderName,
        target,
        success: false,
        downloaded: 0,
        failed: 0,
        message: 'No images found meeting resolution criteria'
      };
    }

    const cookies = await context.cookies();

    console.log('💾 Downloading images...');
    const limit = pLimit(MAX_CONCURRENT_DOWNLOADS);
    
    const tasks = images.map((url, index) => {
      return limit(() => downloadToFile(url, outDir, target, cookies, index + 1));
    });

    const results = await Promise.all(tasks);
    await context.close();

    const successes = results.filter(r => r.ok);
    const fails = results.filter(r => !r.ok);

    console.log(`\n✅ Downloaded ${successes.length}/${results.length} images`);

    const summary = {
      target,
      folderName,
      timestamp: new Date().toISOString(),
      minResolution: `${MIN_WIDTH}x${MIN_HEIGHT}`,
      totalCandidates: images.length,
      filtered: domResult.stats.filtered,
      downloaded: successes.length,
      failed: fails.length,
      files: successes.map(s => ({ 
        url: s.url, 
        file: path.basename(s.filename)
      }))
    };
    
    const summaryPath = path.join(outDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    
    return {
      folderName,
      target,
      success: true,
      downloaded: successes.length,
      failed: fails.length
    };
    
  } catch (err) {
    console.error(`\n💥 Error processing ${folderName}:`, err.message);
    return {
      folderName,
      target,
      success: false,
      downloaded: 0,
      failed: 0,
      error: err.message
    };
  }
}

async function main() {
  try {
    const argv = process.argv.slice(2);
    if (argv.length < 1) {
      console.log('Usage: node scrape-images.js <csv_file> [output_base_dir]');
      console.log('\nCSV Format:');
      console.log('url,folder_name');
      console.log('https://www.dodge.com/2026/charger.html,dodge-charger-2026');
      console.log('https://www.volvo.com/en/cars/ex90/,volvo-ex90');
      console.log(`\nNote: Only downloads images with resolution ≥${MIN_WIDTH}x${MIN_HEIGHT}`);
      process.exit(1);
    }
    
    const csvPath = argv[0];
    const baseOutputDir = argv[1] || './downloads';
    
    if (!fs.existsSync(csvPath)) {
      console.error(`❌ CSV file not found: ${csvPath}`);
      process.exit(1);
    }
    
    console.log('📄 Reading CSV file...');
    const csvContent = fs.readFileSync(csvPath, 'utf-8');
    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });
    
    if (records.length === 0) {
      console.error('❌ No records found in CSV file');
      process.exit(1);
    }
    
    console.log(`✅ Found ${records.length} websites to scrape`);
    console.log(`📐 Resolution filter: ≥${MIN_WIDTH}x${MIN_HEIGHT}\n`);
    
    // Validate CSV structure
    for (let i = 0; i < records.length; i++) {
      if (!records[i].url || !records[i].folder_name) {
        console.error(`❌ Invalid CSV row ${i + 1}: missing url or folder_name`);
        console.error('Expected columns: url, folder_name');
        process.exit(1);
      }
    }
    
    fs.mkdirSync(baseOutputDir, { recursive: true });
    
    const proxyServer = getProxy();
    
    console.log('🚀 Launching browser...');
    const browser = await chromium.launch({ 
      headless: HEADLESS,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ],
      ...(proxyServer ? { proxy: { server: proxyServer } } : {})
    });
    
    const allResults = [];
    
    for (let i = 0; i < records.length; i++) {
      const { url, folder_name } = records[i];
      console.log(`\n[${i + 1}/${records.length}] Starting: ${folder_name}`);
      
      const result = await scrapeWebsite(url, folder_name, browser, baseOutputDir);
      allResults.push(result);
      
      // Small delay between scrapes
      if (i < records.length - 1) {
        console.log('\n⏸️  Pausing 3 seconds before next site...');
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
    
    await browser.close();
    
    // Final summary
    console.log('\n' + '='.repeat(80));
    console.log('📊 FINAL SUMMARY');
    console.log('='.repeat(80));
    
    const successful = allResults.filter(r => r.success);
    const failed = allResults.filter(r => !r.success);
    
    console.log(`\n✅ Successfully processed: ${successful.length}/${records.length}`);
    console.log(`📥 Total images downloaded: ${successful.reduce((sum, r) => sum + r.downloaded, 0)}`);
    console.log(`📐 Resolution filter: ≥${MIN_WIDTH}x${MIN_HEIGHT}`);
    
    if (successful.length > 0) {
      console.log('\nSuccessful downloads:');
      successful.forEach(r => {
        console.log(`  ✓ ${r.folderName}: ${r.downloaded} images`);
      });
    }
    
    if (failed.length > 0) {
      console.log(`\n❌ Failed: ${failed.length}`);
      failed.forEach(r => {
        console.log(`  ✗ ${r.folderName}: ${r.error || r.message}`);
      });
    }
    
    // Write overall summary
    const overallSummary = {
      timestamp: new Date().toISOString(),
      minResolution: `${MIN_WIDTH}x${MIN_HEIGHT}`,
      totalSites: records.length,
      successful: successful.length,
      failed: failed.length,
      totalImagesDownloaded: successful.reduce((sum, r) => sum + r.downloaded, 0),
      results: allResults
    };
    
    const summaryPath = path.join(baseOutputDir, 'overall-summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(overallSummary, null, 2));
    console.log(`\n📄 Overall summary: ${summaryPath}`);
    
  } catch (err) {
    console.error('\n💥 Fatal error:', err);
    process.exit(1);
  }
}

main();