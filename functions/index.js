const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");

const feedUtils = require('./helper.js');

setGlobalOptions({ 
  region: "us-central1",
  timeoutSeconds: 30
});

const api_key_2nd_gen = process.env.SHEETS_API_KEY;
const BLOCKED_SHEET_IDS_STRING = process.env.BLOCKED_SHEET_IDS || "";
const BLOCKED_SHEET_IDS = new Set(BLOCKED_SHEET_IDS_STRING.split(',').map(id => id.trim()).filter(id => id));

initializeApp();

async function handleSheetRequest(request, response, outputFormat = 'rss', itemLimit = 50, charLimit = 500) {

  const pathParts = request.path.split("/");
  const sheetIDfromURL = pathParts.length > 6 ? pathParts[6] : undefined;
  const sheetID = request.query.id || sheetIDfromURL;
  let sheetNames = request.query.name; // Can be string or array if multiple 'name=' are present
  const mode = request.query.mode || 'auto'; 
  const llmCompactParam = request.query.llm_compact; // New param for compact LLM output
  const isLlmCompact = llmCompactParam === 'true' || llmCompactParam === '1';
  const baseUrl = "https://crssnt.com"

  if (Array.isArray(sheetNames)) {
      sheetNames = sheetNames.filter(name => name && typeof name === 'string' && name.trim() !== '');
      if (sheetNames.length === 0) sheetNames = undefined; 
  } else if (typeof sheetNames === 'string' && sheetNames.trim() === '') {
      sheetNames = undefined;
  }

  if (!sheetID) {
    return response.status(400).send('Sheet ID not provided in query (?id=) or path.');
  }

    if (BLOCKED_SHEET_IDS.has(sheetID)) {
      const { feedXml, contentType, statusCode } = feedUtils.generateBlockedFeedPlaceholder(sheetID, outputFormat, baseUrl);
      response.set('Cache-Control', 'public, max-age=3600, s-maxage=3600'); // Cache placeholder longer
      return response.status(statusCode).contentType(contentType).send(feedXml);
  }

  try {

    const { title: sheetTitle, sheetData: sheetData } = await feedUtils.getSheetData(sheetID, sheetNames, api_key_2nd_gen);

    const pathAndQuery = request.originalUrl || request.url;
    const requestUrl = `${baseUrl}${pathAndQuery}`;

    const feedData = feedUtils.buildFeedData(sheetData, mode, sheetTitle, sheetID, requestUrl, itemLimit, charLimit);

    let feedOutput = '';
    let contentType = '';

    if (outputFormat === 'atom') {
        feedOutput = feedUtils.generateAtomFeed(feedData);
        contentType = 'application/atom+xml; charset=utf8';
    } else if (outputFormat === 'json') {
        const jsonObject = feedUtils.generateJsonFeedObject(feedData, false, false, isLlmCompact); 
        feedOutput = isLlmCompact ? JSON.stringify(jsonObject) : JSON.stringify(jsonObject, null, 2);
        contentType = 'application/feed+json; charset=utf8';
    } else if (outputFormat === 'markdown') {
        feedOutput = feedUtils.generateMarkdown(feedData, false, false, isLlmCompact); 
        contentType = isLlmCompact ? 'text/plain; charset=utf8' : 'text/markdown; charset=utf8';
    } else { // Default to RSS
        feedOutput = feedUtils.generateRssFeed(feedData);
        contentType = 'application/rss+xml; charset=utf8';
    }

    response.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    return response.status(200).contentType(contentType).send(feedOutput);

  } catch (err) {

    console.error(`Error processing sheet ${sheetID} for ${outputFormat}:`, err);
    let statusCode = 500;
    let message = 'Something went wrong processing the spreadsheet.';

    if (err.code === 404 || (err.message && err.message.includes('Requested entity was not found'))) {
      statusCode = 404;
      message = 'Spreadsheet not found. Check the Sheet ID.';
    } 
    
    else if (err.code === 403) {
       statusCode = 403;
       message = 'Permission denied. Check API key validity or Sheet sharing settings.';
       if (err.message && err.message.includes('API key not valid')) {
          message = 'Permission denied. The API key is not valid or not authorized for this sheet.';
       }
    } else if (err.message && err.message.includes('Unable to parse range')) {
       statusCode = 400;
       message = `Sheet named "${sheetName || 'default'}" not found or invalid range.`;
      }
    return response.status(statusCode).send(message);
  }
}


async function handleUrlRequest(request, response, outputFormat, itemLimit = 10, charLimit = 500, urlLimit = 10) {
  let sourceUrls = request.query.url;
  const groupByFeedParam = request.query.group_by_feed;
  const groupByFeed = groupByFeedParam === 'true' || groupByFeedParam === '1';
  const llmCompactParam = request.query.llm_compact; // New param for compact LLM output
  const isLlmCompact = llmCompactParam === 'true' || llmCompactParam === '1';

  if (!sourceUrls || (Array.isArray(sourceUrls) && sourceUrls.filter(u => String(u || '').trim()).length === 0)) {
      return response.status(400).send('Source URL(s) not provided. Use query parameter "?url=FEED_URL". You can provide multiple "url" parameters.');
  }

  if (!Array.isArray(sourceUrls)) {
      sourceUrls = [sourceUrls];
  }
  sourceUrls = sourceUrls.map(u => String(u || '').trim()).filter(u => u);

  if (sourceUrls.length === 0) {
    return response.status(400).send('No valid source URLs provided after trimming.');
  }

  if (sourceUrls.length > urlLimit) {
    return response.status(400).send(`Too many source URLs provided. The maximum allowed is ${urlLimit}. You provided ${sourceUrls.length}.`);
  }

  for (const url of sourceUrls) {
      try {
          new URL(url);
      } catch (e) {
          return response.status(400).send(`Invalid source URL format: ${url}`);
      }
  }
  
  const baseUrl = "https://crssnt.com"
  const pathAndQuery = request.originalUrl || request.url;
  const requestUrl = `${baseUrl}${pathAndQuery}`;

  try {
      const feedData = await feedUtils.processMultipleUrls(sourceUrls, requestUrl, itemLimit, charLimit, groupByFeed);

      let feedOutput = '';
      let contentType = '';

      if (outputFormat === 'json') {
          const jsonObject = feedUtils.generateJsonFeedObject(feedData, groupByFeed, sourceUrls.length > 1, isLlmCompact);
          feedOutput = isLlmCompact ? JSON.stringify(jsonObject) : JSON.stringify(jsonObject, null, 2);
          contentType = 'application/feed+json; charset=utf8';
    } else if (outputFormat === 'markdown') {
          feedOutput = feedUtils.generateMarkdown(feedData, groupByFeed, sourceUrls.length > 1, isLlmCompact);
          contentType = isLlmCompact ? 'text/plain; charset=utf8' : 'text/markdown; charset=utf8';
      } else {
          // Should not happen for these new endpoints, but as a fallback:
          console.warn(`Unsupported output format '${outputFormat}' requested for URL feed. Defaulting to JSON.`);
          const jsonObject = feedUtils.generateJsonFeedObject(feedData);
          feedOutput = JSON.stringify(jsonObject, null, 2);
          contentType = 'application/feed+json; charset=utf8';
      }

      response.set('Cache-Control', 'public, max-age=300, s-maxage=300');
      return response.status(200).contentType(contentType).send(feedOutput);

  } catch (err) {
      console.error(`Error processing URL ${sourceUrl} for ${outputFormat}:`, err);
      let statusCode = 500;
      let message = 'Something went wrong processing the external feed.';
      if (err.message.includes('Failed to fetch') || err.message.includes('invalid URL')) {
          statusCode = 400;
          message = `Could not fetch or invalid source URL: ${sourceUrl}. Details: ${err.message}`;
      } else if (err.message.includes('Unknown feed type')) {
          statusCode = 400;
          message = `Could not determine feed type (RSS or Atom) for URL: ${sourceUrl}.`;
      }
      return response.status(statusCode).send(message);
  }
}


exports.previewFunctionV2 = onRequest(
  { cors: true, secrets: ["SHEETS_API_KEY", "BLOCKED_SHEET_IDS"], cpu: 0.08 },
  (request, response) => handleSheetRequest(request, response, 'rss', 30, 250)
);

exports.sheetToRSS = onRequest(
  { cors: true, secrets: ["SHEETS_API_KEY", "BLOCKED_SHEET_IDS"], cpu: 0.08 },
  (request, response) => handleSheetRequest(request, response, 'rss', 50, 500)
);

exports.sheetToAtom = onRequest(
  { cors: true, secrets: ["SHEETS_API_KEY", "BLOCKED_SHEET_IDS"], cpu: 0.08 },
  (request, response) => handleSheetRequest(request, response, 'atom', 50, 500)
);

exports.sheetToJson = onRequest(
  { cors: true, secrets: ["SHEETS_API_KEY", "BLOCKED_SHEET_IDS"], cpu: 0.08 },
  (request, response) => handleSheetRequest(request, response, 'json', 50, 500)
);

exports.sheetToMarkdown = onRequest(
  { cors: true, secrets: ["SHEETS_API_KEY", "BLOCKED_SHEET_IDS"], cpu: 0.08 },
  (request, response) => handleSheetRequest(request, response, 'markdown', 50, 500)
);

exports.feedToJson = onRequest(
  { cors: true, cpu: 1, concurrency: 15 },
  (request, response) => handleUrlRequest(request, response, 'json', 10, 500, 10)
);

exports.feedToMarkdown = onRequest(
  { cors: true, cpu: 1, concurrency: 15 },
  (request, response) => handleUrlRequest(request, response, 'markdown', 10, 500, 10)
);
