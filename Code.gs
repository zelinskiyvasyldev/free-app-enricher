/**
 * Google Sheets -> SELF-HOSTED Google Play + Apple App Store enricher. $0 per app.
 *
 * Data service: your own local server (free-app-enricher/server.js), using
 *   - Google Play: free google-play-scraper library (+ developer website contact crawl)
 *   - Apple App Store: Apple's free official iTunes Lookup API (+ contact crawl)
 *
 * Because Google Apps Script runs in Google's cloud, the local server must be
 * reachable through a public tunnel URL. start-enricher.bat runs tunnel.js,
 * which opens a pinggy tunnel, renews it before the 60-minute free-tier
 * expiry, and publishes each new URL to a private ntfy channel. Paste the
 * channel's AUTO-UPDATE CODE once via menu item "2. Set URL auto-update
 * channel" and the sheet always finds the current URL by itself (menu item
 * "2b. Set enricher server URL" still works for manual setup).
 *
 * One batch contains up to 50 mixed-store app URLs, sent to the server as one
 * async job (POST /jobs, polled via GET /jobs/:id) so Apps Script never hits
 * HTTP timeouts while the server crawls developer websites.
 *
 * Self-hosted conversion (2026-08-26): Apify backend replaced by local-server
 * job API (setEnricherServer/testEnricherServer, startServerJob_/pollServerJob_).
 * All batching, locking, dedupe, and failure-isolation logic is unchanged from
 * the Apify version, whose fix log follows:
 *
 * Fix log (2026-08-20):
 *   - CRITICAL: pending-batch entries were serialized into script properties with
 *     live Sheet objects and full column maps. Sheet objects stringify to {} and the
 *     payload exceeded the 9 KB property-value limit, so every batch broke when the
 *     next trigger tick tried to write results. Entries are now stored as slim
 *     {sheetName, row, url, store} records and re-resolved against the spreadsheet.
 *   - Result-to-row matching now uses store + appId (with URL fallback) instead of
 *     exact URL strings, so rows no longer get a false "result missing" error.
 *   - Transient Apify poll failures are now bounded (5 consecutive failures -> run
 *     marked failed) instead of polling forever.
 *   - Corrupt/oversized state properties are parsed defensively instead of throwing.
 *   - App Store website/profile fields use sellerUrl/artistViewUrl fallbacks
 *     (freshactors/app-store-scraper does not guarantee sellerUrl/artistId).
 *
 * Fix log (2026-08-21) — "stops after the first batch":
 *   - "Run next batch now" could orphan a long batch: the manual polling loop ends
 *     after ~2 minutes but a 50-app details run often takes longer, and no trigger
 *     existed to keep polling. Manual mode now hands over to the minute trigger
 *     automatically when a run is still in progress.
 *   - Batches are no longer all-or-nothing: if one store's run fails, the other
 *     store's results are still written and only the failed store's rows get ERROR.
 *   - Run state no longer stores the full URL list (results are matched by appId),
 *     keeping the runs property far below the 9 KB limit for long URLs.
 */

const CONFIG = Object.freeze({
  STORE_TABS: Object.freeze({
    GOOGLE_PLAY: 'Google Play',
    APP_STORE: 'App Store'
  }),
  INPUT_HEADERS: Object.freeze(['App URL', 'Google Play URL', 'App Store URL']),
  BATCH_SIZE: 50,
  MAX_POLL_FAILURES: 5,
  MAX_JOB_MINUTES: 20,
  SERVER_URL_PROPERTY: 'FREE_APP_ENRICHER_SERVER_URL',
  NTFY_TOPIC_PROPERTY: 'FREE_APP_ENRICHER_NTFY_TOPIC',
  SERVER_KEY_PROPERTY: 'FREE_APP_ENRICHER_SERVER_KEY',
  SERVER_JOB_PROPERTY: 'FREE_APP_ENRICHER_SERVER_JOB',
  RUNS_ENTRIES_PROPERTY: 'FREE_APP_ENRICHER_RUNS_ENTRIES',
  AUTOMATION_PROPERTY: 'FREE_APP_ENRICHER_AUTOMATION',
  SPREADSHEET_PROPERTY: 'FREE_APP_ENRICHER_SPREADSHEET_ID',
  LAST_ERROR_PROPERTY: 'FREE_APP_ENRICHER_LAST_ERROR',
  CONSECUTIVE_FAILURES_PROPERTY: 'FREE_APP_ENRICHER_CONSECUTIVE_FAILURES',
  MAX_CONSECUTIVE_FAILURES: 3,
  LOCK_PROPERTY: 'FREE_APP_ENRICHER_SOFT_LOCK',
  LOCK_TIMEOUT_MS: 2 * 60 * 1000,
  TRIGGER_HANDLER: 'automaticEnrichmentTick'
});

const OUTPUT_HEADERS = Object.freeze([
  'Store',
  'App ID',
  'Bundle ID',
  'App Name',
  'Developer',
  'Developer Email',
  'Developer Website',
  'Developer Profile',
  'Developer Phone',
  'Developer Address',
  'Developer Contact Page',
  'Developer Social Profiles',
  'Contact Pages Crawled',
  'Privacy Policy',
  'Installs',
  'Rating',
  'Rating Count',
  'Category',
  'Price',
  'Currency',
  'Version',
  'Store Updated At',
  'Icon URL',
  'Store URL',
  'Enrichment Status',
  'Enriched At'
]);

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Free App Enricher')
    .addItem('1. Setup store tabs', 'setupStoreTabs')
    .addItem('2. Set URL auto-update channel (recommended)', 'setUrlChannel')
    .addItem('2b. Set enricher server URL (manual fallback)', 'setEnricherServer')
    .addItem('3. Test server connection', 'testEnricherServer')
    .addItem('4. Start automatic enrichment', 'startAutomaticEnrichment')
    .addItem('Run next batch now', 'runNextBatchNow')
    .addItem('Show automation status', 'showAutomationStatus')
    .addSeparator()
    .addItem('Stop automatic enrichment', 'stopAutomaticEnrichment')
    .addItem('Retry failed / interrupted rows', 'retryFailedRows')
    .addItem('Re-enrich all rows (keep data)', 'resetAllRowsForReenrichment')
    .addItem('Find apps with no contact info', 'findAppsWithNoContact')
    .addItem('🚨 Emergency stop & clear lock', 'emergencyStopAndClearLock')
    .addToUi();
}

function setupStoreTabs() {
  const spreadsheet = SpreadsheetApp.getActive();
  const sourceSheet = spreadsheet.getActiveSheet();
  const sourceHeaders = sourceSheet.getLastColumn()
    ? sourceSheet.getRange(1, 1, 1, sourceSheet.getLastColumn()).getDisplayValues()[0]
    : [];
  const tabs = {};
  tabs.GOOGLE_PLAY = ensureStoreSheet_(spreadsheet, CONFIG.STORE_TABS.GOOGLE_PLAY, sourceHeaders);
  tabs.APP_STORE = ensureStoreSheet_(spreadsheet, CONFIG.STORE_TABS.APP_STORE, sourceHeaders);

  const copied = copyRowsToStoreTabs_(sourceSheet, tabs);
  spreadsheet.setActiveSheet(tabs.GOOGLE_PLAY);
  SpreadsheetApp.getUi().alert(
    'Store tabs are ready.\n\n' +
    'Copied to Google Play: ' + copied.GOOGLE_PLAY + '\n' +
    'Copied to App Store: ' + copied.APP_STORE + '\n' +
    'Duplicates skipped: ' + copied.duplicates + '\n\n' +
    'No source rows were deleted or cleared.'
  );
}

function ensureStoreSheet_(spreadsheet, name, extraHeaders) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) sheet = spreadsheet.insertSheet(name);
  const required = ['App URL'].concat(OUTPUT_HEADERS);
  (extraHeaders || []).forEach(header => {
    const normalized = normalizeHeader_(header);
    const isInputAlias = CONFIG.INPUT_HEADERS.some(input => normalizeHeader_(input) === normalized);
    if (normalized && !isInputAlias) required.push(String(header).trim());
  });

  let headers = sheet.getLastColumn()
    ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0]
    : [];
  let normalizedHeaders = headers.map(normalizeHeader_);
  if (!headers.some(header => String(header || '').trim())) {
    const initial = uniqueHeaders_(required);
    ensureSheetCapacity_(sheet, 1, initial.length);
    sheet.getRange(1, 1, 1, initial.length).setValues([initial]);
    headers = initial;
    normalizedHeaders = headers.map(normalizeHeader_);
  } else {
    uniqueHeaders_(required).forEach(header => {
      if (normalizedHeaders.indexOf(normalizeHeader_(header)) !== -1) return;
      ensureSheetCapacity_(sheet, 1, sheet.getLastColumn() + 1);
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(header);
      normalizedHeaders.push(normalizeHeader_(header));
    });
  }

  const color = name === CONFIG.STORE_TABS.GOOGLE_PLAY ? '#188038' : '#333333';
  sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .setFontWeight('bold')
    .setBackground(color)
    .setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 420);
  return sheet;
}

function uniqueHeaders_(headers) {
  const seen = {};
  return headers.filter(header => {
    const normalized = normalizeHeader_(header);
    if (!normalized || seen[normalized]) return false;
    seen[normalized] = true;
    return true;
  });
}

function copyRowsToStoreTabs_(sourceSheet, tabs) {
  const copied = { GOOGLE_PLAY: 0, APP_STORE: 0, duplicates: 0 };
  if (sourceSheet.getLastRow() < 2 || !sourceSheet.getLastColumn()) return copied;
  const sourceHeaders = sourceSheet
    .getRange(1, 1, 1, sourceSheet.getLastColumn())
    .getDisplayValues()[0];
  const normalizedSourceHeaders = sourceHeaders.map(normalizeHeader_);
  const sourceColumns = { __inputs: [] };
  CONFIG.INPUT_HEADERS.forEach(header => {
    const index = normalizedSourceHeaders.indexOf(normalizeHeader_(header));
    if (index !== -1) sourceColumns.__inputs.push({ header: header, column: index + 1 });
  });
  if (!sourceColumns.__inputs.length) return copied;

  const rowCount = sourceSheet.getLastRow() - 1;
  const sourceValues = sourceSheet.getRange(2, 1, rowCount, sourceSheet.getLastColumn()).getValues();
  const sourceDisplay = sourceSheet.getRange(2, 1, rowCount, sourceSheet.getLastColumn()).getDisplayValues();
  const destinationState = {};
  Object.keys(tabs).forEach(store => {
    const sheet = tabs[store];
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
    const headerMap = {};
    headers.forEach((header, index) => { headerMap[normalizeHeader_(header)] = index; });
    const columns = ensureColumns_(sheet);
    const existing = {};
    if (sheet.getLastRow() >= 2) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn())
        .getDisplayValues()
        .forEach(row => {
          const input = getInputFromRow_(row, columns);
          const key = getAppDedupeKey_(input.url, input.store);
          if (key) existing[key] = true;
        });
    }
    destinationState[store] = { sheet: sheet, headers: headers, headerMap: headerMap, existing: existing, rows: [] };
  });

  sourceValues.forEach((sourceRow, index) => {
    const input = getInputFromRow_(sourceDisplay[index], sourceColumns);
    if (!input.store || !tabs[input.store]) return;
    const state = destinationState[input.store];
    const key = getAppDedupeKey_(input.url, input.store);
    if (!key || state.existing[key]) {
      if (key) copied.duplicates++;
      return;
    }
    const destinationRow = Array(state.headers.length).fill('');
    sourceHeaders.forEach((header, sourceIndex) => {
      const normalized = normalizeHeader_(header);
      if (CONFIG.INPUT_HEADERS.some(inputHeader => normalizeHeader_(inputHeader) === normalized)) return;
      const destinationIndex = state.headerMap[normalized];
      if (destinationIndex !== undefined) destinationRow[destinationIndex] = sourceRow[sourceIndex];
    });
    destinationRow[state.headerMap[normalizeHeader_('App URL')]] = input.url;
    state.rows.push(destinationRow);
    state.existing[key] = true;
    copied[input.store]++;
  });

  Object.keys(destinationState).forEach(store => {
    const state = destinationState[store];
    if (!state.rows.length) return;
    ensureSheetCapacity_(state.sheet, state.sheet.getLastRow() + state.rows.length, state.headers.length);
    state.sheet
      .getRange(state.sheet.getLastRow() + 1, 1, state.rows.length, state.headers.length)
      .setValues(state.rows);
  });
  return copied;
}

function setEnricherServer() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    'Set enricher server URL (manual fallback)',
    'Paste the public tunnel URL of your local server (e.g. https://xxxxx.free.pinggy.net).\n\nPrefer menu item 2 (Set URL auto-update channel) so the sheet finds the current URL automatically.',
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const url = response.getResponseText().trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) {
    ui.alert('A full http(s) URL is required.');
    return;
  }
  const keyResponse = ui.prompt(
    'Server API key (optional)',
    'If your server was started with ENRICHER_API_KEY, paste it here. Leave empty otherwise.',
    ui.ButtonSet.OK_CANCEL
  );
  if (keyResponse.getSelectedButton() !== ui.Button.OK) return;
  const properties = PropertiesService.getScriptProperties();
  properties.setProperty(CONFIG.SERVER_URL_PROPERTY, url);
  const key = keyResponse.getResponseText().trim();
  if (key) properties.setProperty(CONFIG.SERVER_KEY_PROPERTY, key);
  else properties.deleteProperty(CONFIG.SERVER_KEY_PROPERTY);
  ui.alert('Enricher server saved: ' + url);
}

/**
 * Menu 2b: stores the ntfy "auto-update channel" code shown by start-enricher.bat.
 * Once set, the sheet asks the channel for the current tunnel URL whenever it
 * runs, so tunnel restarts / 60-minute renewals / PC reboots never require
 * pasting a new URL again.
 */
function setUrlChannel() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    'Set URL auto-update channel (recommended)',
    'Paste the AUTO-UPDATE CODE shown in the tunnel window on your PC ' +
    '(looks like app-enricher-xxxxxxxxxxxxxxxx). Leave empty to disable auto-update.',
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const topic = response.getResponseText().trim();
  const properties = PropertiesService.getScriptProperties();
  if (!topic) {
    properties.deleteProperty(CONFIG.NTFY_TOPIC_PROPERTY);
    ui.alert('URL auto-update disabled. You can still set the URL manually with menu item 2b.');
    return;
  }
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(topic)) {
    ui.alert('That does not look like a valid code. Copy the AUTO-UPDATE CODE exactly as shown in the tunnel window.');
    return;
  }
  properties.setProperty(CONFIG.NTFY_TOPIC_PROPERTY, topic);
  if (refreshServerUrlFromChannel_()) {
    ui.alert('Auto-update channel saved and current URL fetched:\n' + getServerUrl_());
  } else {
    ui.alert(
      'Channel saved, but no URL was published yet.\n\n' +
      'Make sure start-enricher.bat is running on your PC and wait ~15 seconds, ' +
      'then use menu item 3 (Test server connection) - it will pick up the URL automatically.'
    );
  }
}

/**
 * Fetches the latest tunnel URL that the local tunnel.js published to the
 * ntfy channel and stores it as the server URL when it changed. Safe to call
 * on every automation tick: failures are non-fatal. Retries a few times
 * because ntfy occasionally rate-limits or drops requests from Google's
 * shared IP pool (HTTP 429/5xx), which previously left a stale URL in place.
 */
function refreshServerUrlFromChannel_() {
  const properties = PropertiesService.getScriptProperties();
  const topic = properties.getProperty(CONFIG.NTFY_TOPIC_PROPERTY);
  if (!topic) return false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) Utilities.sleep(1500 * attempt);
    let response;
    try {
      response = UrlFetchApp.fetch(
        'https://ntfy.sh/' + encodeURIComponent(topic) + '/raw?poll=1',
        { muteHttpExceptions: true }
      );
    } catch (error) {
      console.warn('URL channel fetch attempt ' + attempt + '/3 failed: ' + error.message);
      continue;
    }
    const code = response.getResponseCode();
    if (code !== 200) {
      console.warn('URL channel fetch attempt ' + attempt + '/3: HTTP ' + code);
      continue;
    }
    // The channel may hold several cached messages; the newest one wins.
    const lines = String(response.getContentText() || '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    const url = lines.reverse().find(line => /^https:\/\//i.test(line));
    if (!url) return false; // channel reachable but nothing published yet
    const clean = url.replace(/\/+$/, '');
    if (clean !== (properties.getProperty(CONFIG.SERVER_URL_PROPERTY) || '')) {
      properties.setProperty(CONFIG.SERVER_URL_PROPERTY, clean);
      console.info('Server URL auto-updated from channel: ' + clean);
    }
    return true;
  }
  return false;
}

function testEnricherServer() {
  const properties = PropertiesService.getScriptProperties();
  const hasChannel = !!properties.getProperty(CONFIG.NTFY_TOPIC_PROPERTY);
  refreshServerUrlFromChannel_();
  let lastError = '';
  // Two rounds: if the health check fails and an auto-update channel is set,
  // re-fetch the channel (its earlier fetch may have been rate-limited) and
  // try once more against the freshest URL.
  for (let round = 1; round <= (hasChannel ? 2 : 1); round++) {
    if (round > 1) {
      Utilities.sleep(3000);
      refreshServerUrlFromChannel_();
    }
    const serverUrl = getServerUrl_();
    try {
      const response = UrlFetchApp.fetch(serverUrl + '/health', {
        headers: serverHeaders_(),
        muteHttpExceptions: true
      });
      const code = response.getResponseCode();
      const body = parseJsonResponse_(response.getContentText(), 'server health check');
      if (code >= 200 && code < 300 && body.ok) {
        SpreadsheetApp.getUi().alert('Server connection successful: ' + (body.service || 'free-app-enricher') + ' v' + (body.version || '?') + '\nURL: ' + serverUrl);
        return;
      }
      lastError = 'HTTP ' + code + ' at ' + serverUrl;
    } catch (error) {
      lastError = error.message + ' at ' + serverUrl;
    }
  }
  throw new Error(
    'Server connection failed (' + lastError + '). ' +
    'Check that both enricher windows are running on your PC' +
    (hasChannel ? ' and that the code in menu 2 matches the tunnel window.' : ' and that the URL in menu 2b is current.')
  );
}

function startAutomaticEnrichment() {
  getServerUrl_();
  const spreadsheet = SpreadsheetApp.getActive();
  const sheets = getManagedStoreSheets_(spreadsheet);
  if (sheets.length !== 2) {
    SpreadsheetApp.getUi().alert('Choose Free App Enricher > Setup store tabs first.');
    return;
  }
  let pendingCount = 0;
  sheets.forEach(sheet => {
    const columns = ensureColumns_(sheet);
    recoverInterruptedRows_(sheet, columns);
    pendingCount += getPendingRows_(sheet, columns).length;
  });
  if (!pendingCount) {
    SpreadsheetApp.getUi().alert('No pending app URLs were found.');
    return;
  }

  const properties = PropertiesService.getScriptProperties();
  properties.setProperties({
    [CONFIG.AUTOMATION_PROPERTY]: 'TRUE',
    [CONFIG.SPREADSHEET_PROPERTY]: spreadsheet.getId()
  });
  properties.deleteProperty(CONFIG.LAST_ERROR_PROPERTY);
  ensureAutomationTrigger_();
  runLocked_(function() { processAutomation_(false); });
  SpreadsheetApp.getUi().alert(
    'Enrichment started for ' + pendingCount + ' pending row(s).\n\n' +
    'Each batch contains up to ' + CONFIG.BATCH_SIZE + ' mixed Apple/Google URLs.'
  );
}

function runNextBatchNow() {
  getServerUrl_();
  runLocked_(function() {
    let result = processAutomation_(true);
    // If we just started runs, block and poll a few times so one menu click can finish a batch.
    let attempts = 0;
    while (result && result.started && attempts < 12) {
      Utilities.sleep(10000);
      result = processAutomation_(true);
      attempts++;
    }
    if (result && result.running) {
      // A 50-app details run can outlive this manual polling loop. Hand over to
      // the minute trigger so the batch finishes on its own instead of stalling.
      const spreadsheet = SpreadsheetApp.getActive();
      PropertiesService.getScriptProperties().setProperties({
        [CONFIG.AUTOMATION_PROPERTY]: 'TRUE',
        [CONFIG.SPREADSHEET_PROPERTY]: spreadsheet.getId()
      });
      ensureAutomationTrigger_();
      spreadsheet.toast(
        'Enricher job still in progress. Automatic continuation is ON — the batch will finish on its own.',
        'Free App Enricher', 8
      );
    }
  });
}

function automaticEnrichmentTick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  const myToken = 'trigger-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  setSoftLock_(Date.now(), myToken);
  try {
    processAutomation_(false);
  } catch (error) {
    // A lock collision from a manual run is not a real error; do not log it.
    if (!/Another enrichment process is currently running/i.test(error.message)) {
      PropertiesService.getScriptProperties().setProperty(
        CONFIG.LAST_ERROR_PROPERTY,
        new Date().toISOString() + ' - ' + error.message
      );
      console.error(error);
    }
  } finally {
    clearSoftLockIfOwned_(myToken);
    try { lock.releaseLock(); } catch (e) { /* ignore */ }
  }
}

function runLocked_(callback) {
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  const myToken = 'lock-' + now + '-' + Math.random().toString(36).slice(2, 8);
  const lock = LockService.getScriptLock();

  // First try the real script lock. If we get it, also write a soft lock so
  // other instances can see who owns it, then run the callback.
  try {
    lock.waitLock(5000);
    setSoftLock_(now, myToken);
    try { return callback(); }
    finally {
      clearSoftLockIfOwned_(myToken);
      try { lock.releaseLock(); } catch (e) { /* ignore */ }
    }
  } catch (hardLockError) {
    try { lock.releaseLock(); } catch (e) { /* ignore */ }
  }

  // Hard lock is held by another execution. Check the soft lock timestamp.
  // If the previous owner has not updated it for LOCK_TIMEOUT_MS, assume it
  // died (dead tunnel, script timeout, etc.) and steal the lock so the user
  // does not have to wait six minutes for Apps Script to clean up.
  const softLock = parseJsonProperty_(props.getProperty(CONFIG.LOCK_PROPERTY), null);
  if (softLock && softLock.startedAt && (now - softLock.startedAt) < CONFIG.LOCK_TIMEOUT_MS) {
    throw new Error('Another enrichment process is currently running. Please wait 30–60 seconds and try again.');
  }

  console.warn('LockService is held and soft lock is stale; stealing lock from dead process.');
  setSoftLock_(now, myToken);
  try { return callback(); }
  finally { clearSoftLockIfOwned_(myToken); }
}

function setSoftLock_(timestamp, token) {
  PropertiesService.getScriptProperties().setProperty(
    CONFIG.LOCK_PROPERTY,
    JSON.stringify({ startedAt: timestamp || Date.now(), token: token || '' })
  );
}

function clearSoftLockIfOwned_(token) {
  const props = PropertiesService.getScriptProperties();
  const softLock = parseJsonProperty_(props.getProperty(CONFIG.LOCK_PROPERTY), null);
  if (softLock && softLock.token === token) {
    props.deleteProperty(CONFIG.LOCK_PROPERTY);
  }
}

function touchSoftLock_() {
  const props = PropertiesService.getScriptProperties();
  const softLock = parseJsonProperty_(props.getProperty(CONFIG.LOCK_PROPERTY), null);
  if (softLock && softLock.token) {
    setSoftLock_(Date.now(), softLock.token);
  }
}

function processAutomation_(force) {
  const properties = PropertiesService.getScriptProperties();
  if (!force && properties.getProperty(CONFIG.AUTOMATION_PROPERTY) !== 'TRUE') return;

  // Refresh the soft lock timestamp so a long-running batch is not mistaken
  // for a dead process while it is still actively working.
  touchSoftLock_();

  // Give up after several consecutive job-start failures so a dead tunnel does
  // not burn through the trigger quota overnight.
  const failures = parseInt(properties.getProperty(CONFIG.CONSECUTIVE_FAILURES_PROPERTY) || '0', 10) || 0;
  if (failures >= CONFIG.MAX_CONSECUTIVE_FAILURES) {
    const msg = 'Automation stopped after ' + failures + ' consecutive batch-start failures. Check the server/tunnel URL.';
    properties.setProperty(CONFIG.LAST_ERROR_PROPERTY, new Date().toISOString() + ' - ' + msg);
    finishAutomation_(SpreadsheetApp.getActive(), msg);
    return { stopped: true, reason: msg };
  }

  // Pick up the newest tunnel URL first: tunnel.js renews it before the
  // 60-minute free-tunnel expiry, so this keeps every batch self-healing.
  refreshServerUrlFromChannel_();

  // Fast fail if the server/tunnel is dead. If an old job was active, it is
  // irrecoverable, so clear it instead of hanging on polls.
  const activeRuns = parseJsonProperty_(properties.getProperty(CONFIG.SERVER_JOB_PROPERTY), null);
  const health = quickHealthCheck_();
  if (!health.ok) {
    if (activeRuns && activeRuns.length) {
      properties.deleteProperty(CONFIG.SERVER_JOB_PROPERTY);
      properties.deleteProperty(CONFIG.RUNS_ENTRIES_PROPERTY);
    }
    throw new Error('Server is not reachable: ' + health.error + '. Check that start-enricher.bat is running and the URL/channel is current.');
  }

  const spreadsheetId = properties.getProperty(CONFIG.SPREADSHEET_PROPERTY);
  const spreadsheet = spreadsheetId ? SpreadsheetApp.openById(spreadsheetId) : SpreadsheetApp.getActive();
  const sheets = getManagedStoreSheets_(spreadsheet);
  if (!sheets.length) throw new Error('Managed Google Play and App Store tabs were not found.');

  // Check for an active enricher job and poll it.
  if (activeRuns && activeRuns.length) {
    console.info('Polling enricher job');
    const pollResult = pollServerJob_(activeRuns, spreadsheet);

    if (pollResult.status === 'running') {
      properties.setProperty(CONFIG.SERVER_JOB_PROPERTY, JSON.stringify(pollResult.runs));
      return { running: true, runs: pollResult.runs };
    }

    properties.deleteProperty(CONFIG.SERVER_JOB_PROPERTY);
    const entries = parseJsonProperty_(
      properties.getProperty(CONFIG.RUNS_ENTRIES_PROPERTY), []
    ).map(normalizeEntry_);
    properties.deleteProperty(CONFIG.RUNS_ENTRIES_PROPERTY);

    // Partial failure is isolated per store: rows of a failed store get ERROR,
    // rows of succeeded stores still get their results written.
    const failedStores = pollResult.failedStores || [];
    const okEntries = entries.filter(entry => failedStores.indexOf(entry.store) === -1);
    const badEntries = entries.filter(entry => failedStores.indexOf(entry.store) !== -1);

    if (badEntries.length) {
      const message = truncateText_('ERROR: ENRICHER - ' + String(pollResult.error || 'Enricher job failed'), 450);
      setEntriesStatus_(badEntries, message, spreadsheet);
      properties.setProperty(CONFIG.LAST_ERROR_PROPERTY, new Date().toISOString() + ' - ' + message);
      spreadsheet.toast(message, 'Free App Enricher', 10);
    }

    if (pollResult.status === 'failed') {
      if (force) throw new Error(pollResult.error || 'Enricher job failed');
      return { failed: true };
    }

    // Done or partial. Write results for the succeeded store(s).
    try {
      console.info('Writing ' + (pollResult.results || []).length + ' result(s) for ' + okEntries.length + ' entry(ies)');
      writeServiceResults_(okEntries, pollResult.results, spreadsheet);
      if (!badEntries.length) properties.deleteProperty(CONFIG.LAST_ERROR_PROPERTY);
      properties.deleteProperty(CONFIG.CONSECUTIVE_FAILURES_PROPERTY);
      spreadsheet.toast('Enricher batch finished. Results written.', 'Free App Enricher', 7);
    } catch (writeError) {
      const message = truncateText_('ERROR: WRITE - ' + writeError.message, 450);
      setEntriesStatus_(okEntries, message, spreadsheet);
      properties.setProperty(CONFIG.LAST_ERROR_PROPERTY, new Date().toISOString() + ' - ' + message);
      console.error(writeError);
      spreadsheet.toast(message, 'Free App Enricher', 10);
      if (force) throw writeError;
      return { failed: true };
    }
  }

  // Start a new batch.
  const allPending = [];
  sheets.forEach(sheet => {
    const columns = ensureColumns_(sheet);
    recoverInterruptedRows_(sheet, columns);
    getPendingRows_(sheet, columns).forEach(item => {
      allPending.push({
        sheet: sheet,
        sheetName: sheet.getName(),
        columns: columns,
        row: item.row,
        url: item.url,
        store: item.store
      });
    });
  });
  const selected = allPending.slice(0, CONFIG.BATCH_SIZE);
  if (!selected.length) {
    console.info('No pending rows found');
    if (!force) finishAutomation_(spreadsheet, 'App enrichment is complete.');
    else spreadsheet.toast('No pending rows were found.', 'Free App Enricher', 5);
    return { complete: true, count: 0 };
  }

  // Property values are limited to 9 KB. Shrink the batch if needed so the
  // serialized entry list always fits; dropped rows stay pending for the
  // next tick.
  while (selected.length > 1 &&
    JSON.stringify(selected.map(serializeEntry_)).length > 8500) {
    selected.pop();
  }

  setEntriesStatus_(selected, 'ENRICHING ' + new Date().toISOString(), spreadsheet);
  SpreadsheetApp.flush();
  const urls = uniqueNonEmpty_(selected.map(item => item.url));
  console.info('Starting new enricher batch with ' + selected.length + ' row(s) (' + urls.length + ' unique URL(s))');

  try {
    const runs = startServerJob_(urls);
    properties.setProperty(CONFIG.SERVER_JOB_PROPERTY, JSON.stringify(runs));
    // Only slim records go into script properties: live Sheet objects do not
    // survive JSON.stringify and full column maps exceed the 9 KB value limit.
    properties.setProperty(
      CONFIG.RUNS_ENTRIES_PROPERTY,
      JSON.stringify(selected.map(serializeEntry_))
    );
    properties.deleteProperty(CONFIG.LAST_ERROR_PROPERTY);
    properties.deleteProperty(CONFIG.CONSECUTIVE_FAILURES_PROPERTY);
    spreadsheet.toast('Enricher job started for ' + selected.length + ' row(s).', 'Free App Enricher', 7);
    return { started: true, count: selected.length, runs: runs };
  } catch (error) {
    const failures = (parseInt(properties.getProperty(CONFIG.CONSECUTIVE_FAILURES_PROPERTY) || '0', 10) || 0) + 1;
    properties.setProperty(CONFIG.CONSECUTIVE_FAILURES_PROPERTY, String(failures));
    const message = truncateText_('ERROR: ENRICHER - ' + error.message + ' (failure ' + failures + '/' + CONFIG.MAX_CONSECUTIVE_FAILURES + ')', 450);
    setEntriesStatus_(selected, message, spreadsheet);
    SpreadsheetApp.flush();
    properties.setProperty(CONFIG.LAST_ERROR_PROPERTY, new Date().toISOString() + ' - ' + error.message);
    spreadsheet.toast(message, 'Free App Enricher', 10);
    if (force) throw error;
    return { failed: true, count: selected.length, failures: failures };
  }
}

/**
 * Slim, JSON-safe representation of a pending row: just {row, url}.
 * Store and sheet name are derivable from the URL (only classifiable URLs ever
 * become pending, and each store maps to exactly one managed tab), so omitting
 * them keeps a full 50-row batch far below the 9 KB property-value limit even
 * with very long URLs. Sheets and column maps are re-resolved from the
 * spreadsheet whenever a stored batch is processed.
 */
function serializeEntry_(entry) {
  return { row: entry.row, url: entry.url };
}

/**
 * Backfills store/sheetName for compact entries restored from script
 * properties. Older stored formats that already carry those fields pass
 * through untouched, so in-flight batches survive a script update.
 */
function normalizeEntry_(entry) {
  if (!entry || entry.store) return entry;
  const store = classifyAppUrl_(entry.url);
  const normalized = { row: entry.row, url: entry.url, store: store };
  normalized.sheetName = entry.sheetName || (store ? CONFIG.STORE_TABS[store] : '');
  return normalized;
}

/**
 * Groups entries by sheet. Accepts both live entries (with sheet/columns) and
 * slim entries restored from script properties (sheetName only).
 */
function groupEntries_(entries, spreadsheet) {
  const groupsBySheet = {};
  (entries || []).forEach(entry => {
    const sheetName = entry.sheetName || (entry.sheet && entry.sheet.getName ? entry.sheet.getName() : '');
    if (!sheetName) return;
    if (!groupsBySheet[sheetName]) {
      const sheet = entry.sheet || spreadsheet.getSheetByName(sheetName);
      if (!sheet) throw new Error('Sheet "' + sheetName + '" was deleted or renamed.');
      groupsBySheet[sheetName] = {
        sheet: sheet,
        columns: entry.columns || ensureColumns_(sheet),
        entries: []
      };
    }
    groupsBySheet[sheetName].entries.push(entry);
  });
  return Object.keys(groupsBySheet).map(key => groupsBySheet[key]);
}

function startServerJob_(urls) {
  let serverUrl = getServerUrl_();
  const unique = uniqueNonEmpty_(urls);
  let lastError = '';
  let urlRefreshed = false;
  // Free tunnels (loca.lt/pinggy) occasionally answer with DNS errors,
  // 408/429/5xx, or an HTML error page under load. Those are transient, so
  // retry a few times. If the URL looks dead, try refreshing it from the ntfy
  // channel once per batch. A real 4xx (e.g. 401 wrong API key) fails immediately.
  for (let attempt = 1; attempt <= 4; attempt++) {
    touchSoftLock_(); // keep the soft lock fresh during retries
    if (attempt > 1) Utilities.sleep(2000 * attempt);
    let code = 0;
    let body = null;
    try {
      const response = UrlFetchApp.fetch(serverUrl + '/jobs', {
        method: 'post',
        contentType: 'application/json',
        headers: serverHeaders_(),
        payload: JSON.stringify({ urls: unique }),
        muteHttpExceptions: true
      });
      code = response.getResponseCode();
      const text = response.getContentText() || '';
      if (text.charAt(0) === '{') {
        try { body = JSON.parse(text); } catch (parseError) { body = null; }
      }
    } catch (error) {
      lastError = error.message;
      if (!urlRefreshed && isTunnelError_(0, error.message)) {
        console.info('Tunnel/DNS error detected; refreshing server URL from channel...');
        if (refreshServerUrlFromChannel_()) {
          serverUrl = getServerUrl_();
          urlRefreshed = true;
          attempt = 0; // restart the retry loop with the new URL
          continue;
        }
      }
      continue;
    }
    if (code >= 200 && code < 300 && body && body.ok && body.jobId) {
      if (attempt > 1 || urlRefreshed) console.info('Enricher job started on attempt ' + attempt + (urlRefreshed ? ' (after URL refresh)' : ''));
      return [{ runId: body.jobId, store: 'MIXED', status: 'RUNNING', pollFailures: 0, startedAt: Date.now(), totalUrls: unique.length }];
    }
    lastError = 'HTTP ' + code + (body && body.error ? ': ' + body.error : ' (tunnel or server not ready)');
    console.warn('Enricher job start attempt ' + attempt + '/4 failed: ' + lastError);
    if (code >= 400 && code < 500 && code !== 408 && code !== 429) break;
  }
  throw new Error('Enricher server job start failed after retries: ' + lastError);
}

function isTunnelError_(code, errorMessage) {
  if (code >= 500 || code === 408 || code === 429) return true;
  const message = String(errorMessage || '').toLowerCase();
  return /dns|unreachable|could not connect|connection refused|timeout|tunnel/i.test(message);
}

function pollServerJob_(runs, spreadsheet) {
  const serverUrl = getServerUrl_();
  let allDone = true;
  const updatedRuns = [];

  runs.forEach(run => {
    touchSoftLock_(); // keep the soft lock fresh while polling
    if (run.status === 'SUCCEEDED' || run.status === 'FAILED') {
      updatedRuns.push(run);
      return;
    }

    let body;
    try {
      const response = UrlFetchApp.fetch(serverUrl + '/jobs/' + encodeURIComponent(run.runId), {
        headers: serverHeaders_(),
        muteHttpExceptions: true
      });
      const code = response.getResponseCode();
      body = parseJsonResponse_(response.getContentText(), 'enricher job poll');
      if (code < 200 || code >= 300 || !body.ok) {
        throw new Error('HTTP ' + code + (body && body.error ? ': ' + body.error : ''));
      }
    } catch (error) {
      const failures = (run.pollFailures || 0) + 1;
      console.warn('Enricher poll failed for job ' + run.runId + ' (' + failures + '/' + CONFIG.MAX_POLL_FAILURES + '): ' + error.message);
      if (failures >= CONFIG.MAX_POLL_FAILURES) {
        updatedRuns.push({ ...run, status: 'FAILED', pollFailures: failures, pollError: error.message });
      } else {
        allDone = false;
        updatedRuns.push({ ...run, pollFailures: failures });
      }
      return;
    }

    console.info('Enricher job ' + run.runId + ' status: ' + body.status);
    if (body.status === 'running') {
      const total = run.totalUrls || 0;
      const completed = body.results ? body.results.filter(r => r !== undefined).length : 0;
      if (spreadsheet && total > 0) {
        spreadsheet.toast('Enricher job: ' + completed + ' of ' + total + ' completed', 'Free App Enricher', 5);
      }
      const ageMinutes = run.startedAt ? (Date.now() - run.startedAt) / 60000 : 0;
      if (ageMinutes > CONFIG.MAX_JOB_MINUTES) {
        updatedRuns.push({
          ...run, status: 'FAILED', pollFailures: 0,
          pollError: 'job still running after ' + CONFIG.MAX_JOB_MINUTES + ' minutes (server or tunnel stuck)'
        });
      } else {
        allDone = false;
        updatedRuns.push({ ...run, status: 'RUNNING', pollFailures: 0 });
      }
    } else if (body.status === 'failed') {
      updatedRuns.push({ ...run, status: 'FAILED', pollFailures: 0, pollError: body.error || 'job failed on server' });
    } else {
      updatedRuns.push({ ...run, status: 'SUCCEEDED', pollFailures: 0, results: body.results || [] });
    }
  });

  if (!allDone) return { status: 'running', runs: updatedRuns };

  // Job terminal. Per-URL failures live inside results (ok: false) and are
  // written per row; only a job-level failure marks the whole batch as error.
  const results = [];
  let errorMessage = '';
  let anyFailed = false;
  updatedRuns.forEach(run => {
    if (run.status !== 'SUCCEEDED') {
      anyFailed = true;
      if (!errorMessage) errorMessage = run.pollError || 'Enricher job ' + run.runId + ' failed';
      return;
    }
    (run.results || []).forEach(item => results.push(item));
  });

  if (anyFailed) {
    return {
      status: 'failed',
      runs: updatedRuns,
      results: results,
      failedStores: ['GOOGLE_PLAY', 'APP_STORE'],
      error: errorMessage
    };
  }
  return { status: 'done', runs: updatedRuns, results: results };
}

function parseJsonResponse_(text, label) {
  try { return text ? JSON.parse(text) : {}; }
  catch (error) { throw new Error('Invalid JSON from ' + label + '.'); }
}

/**
 * Defensive JSON parse for script properties: corrupt or truncated state never
 * throws, it just falls back so the automation can recover on the next tick.
 */
function parseJsonProperty_(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); }
  catch (error) {
    console.warn('Ignoring corrupt script property: ' + error.message);
    return fallback;
  }
}

function getServerUrl_() {
  const value = PropertiesService.getScriptProperties().getProperty(CONFIG.SERVER_URL_PROPERTY);
  if (!value) throw new Error('Set your enricher server URL first (auto-update channel in menu item 2, or the manual fallback in menu item 2b).');
  return value.replace(/\/+$/, '');
}

function serverHeaders_() {
  const key = PropertiesService.getScriptProperties().getProperty(CONFIG.SERVER_KEY_PROPERTY);
  // 'bypass-tunnel-reminder' skips the localtunnel interstitial page;
  // 'X-Pinggy-No-Screen' skips the pinggy free-tier warning page that is
  // otherwise served to browser-like agents such as UrlFetchApp. Both are
  // harmless for any other tunnel or direct connection.
  const headers = {
    'bypass-tunnel-reminder': 'true',
    'X-Pinggy-No-Screen': 'true'
  };
  if (key) headers.Authorization = 'Bearer ' + key;
  return headers;
}

/**
 * Quick, one-attempt health check. Used before starting a batch so a dead
 * tunnel fails in seconds instead of hanging for minutes on UrlFetchApp.
 */
function quickHealthCheck_() {
  try {
    const response = UrlFetchApp.fetch(getServerUrl_() + '/health', {
      headers: serverHeaders_(),
      muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    const body = parseJsonResponse_(response.getContentText(), 'health check');
    if (code >= 200 && code < 300 && body.ok) return { ok: true };
    return { ok: false, error: 'HTTP ' + code };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Matches a result to a pending row by store + appId, falling back to the
 * exact input URL. This survives actors normalizing URLs in their output.
 */
function resultMatchKey_(store, appId, url) {
  const id = String(appId || '').trim().toLowerCase();
  if (id) return store + ':' + id;
  const key = normalizeUrlKey_(url);
  return key ? store + '|' + key : '';
}

function writeServiceResults_(entries, results, spreadsheet) {
  const byKey = {};
  (results || []).forEach(result => {
    const data = result.data || {};
    const key = resultMatchKey_(
      result.store || '',
      data.appId || getInputAppId_(result.inputUrl, result.store),
      result.inputUrl
    );
    if (key) byKey[key] = result;
    // Also index by raw URL so lookups by URL alone still hit.
    const urlKey = resultMatchKey_(result.store || '', '', result.inputUrl);
    if (urlKey && !byKey[urlKey]) byKey[urlKey] = result;
  });
  const groups = groupEntries_(entries, spreadsheet);
  groups.forEach(group => {
    const updates = {};
    group.entries.forEach(entry => {
      const appId = getInputAppId_(entry.url, entry.store);
      const result = byKey[resultMatchKey_(entry.store, appId, entry.url)] ||
        byKey[resultMatchKey_(entry.store, '', entry.url)] ||
        null;
      updates[entry.row] = buildServiceUpdate_(entry, result);
    });
    writeUpdates_(group.sheet, group.columns, updates, OUTPUT_HEADERS);
  });
  SpreadsheetApp.flush();
}

function buildServiceUpdate_(entry, result) {
  const now = new Date();
  if (!result) {
    return {
      'Store': storeLabel_(entry.store),
      'App ID': getInputAppId_(entry.url, entry.store),
      'Enrichment Status': 'ERROR: ENRICHER - result missing from batch response',
      'Enriched At': now
    };
  }
  if (!result.ok) {
    return {
      'Store': storeLabel_(entry.store),
      'App ID': getInputAppId_(entry.url, entry.store),
      'Enrichment Status': truncateText_('ERROR: ENRICHER - ' + String(result.error || 'lookup failed'), 450),
      'Enriched At': now
    };
  }

  const data = result.data || {};
  const email = data.developerEmail || '';
  const website = data.developerWebsite || '';
  const privacy = data.privacyPolicy || '';
  const address = data.developerAddress || '';
  return {
    'Store': data.storeLabel || storeLabel_(entry.store),
    'App ID': data.appId || getInputAppId_(entry.url, entry.store),
    'Bundle ID': data.bundleId || '',
    'App Name': data.appName || '',
    'Developer': data.developer || '',
    'Developer Email': email,
    'Developer Website': website,
    'Developer Profile': data.developerProfile || '',
    'Developer Phone': data.developerPhone || '',
    'Developer Address': address,
    'Developer Contact Page': data.developerContactPage || '',
    'Developer Social Profiles': formatCellValue_(data.developerSocialProfiles),
    'Contact Pages Crawled': '',
    'Privacy Policy': privacy,
    'Installs': data.installs === undefined || data.installs === null ? '' : data.installs,
    'Rating': data.rating === undefined || data.rating === null ? '' : data.rating,
    'Rating Count': data.ratingCount === undefined || data.ratingCount === null ? '' : data.ratingCount,
    'Category': data.category || '',
    'Price': data.price === undefined || data.price === null ? '' : data.price,
    'Currency': data.currency || '',
    'Version': data.version || '',
    'Store Updated At': normalizeDateCell_(data.updatedAt),
    'Icon URL': data.icon || '',
    'Store URL': data.storeUrl || entry.url,
    'Enrichment Status': getFreeContactStatus_(email, website, privacy, address),
    'Enriched At': now
  };
}

function getFreeContactStatus_(email, website, privacy, address) {
  if (String(email || '').trim()) return 'EMAIL_FOUND';
  if (String(website || '').trim() || String(privacy || '').trim()) return 'WEBSITE_ONLY';
  if (String(address || '').trim()) return 'CONTACT_FOUND';
  return 'NO_CONTACT';
}

function normalizeDateCell_(value) {
  if (value === undefined || value === null || value === '') return '';
  const number = Number(value);
  if (isFinite(number) && number > 100000000000) return new Date(number);
  return value;
}

function formatCellValue_(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object' && !(value instanceof Date)) return JSON.stringify(value);
  return value;
}

function setEntriesStatus_(entries, status, spreadsheet) {
  const target = spreadsheet || SpreadsheetApp.getActive();
  groupEntries_(entries, target).forEach(group => {
    setStatus_(group.sheet, group.columns, group.entries.map(item => item.row), status);
  });
}

function showAutomationStatus() {
  const properties = PropertiesService.getScriptProperties();
  const enabled = properties.getProperty(CONFIG.AUTOMATION_PROPERTY) === 'TRUE';
  const activeRuns = properties.getProperty(CONFIG.SERVER_JOB_PROPERTY) || 'none';
  const lastError = properties.getProperty(CONFIG.LAST_ERROR_PROPERTY);
  let pending = 0;
  const spreadsheet = SpreadsheetApp.getActive();
  getManagedStoreSheets_(spreadsheet).forEach(sheet => {
    const columns = ensureColumns_(sheet);
    pending += getPendingRows_(sheet, columns).length;
  });
  let message = 'Automatic enrichment: ' + (enabled ? 'RUNNING' : 'STOPPED') +
    '\nActive enricher job: ' + activeRuns +
    '\nPending rows: ' + pending;
  if (lastError) message += '\nLast error: ' + lastError;
  SpreadsheetApp.getUi().alert(message);
}

function stopAutomaticEnrichment() {
  const properties = PropertiesService.getScriptProperties();
  properties.deleteProperty(CONFIG.AUTOMATION_PROPERTY);
  properties.deleteProperty(CONFIG.SERVER_JOB_PROPERTY);
  properties.deleteProperty(CONFIG.RUNS_ENTRIES_PROPERTY);
  properties.deleteProperty(CONFIG.CONSECUTIVE_FAILURES_PROPERTY);
  properties.deleteProperty(CONFIG.LOCK_PROPERTY);
  deleteAutomationTriggers_();
  SpreadsheetApp.getUi().alert('Automatic enrichment stopped.');
}

/**
 * Last-resort reset. Does NOT acquire the script lock, so it works even when
 * a hung execution is holding it. Clears all automation state and releases any
 * rows stuck in ENRICHING/RUNNING status.
 */
function emergencyStopAndClearLock() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.alert(
    'Emergency stop & clear lock',
    'This clears all automation state, the soft lock, and resets rows stuck in ENRICHING/RUNNING. Use this only when you see lock errors.',
    ui.ButtonSet.YES_NO
  );
  if (response !== ui.Button.YES) return;

  const properties = PropertiesService.getScriptProperties();
  properties.deleteProperty(CONFIG.AUTOMATION_PROPERTY);
  properties.deleteProperty(CONFIG.SERVER_JOB_PROPERTY);
  properties.deleteProperty(CONFIG.RUNS_ENTRIES_PROPERTY);
  properties.deleteProperty(CONFIG.CONSECUTIVE_FAILURES_PROPERTY);
  properties.deleteProperty(CONFIG.LOCK_PROPERTY);
  properties.deleteProperty(CONFIG.LAST_ERROR_PROPERTY);
  deleteAutomationTriggers_();

  let released = 0;
  const spreadsheet = SpreadsheetApp.getActive();
  getManagedStoreSheets_(spreadsheet).forEach(sheet => {
    const columns = ensureColumns_(sheet);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    const statusColumn = columns[normalizeHeader_('Enrichment Status')];
    const range = sheet.getRange(2, statusColumn, lastRow - 1, 1);
    const values = range.getValues();
    values.forEach(row => {
      if (/^(ENRICHING|RUNNING)/i.test(String(row[0] || '').trim())) {
        row[0] = '';
        released++;
      }
    });
    range.setValues(values);
  });

  ui.alert('Emergency stop complete. ' + released + ' stuck row(s) released. Start the tunnel, then start enrichment again.');
}

function retryFailedRows() {
  const spreadsheet = SpreadsheetApp.getActive();
  let released = 0;
  runLocked_(function() {
    getManagedStoreSheets_(spreadsheet).forEach(sheet => {
      const columns = ensureColumns_(sheet);
      const lastRow = sheet.getLastRow();
      if (lastRow < 2) return;
      const statusColumn = columns[normalizeHeader_('Enrichment Status')];
      const range = sheet.getRange(2, statusColumn, lastRow - 1, 1);
      const values = range.getValues();
      values.forEach(row => {
        if (/^(ERROR|ENRICHING|RUNNING|RETRY_PENDING)/i.test(String(row[0] || '').trim())) {
          row[0] = '';
          released++;
        }
      });
      range.setValues(values);
    });
    PropertiesService.getScriptProperties().deleteProperty(CONFIG.LAST_ERROR_PROPERTY);
    PropertiesService.getScriptProperties().deleteProperty(CONFIG.SERVER_JOB_PROPERTY);
    PropertiesService.getScriptProperties().deleteProperty(CONFIG.RUNS_ENTRIES_PROPERTY);
    PropertiesService.getScriptProperties().deleteProperty(CONFIG.CONSECUTIVE_FAILURES_PROPERTY);
  });
  SpreadsheetApp.getUi().alert(
    released ? 'Released ' + released + ' row(s). Choose Start automatic enrichment.' : 'No failed rows were found.'
  );
}

function resetAllRowsForReenrichment() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.alert(
    'Re-enrich all managed rows?',
    'This clears only Enrichment Status. Existing data stays until replaced.',
    ui.ButtonSet.YES_NO
  );
  if (response !== ui.Button.YES) return;
  let reset = 0;
  getManagedStoreSheets_(SpreadsheetApp.getActive()).forEach(sheet => {
    const columns = ensureColumns_(sheet);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    const statusColumn = columns[normalizeHeader_('Enrichment Status')];
    const range = sheet.getRange(2, statusColumn, lastRow - 1, 1);
    const values = range.getValues();
    const display = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getDisplayValues();
    values.forEach((row, index) => {
      if (getInputFromRow_(display[index], columns).store) {
        row[0] = '';
        reset++;
      }
    });
    range.setValues(values);
  });
  ui.alert('Reset ' + reset + ' row(s). Existing enriched values were kept.');
}

/**
 * Highlights rows where enrichment succeeded but no usable developer contact
 * was found (NO_CONTACT status or empty Developer Email). This makes it easy
 * to spot apps that need manual research.
 */
function findAppsWithNoContact() {
  const spreadsheet = SpreadsheetApp.getActive();
  let total = 0;
  const rowsBySheet = {};
  getManagedStoreSheets_(spreadsheet).forEach(sheet => {
    const columns = ensureColumns_(sheet);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    const statusCol = columns[normalizeHeader_('Enrichment Status')] - 1;
    const emailCol = columns[normalizeHeader_('Developer Email')] - 1;
    const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getDisplayValues();
    const matches = [];
    values.forEach((row, index) => {
      if (!getInputFromRow_(row, columns).store) return;
      const status = String(row[statusCol] || '').trim();
      const email = String(row[emailCol] || '').trim();
      if (status === 'NO_CONTACT' || (status === 'WEBSITE_ONLY' && !email)) {
        matches.push(index + 2);
      }
    });
    if (matches.length) {
      total += matches.length;
      rowsBySheet[sheet.getName()] = matches;
      const range = sheet.getRange(2, 1, lastRow - 1, 1);
      const backgrounds = range.getBackgrounds();
      matches.forEach(rowNumber => { backgrounds[rowNumber - 2][0] = '#fce5cd'; });
      range.setBackgrounds(backgrounds);
    }
  });

  let message = total
    ? 'Found ' + total + ' row(s) with no developer email/contact:\n\n'
    : 'No rows with missing contact were found.';
  Object.keys(rowsBySheet).forEach(sheetName => {
    message += sheetName + ': rows ' + rowsBySheet[sheetName].slice(0, 10).join(', ');
    if (rowsBySheet[sheetName].length > 10) message += ' ... (' + rowsBySheet[sheetName].length + ' total)';
    message += '\n';
  });
  if (total) message += '\nApp URL cells are highlighted in orange.';
  SpreadsheetApp.getUi().alert(message);
}

function recoverInterruptedRows_(sheet, columns) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const statusColumn = columns[normalizeHeader_('Enrichment Status')];
  const range = sheet.getRange(2, statusColumn, lastRow - 1, 1);
  const values = range.getValues();
  let recovered = 0;
  values.forEach(row => {
    if (/^(ENRICHING|RUNNING)\s+/i.test(String(row[0] || '').trim())) {
      row[0] = '';
      recovered++;
    }
  });
  if (recovered) range.setValues(values);
  return recovered;
}

function getPendingRows_(sheet, columns) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getDisplayValues();
  const statusCol = columns[normalizeHeader_('Enrichment Status')] - 1;
  const managedStore = getManagedStoreForSheet_(sheet);
  return values.map((row, index) => {
    const input = getInputFromRow_(row, columns);
    return {
      row: index + 2,
      url: input.url,
      store: input.store,
      status: String(row[statusCol] || '').trim().toUpperCase()
    };
  }).filter(item => {
    const finished = /^(OK|EMAIL_FOUND|CONTACT_FOUND|WEBSITE_ONLY|NO_CONTACT|NOT_FOUND|ERROR)/.test(item.status);
    const working = /^(ENRICHING|RUNNING)/.test(item.status);
    return !!item.store && (!managedStore || item.store === managedStore) && !finished && !working;
  });
}

function ensureColumns_(sheet) {
  if (sheet.getLastColumn() === 0) throw new Error('The selected sheet is empty.');
  let headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  let normalized = headers.map(normalizeHeader_);
  const inputColumns = [];
  CONFIG.INPUT_HEADERS.forEach(header => {
    const index = normalized.indexOf(normalizeHeader_(header));
    if (index !== -1) inputColumns.push({ header: header, column: index + 1 });
  });
  if (!inputColumns.length) throw new Error('Add one input column: ' + CONFIG.INPUT_HEADERS.join(', ') + '.');
  OUTPUT_HEADERS.forEach(header => {
    if (normalized.indexOf(normalizeHeader_(header)) !== -1) return;
    ensureSheetCapacity_(sheet, 1, sheet.getLastColumn() + 1);
    sheet.getRange(1, sheet.getLastColumn() + 1).setValue(header);
    normalized.push(normalizeHeader_(header));
  });
  headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const columns = {};
  headers.forEach((header, index) => { columns[normalizeHeader_(header)] = index + 1; });
  columns.__inputs = inputColumns;
  return columns;
}

function getInputFromRow_(row, columns) {
  let firstNonEmpty = '';
  for (let index = 0; index < columns.__inputs.length; index++) {
    const value = String(row[columns.__inputs[index].column - 1] || '').trim();
    if (!value) continue;
    if (!firstNonEmpty) firstNonEmpty = value;
    const store = classifyAppUrl_(value);
    if (store) return { url: value, store: store };
  }
  return { url: firstNonEmpty, store: classifyAppUrl_(firstNonEmpty) };
}

function writeUpdates_(sheet, columns, updates, headers) {
  headers.forEach(header => {
    const valuesByRow = {};
    Object.keys(updates).forEach(row => {
      if (Object.prototype.hasOwnProperty.call(updates[row], header)) {
        valuesByRow[row] = formatCellValue_(updates[row][header]);
      }
    });
    if (!Object.keys(valuesByRow).length) return;
    setColumnValuesForRows_(sheet, columns[normalizeHeader_(header)], valuesByRow);
  });
}

function setStatus_(sheet, columns, rows, status) {
  const valuesByRow = {};
  rows.forEach(row => { valuesByRow[row] = status; });
  setColumnValuesForRows_(sheet, columns[normalizeHeader_('Enrichment Status')], valuesByRow);
}

function setColumnValuesForRows_(sheet, column, valuesByRow) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2 || !column) return;
  const range = sheet.getRange(2, column, lastRow - 1, 1);
  const values = range.getValues();
  const formulas = range.getFormulas();
  for (let index = 0; index < values.length; index++) {
    const rowNumber = index + 2;
    if (Object.prototype.hasOwnProperty.call(valuesByRow, rowNumber)) values[index][0] = valuesByRow[rowNumber];
    else if (formulas[index][0]) values[index][0] = formulas[index][0];
  }
  range.setValues(values);
}

function getManagedStoreSheets_(spreadsheet) {
  return [CONFIG.STORE_TABS.GOOGLE_PLAY, CONFIG.STORE_TABS.APP_STORE]
    .map(name => spreadsheet.getSheetByName(name))
    .filter(Boolean);
}

function getManagedStoreForSheet_(sheet) {
  const name = String(sheet.getName ? sheet.getName() : '');
  if (name === CONFIG.STORE_TABS.GOOGLE_PLAY) return 'GOOGLE_PLAY';
  if (name === CONFIG.STORE_TABS.APP_STORE) return 'APP_STORE';
  return '';
}

function ensureAutomationTrigger_() {
  const exists = ScriptApp.getProjectTriggers().some(
    trigger => trigger.getHandlerFunction() === CONFIG.TRIGGER_HANDLER
  );
  if (!exists) ScriptApp.newTrigger(CONFIG.TRIGGER_HANDLER).timeBased().everyMinutes(1).create();
}

function deleteAutomationTriggers_() {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === CONFIG.TRIGGER_HANDLER) ScriptApp.deleteTrigger(trigger);
  });
}

function finishAutomation_(spreadsheet, message) {
  const properties = PropertiesService.getScriptProperties();
  properties.deleteProperty(CONFIG.AUTOMATION_PROPERTY);
  properties.deleteProperty(CONFIG.SPREADSHEET_PROPERTY);
  properties.deleteProperty(CONFIG.SERVER_JOB_PROPERTY);
  properties.deleteProperty(CONFIG.RUNS_ENTRIES_PROPERTY);
  deleteAutomationTriggers_();
  spreadsheet.toast(message, 'Free App Enricher', 10);
}

function ensureSheetCapacity_(sheet, requiredLastRow, requiredLastColumn) {
  const missingRows = requiredLastRow - sheet.getMaxRows();
  if (missingRows > 0) sheet.insertRowsAfter(sheet.getMaxRows(), missingRows);
  const missingColumns = requiredLastColumn - sheet.getMaxColumns();
  if (missingColumns > 0) sheet.insertColumnsAfter(sheet.getMaxColumns(), missingColumns);
}

function uniqueNonEmpty_(values) {
  const seen = {};
  return values.filter(value => {
    const key = String(value || '').trim();
    if (!key || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function getAppDedupeKey_(url, store) {
  const id = getInputAppId_(url, store);
  return id ? store + ':' + id.toLowerCase() : '';
}

function getInputAppId_(url, store) {
  return store === 'APP_STORE' ? extractAppStoreId_(url) : extractGooglePlayId_(url);
}

function classifyAppUrl_(value) {
  if (isGooglePlayUrl_(value)) return 'GOOGLE_PLAY';
  if (isAppStoreUrl_(value)) return 'APP_STORE';
  return '';
}

function extractGooglePlayId_(urlOrId) {
  const value = String(urlOrId || '').trim();
  const match = value.match(/[?&]id=([^&#]+)/i);
  if (match) return decodeURIComponent(match[1]);
  return /^[a-zA-Z][a-zA-Z0-9_.]+$/.test(value) ? value : '';
}

function extractAppStoreId_(urlOrId) {
  const value = String(urlOrId || '').trim();
  const pathMatch = value.match(/\/id(\d+)(?:[\/?#]|$)/i);
  if (pathMatch) return pathMatch[1];
  return /^\d+$/.test(value) ? value : '';
}

function isGooglePlayUrl_(value) {
  return /^https?:\/\/play\.google\.com\/store\/apps\/details\?/i.test(value) && !!extractGooglePlayId_(value);
}

function isAppStoreUrl_(value) {
  return /^https?:\/\/(?:apps|itunes)\.apple\.com\//i.test(value) && !!extractAppStoreId_(value);
}

function storeLabel_(store) {
  return store === 'APP_STORE' ? 'Apple App Store' : 'Google Play';
}

function normalizeUrlKey_(value) {
  return String(value || '').trim();
}

function normalizeHeader_(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function truncateText_(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? text.slice(0, Math.max(0, maxLength - 1)) + '…' : text;
}
