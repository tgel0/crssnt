const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");

const feedUtils = require('./helper.js');

setGlobalOptions({ region: "us-central1" });
const api_key_2nd_gen = process.env.SHEETS_API_KEY;
initializeApp();

async function handleSheetRequest(request, response, outputFormat = 'rss') {

  const pathParts = request.path.split("/");
  const sheetIDfromURL = pathParts.length > 6 ? pathParts[6] : undefined;
  const sheetID = request.query.id || sheetIDfromURL;
  let sheetName = request.query.name;
  const mode = request.query.mode || 'auto';

  if (!sheetID) {
    return response.status(400).send('Sheet ID not provided in query (?id=) or path.');
  }

  try {

    const { title: sheetTitle, values: sheetvalues, sheetName: actualSheetName } = await feedUtils.getSheetData(sheetID, sheetName, api_key_2nd_gen);
    const limitedSheetValues = sheetvalues.slice(0, 2000);

    const baseUrl = "https://crssnt.com"
    const pathAndQuery = request.originalUrl || request.url;
    const requestUrl = `${baseUrl}${pathAndQuery}`;

    const feedData = feedUtils.buildFeedData(limitedSheetValues, mode, sheetTitle, sheetID, requestUrl);

    feedOutput = feedUtils.generateRssFeed(feedData);
    contentType = 'application/rss+xml; charset=utf8';

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


exports.previewFunctionV2 = onRequest(
  { cors: true, secrets: ["SHEETS_API_KEY"], cpu: 0.2 },
  (request, response) => handleSheetRequest(request, response, 'rss')
);