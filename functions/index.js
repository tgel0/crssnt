const functions = require('firebase-functions');
const admin = require('firebase-admin');
const {google} = require('googleapis');
const sheets = google.sheets('v4');
const fetch = require('node-fetch');
const api_key = functions.config().sheets.api_key
const measurement_id = functions.config().sheets.measurement_id
const api_secret = functions.config().sheets.api_secret
const client_id = functions.config().sheets.client_id

admin.initializeApp();

exports.previewFunction = functions.https.onRequest(async (request, response) => {
  // this is the main function
  // TODO get sheet title + data from the same API call
  
  const sheetIDfromURL = request.path.split("/")[6]
  const sheetID = request.query.id ? request.query.id : sheetIDfromURL  
  let sheetName = request.query.name ? request.query.name : undefined
  const tracking = request.query.tracking ? request.query.tracking : ''
  const mode = request.query.mode ? request.query.mode : ''

  if (sheetID) {

    if (tracking != 'false'){
      trackSheetID(sheetID)
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

function trackSheetID(sheetID) {
  // This function tracks the Sheet ID used to generate the RSS feed
  // Will not run if the tracking query string is set to false
  console.log("Tracking!")
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