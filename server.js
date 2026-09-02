import express from 'express';
import gplay from 'google-play-scraper';
import axios from 'axios';
import * as cheerio from 'cheerio';

const app = express();
app.use(express.json());

// CORS: allow Google Apps Script / spreadsheet add-on clients.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ENRICHER_API_KEY || '';
const MAX_BATCH_SIZE = 50;
const CONCURRENCY = 5;          // parallel lookups inside a batch
const JOB_TTL_MS = 60 * 60 * 1000; // keep finished jobs for 1 hour
const APP_TIMEOUT_MS = 45 * 1000;      // max time per single app lookup
const JOB_TIMEOUT_MS = 15 * 60 * 1000; // max time for a whole job

// Reject after ms so one hung lookup/crawl can never freeze a job.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out')), ms))
  ]);
}

// In-memory job store: jobId -> { status, results, error, createdAt }
const jobs = new Map();
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) if (job.createdAt < cutoff) jobs.delete(id);
}, 10 * 60 * 1000).unref();

// Run async tasks over items with a concurrency limit.
// onProgress(results) is called after each item finishes so long-running batches
// can expose partial results (used by the async /jobs API).
async function runWithConcurrency(items, limit, worker, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
      if (onProgress) onProgress(results);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

// Wrap async route handlers so rejected promises reach the global error handler.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Simple auth middleware
function authMiddleware(req, res, next) {
  if (!API_KEY) return next();
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (token !== API_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// ---------- URL parsers ----------

function extractGooglePlayId(urlOrId) {
  const value = String(urlOrId || '').trim();
  const match = value.match(/[?&]id=([^&#]+)/i);
  if (match) return decodeURIComponent(match[1]);
  return /^[a-zA-Z][a-zA-Z0-9_.]+$/.test(value) ? value : '';
}

function extractAppStoreId(urlOrId) {
  const value = String(urlOrId || '').trim();
  const pathMatch = value.match(/\/id(\d+)(?:[\/?#]|$)/i);
  if (pathMatch) return pathMatch[1];
  return /^\d+$/.test(value) ? value : '';
}

function classifyAppUrl(value) {
  const v = String(value || '').trim();
  if (/^https?:\/\/play\.google\.com\/store\/apps\/details\?/i.test(v) && extractGooglePlayId(v)) return 'GOOGLE_PLAY';
  if (/^https?:\/\/(?:apps|itunes)\.apple\.com\//i.test(v) && extractAppStoreId(v)) return 'APP_STORE';
  return '';
}

// ---------- Contact crawler ----------

async function crawlContacts(websiteUrl) {
  if (!websiteUrl) return { email: '', contactPage: '', socialProfiles: [] };
  
  const socialDomains = ['facebook.com', 'twitter.com', 'x.com', 'linkedin.com', 'instagram.com', 'youtube.com', 'tiktok.com', 'pinterest.com'];
  const result = { email: '', contactPage: '', socialProfiles: [] };
  
  try {
    const res = await axios.get(websiteUrl, {
      timeout: 8000,
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = res.data;
    const $ = cheerio.load(html);
    
    // Extract email from page text
    const pageText = $('body').text();
    const emailMatch = pageText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (emailMatch) result.email = emailMatch[0];
    
    // Look for contact page
    const contactKeywords = ['contact', 'about', 'support', 'help', 'reach-us'];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().toLowerCase();
      if (contactKeywords.some(k => text.includes(k) || href.toLowerCase().includes(k))) {
        if (!result.contactPage) {
          try {
            result.contactPage = new URL(href, websiteUrl).href;
          } catch { /* ignore */ }
        }
      }
      // Social profiles
      try {
        const fullUrl = new URL(href, websiteUrl).href;
        if (socialDomains.some(d => fullUrl.includes(d))) {
          if (!result.socialProfiles.includes(fullUrl)) result.socialProfiles.push(fullUrl);
        }
      } catch { /* ignore */ }
    });
    
    // If no email found on homepage, try contact page
    if (!result.email && result.contactPage) {
      try {
        const contactRes = await axios.get(result.contactPage, {
          timeout: 8000,
          maxRedirects: 5,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const contactEmail = contactRes.data.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (contactEmail) result.email = contactEmail[0];
      } catch { /* ignore */ }
    }
  } catch (error) {
    // Silently fail - contact crawling is best-effort
  }
  
  return result;
}

// ---------- Google Play enrichment ----------

async function enrichGooglePlay(url) {
  const appId = extractGooglePlayId(url);
  if (!appId) throw new Error('Invalid Google Play URL or app ID');
  
  const data = await gplay.app({ appId });
  
  // Try to get extra contact info from developer website
  const website = data.developerWebsite || '';
  const contactInfo = website ? await crawlContacts(website) : { email: '', contactPage: '', socialProfiles: [] };
  
  return {
    storeLabel: 'Google Play',
    appId: data.appId || appId,
    bundleId: data.appId || appId,
    appName: data.title || '',
    developer: data.developer || '',
    developerEmail: data.developerEmail || contactInfo.email || '',
    developerWebsite: website,
    developerProfile: data.developerId ? `https://play.google.com/store/apps/dev?id=${data.developerId}` : '',
    developerPhone: data.developerLegalPhoneNumber || '',
    developerAddress: data.developerAddress || '',
    developerContactPage: contactInfo.contactPage || '',
    developerSocialProfiles: contactInfo.socialProfiles,
    privacyPolicy: data.privacyPolicy || '',
    installs: data.installs || (data.minInstalls ? String(data.minInstalls) : ''),
    rating: data.score ?? '',
    ratingCount: data.ratings ?? '',
    category: data.genre || '',
    price: data.price ?? '',
    currency: data.currency || '',
    version: data.version || '',
    updatedAt: data.updated || '',
    icon: data.icon || '',
    storeUrl: data.url || url
  };
}

// ---------- App Store enrichment ----------

async function enrichAppStore(url) {
  const appId = extractAppStoreId(url);
  if (!appId) throw new Error('Invalid App Store URL or app ID');
  
  // Use iTunes Lookup API (free, public, no key needed)
  const lookupRes = await axios.get('https://itunes.apple.com/lookup', {
    params: { id: appId },
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  
  const results = lookupRes.data?.results || [];
  if (!results.length) throw new Error('App not found on iTunes Lookup API');
  
  const d = results[0];
  const website = d.sellerUrl || '';
  const contactInfo = website ? await crawlContacts(website) : { email: '', contactPage: '', socialProfiles: [] };
  
  return {
    storeLabel: 'Apple App Store',
    appId: String(d.trackId || appId),
    bundleId: d.bundleId || '',
    appName: d.trackName || '',
    developer: d.sellerName || d.artistName || '',
    developerEmail: contactInfo.email || '',
    developerWebsite: website,
    developerProfile: d.artistViewUrl || '',
    developerPhone: '',
    developerAddress: '',
    developerContactPage: contactInfo.contactPage || '',
    developerSocialProfiles: contactInfo.socialProfiles,
    privacyPolicy: '', // iTunes API does not expose privacyPolicy; can be scraped separately if needed
    installs: '', // Not available via iTunes API
    rating: d.averageUserRating ?? '',
    ratingCount: d.userRatingCount ?? '',
    category: d.primaryGenreName || '',
    price: d.price ?? '',
    currency: d.currency || '',
    version: d.version || '',
    updatedAt: d.currentVersionReleaseDate || '',
    icon: d.artworkUrl512 || d.artworkUrl100 || '',
    storeUrl: d.trackViewUrl || url
  };
}

// ---------- Routes ----------

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'free-app-enricher', version: '1.1.1' });
});

async function enrichOne(inputUrl) {
  const store = classifyAppUrl(inputUrl);
  if (!store) {
    return { inputUrl, store: '', ok: false, error: 'Unrecognized app store URL', data: null };
  }
  try {
    const lookup = store === 'GOOGLE_PLAY' ? enrichGooglePlay(inputUrl) : enrichAppStore(inputUrl);
    const data = await withTimeout(lookup, APP_TIMEOUT_MS, 'Lookup for ' + inputUrl);
    return { inputUrl, store, ok: true, data };
  } catch (error) {
    return { inputUrl, store, ok: false, error: error.message || 'Lookup failed', data: null };
  }
}

// Synchronous batch (small batches / manual testing).
app.post('/enrich-batch', authMiddleware, asyncHandler(async (req, res) => {
  const { urls } = req.body || {};
  if (!Array.isArray(urls) || !urls.length) {
    return res.status(400).json({ ok: false, error: 'urls array required' });
  }
  if (urls.length > MAX_BATCH_SIZE) {
    return res.status(400).json({ ok: false, error: `Max ${MAX_BATCH_SIZE} URLs per batch` });
  }
  const results = await runWithConcurrency(urls, CONCURRENCY, enrichOne);
  res.json({ ok: true, results });
}));

// Async job API (used by the Google Sheets script): start a job, poll for it.
app.post('/jobs', authMiddleware, asyncHandler((req, res) => {
  const { urls } = req.body || {};
  if (!Array.isArray(urls) || !urls.length) {
    return res.status(400).json({ ok: false, error: 'urls array required' });
  }
  if (urls.length > MAX_BATCH_SIZE) {
    return res.status(400).json({ ok: false, error: `Max ${MAX_BATCH_SIZE} URLs per job` });
  }
  const jobId = 'job-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  jobs.set(jobId, { status: 'running', results: null, error: '', createdAt: Date.now() });
  setTimeout(() => {
    const job = jobs.get(jobId);
    if (job && job.status === 'running') {
      job.status = 'failed';
      job.error = 'Job timed out after ' + Math.round(JOB_TIMEOUT_MS / 60000) + ' minutes';
      console.log('Job ' + jobId + ' timed out');
    }
  }, JOB_TIMEOUT_MS).unref();
  runWithConcurrency(
    urls,
    CONCURRENCY,
    enrichOne,
    (partial) => {
      const job = jobs.get(jobId);
      if (job && job.status === 'running') {
        job.results = partial.filter(r => r !== undefined);
      }
    }
  )
    .then(results => {
      const job = jobs.get(jobId);
      if (job) { job.status = 'done'; job.results = results; }
    })
    .catch(error => {
      const job = jobs.get(jobId);
      if (job) { job.status = 'failed'; job.error = error.message || 'Job failed'; }
    });
  console.log(`Job ${jobId} started with ${urls.length} URL(s)`);
  res.status(202).json({ ok: true, jobId, status: 'running' });
}));

app.get('/jobs/:id', authMiddleware, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found or expired' });
  res.json({ ok: true, jobId: req.params.id, status: job.status, error: job.error, results: job.results });
});

// Global error handler — prevents unhandled exceptions in async routes from crashing the process.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack || err.message || err);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`Free App Enricher running on port ${PORT}`);
  if (API_KEY) console.log('API key protection enabled');
  else console.log('No API key configured (open access)');
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down gracefully...`);
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
