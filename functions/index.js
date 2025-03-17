const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { google } = require('googleapis');
const fetch = require('node-fetch');
const functions = require('firebase-functions'); //for 1st gen
const sheets = google.sheets('v4');

// Set the region for all functions
setGlobalOptions({ region: "us-central1" });

// get the config variables
const api_key = process.env.SHEETS_API_KEY;
const api_secret = process.env.SHEETS_API_SECRET;
const measurement_id = process.env.MEASUREMENT_ID;
const client_id = process.env.CLIENT_ID;
const api_key_2nd_gen = process.env.SHEETS_API_KEY;

// Initialize Firebase Admin SDK
initializeApp();

// --------------------- 1ST GEN FUNCTION ---------------------
const admin = require('firebase-admin');

exports.previewFunction = functions.https.onRequest(async (request, response) => {
  // this is the main function
  // TODO get sheet title + data from the same API call
  
  const sheetIDfromURL = request.path.split("/")[6]
  const sheetID = request.query.id ? request.query.id : sheetIDfromURL  
  let sheetName = request.query.name ? request.query.name : undefined
  const tracking = request.query.tracking ? request.query.tracking : ''
  const mode = request.query.mode ? request.query.mode : ''

  if (sheetID) {

    // Determine the event name based on the mode
    let eventName = 'preview_function'; // Default event name (auto mode)
    if (mode === 'manual') {
      eventName = 'preview_function_manual';
    }

    if (tracking != 'false') {
      logEvent(sheetID, eventName);
    }

    const reqTitle = {
      spreadsheetId: sheetID,      
      key: api_key
    }

    try {       

      const sheetData = (await sheets.spreadsheets.get(reqTitle)).data;
      const sheetTitle = sheetData.properties.title;            
      const sheetZeroProps = sheetData.sheets.filter(obj => {
        return obj.properties.sheetId == 0
      })

      if(sheetName === undefined){
        if(sheetZeroProps.length > 0){
          sheetName = sheetZeroProps[0].properties.title
        }
        else{
          sheetName = 'Sheet1' //last attempt to get the name if not provided by user and deleted
        }
      }

      const reqValues = {
        spreadsheetId: sheetID,      
        key: api_key,
        range: sheetName,      
        majorDimension: 'ROWS'
      }

      const sheetvalues = (await sheets.spreadsheets.values.get(reqValues)).data.values;

      if(mode == 'manual'){
        var xmlItems = generateFeedManualMode(sheetvalues);
        var feedDescription = 'This feed is generated from a Google Sheet using the crssnt feed generator in manual mode. This feature is still being developed and may show unexpected results from time to time.';
      } else {
            var xmlItems = generateFeedAutoMode(sheetvalues);
            var feedDescription = 'This feed is generated from a Google Sheet using the crssnt feed generator (auto mode).';
      }

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
                    <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
                    <channel>
                    <title>${sheetTitle}</title>
                    <link>https://docs.google.com/spreadsheets/d/${sheetID}</link>
                    <description> ${feedDescription}</description>
                    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
                    <generator>https://github.com/tgel0/crssnt</generator> 
                    ${xmlItems}
                    </channel>
                    </rss>`;

        return response.status(200).contentType('text/xml; charset=utf8').send(xml);      
    } catch (err) {
      console.error(err);
      return response.status(400).send('Something went wrong, check the parameters and try again.');
    }
  }
  else {
    return response.status(400).send('Sheet ID not provided, check the parameters and try again.');
  }
});

// --------------------- 2ND GEN FUNCTION ---------------------

exports.previewFunctionV2 = onRequest({ cors: true, secrets: ["SHEETS_API_KEY"] }, async (request, response) => {
  const sheetIDfromURL = request.path.split("/")[1];
  const sheetID = request.query.id ? request.query.id : sheetIDfromURL;
  let sheetName = request.query.name ? request.query.name : undefined;
  const mode = request.query.mode ? request.query.mode : '';

  if (sheetID) {

    const reqTitle = {
      spreadsheetId: sheetID,
      key: api_key_2nd_gen
    };

    try {
      const sheetData = (await sheets.spreadsheets.get(reqTitle)).data;
      const sheetTitle = sheetData.properties.title;
      const sheetZeroProps = sheetData.sheets.filter(obj => {
        return obj.properties.sheetId == 0;
      });

      if (sheetName === undefined) {
        if (sheetZeroProps.length > 0) {
          sheetName = sheetZeroProps[0].properties.title;
        } else {
          sheetName = 'Sheet1';
        }
      }

      const reqValues = {
        spreadsheetId: sheetID,
        key: api_key_2nd_gen,
        range: sheetName,
        majorDimension: 'ROWS'
      };

      const sheetvalues = (await sheets.spreadsheets.values.get(reqValues)).data.values;
      const { xmlItems, feedDescription } = generateFeedContent(sheetvalues, mode);

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
                    <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
                    <channel>
                    <title>${sheetTitle}</title>
                    <link>https://docs.google.com/spreadsheets/d/${sheetID}</link>
                    <description> ${feedDescription}</description>
                    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
                    <generator>https://github.com/tgel0/crssnt</generator>
                    ${xmlItems}
                    </channel>
                    </rss>`;

      return response.status(200).contentType('text/xml; charset=utf8').send(xml);
    } catch (err) {
      console.error(err);
      return response.status(400).send('Something went wrong, check the parameters and try again.');
    }
  } else {
    return response.status(400).send('Sheet ID not provided, check the parameters and try again.');
  }
});


// --------------------- SHARED FUNCTIONS ---------------------

function generateFeedContent(values, mode) {
  let xmlItems;
  let feedDescription;

  if (mode == 'manual') {
    xmlItems = generateFeedManualMode(values);
    feedDescription = 'This feed is generated from a Google Sheet using the crssnt feed generator in manual mode.';
  } else {
    xmlItems = generateFeedAutoMode(values);
    feedDescription = 'This feed is generated from a Google Sheet using the crssnt feed generator (auto mode).';
  }

  return { xmlItems, feedDescription };
}

function generateFeedAutoMode(values) {
  let xmlItemsAll = []
  for (const key in values) {
    let value = values[key]
    if(value.length > 0) {      
      let title = value.shift();
      let url = value.find(s => s.startsWith('http'));
      let date = value.find(s => new Date(Date.parse(s)).toUTCString().slice(0,25) == s.slice(0,25))
      if(url){
        value.splice(value.indexOf(url), 1); 
      }      
      if(date){
        value.splice(value.indexOf(date), 1); 
      }
      let xmlItem = `<item>        
        ${'<title><![CDATA['+title+']]></title>'}
        ${'<description><![CDATA['+value.slice(0)+']]></description>'}
        ${url !== undefined ? '<link><![CDATA['+url+']]></link>' : ''}
        ${url !== undefined ? '<guid><![CDATA['+url+']]></guid>' : ''}
        <pubDate>${date !== undefined ? new Date(date).toUTCString() : new Date().toUTCString()}</pubDate>
        </item>`
        xmlItemsAll = xmlItemsAll + xmlItem
    }
  }       
  return xmlItemsAll
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

function logEvent(sheetID, eventName) {
  // This function tracks the Sheet ID used to generate the RSS feed
  // Will not run if the tracking query string is set to false
  console.log("Log event received: ", eventName)
  let status; 
  fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${measurement_id}&api_secret=${api_secret}`, {
        method: "POST",
        body: JSON.stringify({
          client_id: client_id,
          events: [{
            name: 'preview_function',
            params: {
              "sheet_ID": sheetID
            },
          }]
        })
      })
    .then((res) => { 
      status = res.status; 
    })
}