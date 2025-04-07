const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { google } = require('googleapis');
const sheets = google.sheets('v4');

const { isValid } = require('date-fns');

const feedUtils = require('./helper.js');

setGlobalOptions({ region: "us-central1" });
const api_key_2nd_gen = process.env.SHEETS_API_KEY;
initializeApp();

exports.previewFunctionV2 = onRequest(
  { cors: true, 
    secrets: ["SHEETS_API_KEY"],
    cpu: 0.2
  }, 
  async (request, response) => {

  const pathParts = request.path.split("/");
  const sheetIDfromURL = pathParts.length > 6 ? pathParts[6] : undefined;
  const sheetID = request.query.id || sheetIDfromURL;
  let sheetName = request.query.name;
  const mode = request.query.mode || 'auto';

  if (!sheetID) {
    return response.status(400).send('Sheet ID not provided, check the parameters and try again.');
  }
  
  try {
    const spreadsheetMeta = (await sheets.spreadsheets.get({
      spreadsheetId: sheetID,
      key: api_key_2nd_gen
    })).data;
    const sheetTitle = spreadsheetMeta.properties.title;

    if (sheetName === undefined) {
      const firstVisibleSheet = spreadsheetMeta.sheets.find(s => !s.properties.hidden);
      if (firstVisibleSheet) {
        sheetName = firstVisibleSheet.properties.title;
      } else {
        sheetName = 'Sheet1';
        console.warn(`Could not determine sheet name for ID ${sheetID}, falling back to 'Sheet1'.`);
      }
    }

    const sheetValuesResponse = (await sheets.spreadsheets.values.get({
      spreadsheetId: sheetID,
      key: api_key_2nd_gen,
      range: sheetName,
      majorDimension: 'ROWS'
    })).data;

    const sheetvalues = sheetValuesResponse.values || [];
    const limitedSheetValues = sheetvalues.slice(0, 2000);
    const { itemsResult, feedDescription } = generateFeedContent(limitedSheetValues, mode);

    let feedXml = '';
    let contentType = 'application/rss+xml; charset=utf8';

    if (mode.toLowerCase() === 'manual') {
      const xmlItemsString = itemsResult;
      feedXml = `<?xml version="1.0" encoding="UTF-8"?>
                  <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
                  <channel>
                  <title>${sheetTitle}</title>
                  <link>https://docs.google.com/spreadsheets/d/${sheetID}</link>
                  <description> ${feedDescription}</description>
                  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
                  <generator>https://github.com/tgel0/crssnt</generator>
                  ${xmlItemsString}
                  </channel>
                  </rss>`;
    } else {

      const itemsArray = itemsResult;
      const latestItemDate = itemsArray.length > 0 && itemsArray[0].dateObject instanceof Date && isValid(itemsArray[0].dateObject)
                             ? itemsArray[0].dateObject
                             : new Date();

      const requestUrl = `${request.protocol}://${request.get('host')}${request.url}`;

      const feedData = {
        metadata: {
          title: sheetTitle || 'Google Sheet Feed',
          link: `https://docs.google.com/spreadsheets/d/${sheetID}`,
          feedUrl: requestUrl,
          description: feedDescription,
          lastBuildDate: latestItemDate,
          generator: 'https://github.com/tgel0/crssnt'
        },
        items: itemsArray
      };

      feedXml = feedUtils.generateRssFeed(feedData);
    }

    return response.status(200).contentType(contentType).send(feedXml);

    } catch (err) {
      console.error("Error processing sheet:", err);
      if (err.code === 404) {
        return response.status(404).send('Spreadsheet not found. Check the Sheet ID.');
      } else if (err.code === 403) {
         return response.status(403).send('Permission denied. Check API key or Sheet sharing settings.');
      } else if (err.message && err.message.includes('Unable to parse range')) {
         return response.status(400).send(`Sheet named "${sheetName}" not found or invalid range.`);
      }
      return response.status(500).send('Something went wrong processing the spreadsheet.');
    }
  }
);


// --- Core Logic Functions ---

function generateFeedContent(values, mode) {
  let itemsResult = [];
  let feedDescription;

  if (mode.toLowerCase() === 'manual') {
    itemsResult = generateFeedManualMode(values);
    feedDescription = 'This feed is generated from a Google Sheet using the crssnt feed generator in manual mode.';
  } else {
    itemsResult = generateFeedAutoMode(values);
    feedDescription = 'This feed is generated from a Google Sheet using the crssnt feed generator (auto mode).';
  }
  return { itemsResult, feedDescription };
}


function generateFeedAutoMode(values) {
  if (!values || values.length === 0) {
    console.error("No values provided to generateFeedAutoMode.");
    return [];
  }

  const parsedItems = [];
  for (const row of values) {
    if (row && row.length > 0) {

      let title = '';
      let titleIndex = -1;
      for (let i = 0; i < row.length; i++) {
          const cellValue = String(row[i] || '').trim();
          if (cellValue !== '') {
              title = cellValue; // Found the title
              titleIndex = i;
              break; // Stop searching
          }
      }

      if (titleIndex === -1) {
        console.warn('Skipping row because no non-empty cell found:', row);
        continue;
    }

      const remainingRowData = row.filter((_, index) => index !== titleIndex);

      let link = undefined;
      let dateObject = null;
      let descriptionContent = '';

      const remainingCells = [];
      for (const cell of remainingRowData) {
        const cellString = String(cell || '');

        if (!link && cellString.startsWith('http')) {
          link = cellString;
          continue;
        }

        if (!dateObject) {
          const parsed = feedUtils.parseDateString(cellString);
          if (parsed instanceof Date && isValid(parsed)) {
            dateObject = parsed;
            continue;
          }
        }
        remainingCells.push(cellString);
      }
      descriptionContent = remainingCells.join(' ');

      parsedItems.push({
        title,
        link,
        dateObject, // Can be null if no valid date was found
        descriptionContent
      });
    }
  }

  feedUtils.sortFeedItems(parsedItems);

  return parsedItems;
}


function generateFeedManualMode(values) {
  let xmlItemsAll = []
  for (const key in values) {
    if(key != 0){ //skip header row
      let value = values[key]
      if(value.length > 0) {
      let xmlItemAllElements = []
        for (const k in values[0]){
          if(values[0][k].length > 0) {
            let itemElementValue = ( values[0][k]  == 'title' || values[0][k]  == 'description') ? '<![CDATA['+value[k]+']]>' : value[k]
            let xmlItemElement = `${'<'+values[0][k]+'>'+itemElementValue+'</'+values[0][k]+'>'}`
            xmlItemAllElements = xmlItemAllElements + xmlItemElement          
          }
        }
        let xmlItem = `<item>`+xmlItemAllElements+`</item>`
        xmlItemsAll = xmlItemsAll + xmlItem
      }
    }
  }
  return xmlItemsAll
}


exports.generateFeedContent = generateFeedContent;
exports.generateFeedAutoMode = generateFeedAutoMode;
exports.generateFeedManualMode = generateFeedManualMode;