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

// this is the main function
// TODO get sheet title + data from the same API call
exports.previewFunction = functions.https.onRequest(async (request, response) => {
  
  const sheetIDfromURL = request.path.split("/")[6]
  const sheetID = request.query.id ? request.query.id : sheetIDfromURL  
  const sheetName = request.query.name ? request.query.name : 'Sheet1'
  const tracking = request.query.tracking ? request.query.tracking : ''

  if (sheetID) {

    if (tracking != 'false'){
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
          console.log("status: ", status);
        })
    }
    else {
      console.log("no tracking!")
    }

    const reqTitle = {
      spreadsheetId: sheetID,      
      key: api_key
    }
    const reqValues = {
      spreadsheetId: sheetID,      
      key: api_key,
      range: sheetName,      
      majorDimension: 'ROWS'
    }
    try {
      const sheetTitle = (await sheets.spreadsheets.get(reqTitle)).data.properties.title;
      const sheetvalues = (await sheets.spreadsheets.values.get(reqValues)).data.values;
      const xmlItems = generateSingleItem(sheetvalues);
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
                    <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
                    <channel>
                    <title>${sheetTitle}</title>
                    <link>https://docs.google.com/spreadsheets/d/${sheetID}</link>
                    <description>Important announcement: starting from February 1st 2022 the sheet IDs will be logged to the backend. For more information see github.com/tgel0/crssnt.</description>
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
    return response.status(400).send('Something went wrong, check the parameters and try again.');
  }
});

function generateSingleItem(values) {
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
        ${url !== undefined ? '<link>'+url+'</link>' : ''}
        ${url !== undefined ? '<guid>'+url+'</guid>' : ''}
        <pubDate>${date !== undefined ? new Date(date).toUTCString() : new Date().toUTCString()}</pubDate>
        </item>`
        xmlItemsAll = xmlItemsAll + xmlItem
    }
  }       
  return xmlItemsAll
}
