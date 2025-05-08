const crypto = require('crypto');
const { google } = require('googleapis');
const sheets = google.sheets('v4');
const { parseISO, isValid, format, formatISO } = require('date-fns');


// --- XML/Markdown Escaping ---

function escapeXmlMinimal(unsafe) {
    if (typeof unsafe !== 'string') {
      return ''; // Return empty string for non-string input
    }
    return unsafe.replace(/[<>&"']/g, (c) => {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case '"': return '&quot;';
        case "'": return '&apos;';
      }
    });
  }

function escapeMarkdown(unsafe) {
    if (typeof unsafe !== 'string') return '';
    return unsafe
        .replace(/([\\`*_{}[\]()#+.!-])/g, '\\$1') // Escape markdown syntax characters
        .replace(/&/g, '&amp;') // Escape HTML entities that might still be interpreted
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
  

// --- Date Handling ---

function parseDateString(dateString) {
    if (!dateString || typeof dateString !== 'string') {
        console.error("parseDateString received invalid input:", dateString);
        return null;
    }

    let parsedDate = null;

    try {
        parsedDate = parseISO(dateString);
        if (isValid(parsedDate)) {
            return parsedDate;
        }
    } catch (e) { /* ignore */ }
    try {
        parsedDate = new Date(dateString);
        if (isValid(parsedDate)) {
            return parsedDate;
        }
    } catch(e) { /* ignore */ }

    return null;
}


function sortFeedItems(itemsData) {
    if (!Array.isArray(itemsData)) {
        console.error("sortFeedItems received non-array input:", itemsData);
        return;
    }

    itemsData.sort((a, b) => {
        const dateA = (a && a.dateObject instanceof Date && isValid(a.dateObject)) ? a.dateObject : null;
        const dateB = (b && b.dateObject instanceof Date && isValid(b.dateObject)) ? b.dateObject : null;

        // Logic to sort items with valid dates first, then items without dates.
        if (dateA && dateB) {
            // Both items have valid dates, sort descending (newest first)
            return dateB.getTime() - dateA.getTime();
        } else if (dateA) {
            // Only item A has a date, so A should come before B (which has no date)
            return -1;
        } else if (dateB) {
            // Only item B has a date, so B should come before A (which has no date)
            return 1;
        } else {
            // Neither item has a valid date, maintain their relative order
            return 0;
        }
    });
}

// --- Google Sheet Fetching ---

async function getSheetData(sheetID, sheetNames, apiKey) {
    const metaRequest = { spreadsheetId: sheetID, key: apiKey };
    const spreadsheetMeta = (await sheets.spreadsheets.get(metaRequest)).data;
    const sheetTitle = spreadsheetMeta.properties.title;

    let targetSheetNames = [];
    if (sheetNames === undefined || (Array.isArray(sheetNames) && sheetNames.length === 0)) {
        // Determine default sheet name if none provided
        const firstVisibleSheet = spreadsheetMeta.sheets.find(s => !s.properties.hidden);
        targetSheetNames = firstVisibleSheet ? [firstVisibleSheet.properties.title] : ['Sheet1'];
        console.warn(`getSheetData: No sheet names provided for ID ${sheetID}, using default: '${targetSheetNames[0]}'.`);
    } else if (typeof sheetNames === 'string') {
        targetSheetNames = [sheetNames];
    } else { // Should be an array
        targetSheetNames = sheetNames;
    }

    const ranges = targetSheetNames.map(name => name);

    const valuesRequest = {
        spreadsheetId: sheetID,
        key: apiKey,
        ranges: ranges,
        majorDimension: 'ROWS'
    };
    const batchGetResponse = (await sheets.spreadsheets.values.batchGet(valuesRequest)).data;
    
    const sheetData = {};
    if (batchGetResponse.valueRanges) {
        batchGetResponse.valueRanges.forEach(valueRange => {
            // Extract sheet name from the range string (e.g., "Sheet1!A1:Z1000" -> "Sheet1")
            const rangeName = valueRange.range.split('!')[0].replace(/'/g, ''); // Remove quotes if present
            sheetData[rangeName] = valueRange.values || [];
        });
    } else {
         console.warn(`getSheetData: No valueRanges returned for Sheet ID ${sheetID}, Ranges: ${JSON.stringify(ranges)}`);
    }

    return { title: sheetTitle, sheetData: sheetData };
}


// --- Sheet Data Parsing ---

function parseSheetRowAutoMode(row) {
    if (!row || row.length === 0) return null;

    let title = '';
    let titleIndex = -1;
    for (let i = 0; i < row.length; i++) {
        const cellValue = String(row[i] || '').trim();
        if (cellValue !== '') {
            title = cellValue;
            titleIndex = i;
            break;
        }
    }
    if (titleIndex === -1) return null; // Skip row if no title found

    const remainingRowData = row.filter((_, index) => index !== titleIndex);
    let link = undefined;
    let dateObject = null;
    let descriptionContent = '';
    const potentialDescriptionCells = [];

    for (const cell of remainingRowData) {
        const cellString = String(cell || '');

        if (!link && cellString.startsWith('http')) {
            link = cellString;
            continue;
        }
        if (!dateObject) {
            const parsed = parseDateString(cellString);
            if (parsed instanceof Date && isValid(parsed)) {
                dateObject = parsed;
                continue;
            }
        }
        potentialDescriptionCells.push(cellString);
    }
    descriptionContent = potentialDescriptionCells.filter(s => s.trim() !== '').join(' ');

    return { title, link, dateObject, descriptionContent };
}


// --- Feed Generation ---

function generateItemData(values, mode) {
    let items = [];
    if (mode.toLowerCase() === 'manual') {
        items = generateFeedManualModeInternal(values);
        sortFeedItems(items);
    } else {
        items = values.map(row => parseSheetRowAutoMode(row)).filter(item => item !== null);
        sortFeedItems(items);
    }
    return items;
}

function generateFeedManualModeInternal(values) {
    const items = [];
    if (!values || values.length < 2) return items;
    const headers = values[0];
    const headerMap = {};
    const customHeaderMap = {};
    const standardFieldAliases = {
        title: ['title'],
        link: ['link', 'url', 'uri', 'href'],
        description: ['description', 'desc', 'summary', 'content', 'content:encoded'], // Treat content:encoded as description
        dateObject: ['pubdate', 'date', 'published', 'updated', 'timestamp', 'created']
    };

    headers.forEach((header, index) => {
        if (typeof header !== 'string' || header.trim() === '') return;
        const lowerHeader = header.toLowerCase().trim();
        let foundStandard = false;
        for (const standardField in standardFieldAliases) {
            if (standardFieldAliases[standardField].includes(lowerHeader)) {
                // Only map the first occurrence of an alias for a standard field
                if (headerMap[standardField] === undefined) {
                    headerMap[standardField] = index;
                }
                foundStandard = true;
                break;
            }
        }
        // If not a standard field alias, treat as custom
        if (!foundStandard) {
            // Use original header name (preserving case) as key for custom field index map
            customHeaderMap[header] = index;
        }
    });

    const titleIndex = headerMap['title'];
    const linkIndex = headerMap['link'];
    const descriptionIndex = headerMap['description'];
    const dateIndex = headerMap['dateObject'];

    headers.forEach((header, index) => {
        if (typeof header === 'string') headerMap[header.toLowerCase().trim()] = index;
    });

    for (let i = 1; i < values.length; i++) {
        const row = values[i];
        if (!row || row.every(cell => String(cell || '').trim() === '')) continue;

        let title = titleIndex !== undefined ? String(row[titleIndex] || '').trim() : '';
        if (title === '') title = '(Untitled)'; // Placeholder

        const link = linkIndex !== undefined ? String(row[linkIndex] || '').trim() : undefined;
        const descriptionContent = descriptionIndex !== undefined ? String(row[descriptionIndex] || '') : '';
        const dateString = dateIndex !== undefined ? String(row[dateIndex] || '') : undefined;
        let dateObject = parseDateString(dateString);

        // Collect custom fields
        const customFields = {};
        for (const customHeader in customHeaderMap) {
            const customIndex = customHeaderMap[customHeader];
            const customValue = row[customIndex] || '';
            // Store custom field if it has a value
            if (String(customValue).trim() !== '') {
                 // Sanitize header to create a valid XML tag name for later use
                 // Allow alphanumeric, underscore, hyphen, colon. Replace others with underscore. Ensure starts correctly.
                 const tagName = customHeader.replace(/[^a-zA-Z0-9_:-]/g, '_').replace(/^[^a-zA-Z_:]/, '_');
                 if (tagName) {
                    customFields[tagName] = String(customValue); // Store with sanitized tag name
                 }
            }
        }

        items.push({
             title,
             link: link || undefined,
             dateObject,
             descriptionContent,
             customFields: Object.keys(customFields).length > 0 ? customFields : undefined // Add only if non-empty
        });
    }
    return items;
}

function buildFeedData(sheetData, mode, sheetTitle, sheetID, requestUrl, itemLimit, charLimit) {
    let allItems = [];
    let sheetNames = Object.keys(sheetData);

    for (const sheetName of sheetNames) {
        const values = sheetData[sheetName];
        // Pass the correct values array (including header if manual)
        const itemsFromSheet = generateItemData(values, mode);
        allItems = allItems.concat(itemsFromSheet);
    }

    sortFeedItems(allItems);

    let itemCountLimited = false;
    let itemCharLimited = false;
    let limitedItems = allItems;

    if (allItems.length > itemLimit) {
        limitedItems = allItems.slice(0, itemLimit);
        itemCountLimited = true;
    }

    limitedItems = limitedItems.map(item => {
        if (item.descriptionContent && item.descriptionContent.length > charLimit) {
            item.descriptionContent = item.descriptionContent.slice(0, charLimit) + '...';
            itemCharLimited = true;
        }
        return item;
    });

    const latestItemDate = limitedItems.length > 0 && limitedItems[0].dateObject instanceof Date && isValid(limitedItems[0].dateObject)
    ? limitedItems[0].dateObject : new Date();
    const feedDescription = `Feed from Google Sheet (${mode} mode).`;

    const feedData = {
        metadata: {
            title: sheetTitle || 'Google Sheet Feed',
            link: `https://docs.google.com/spreadsheets/d/${sheetID}`,
            feedUrl: requestUrl,
            description: feedDescription,
            lastBuildDate: latestItemDate,
            generator: 'https://github.com/tgel0/crssnt',
            id: `urn:google-sheet:${sheetID}`, // Used for Atom <id>
            itemCountLimited: itemCountLimited,
            itemCharLimited: itemCharLimited
        },
        items: limitedItems
    };
    return feedData;
}

function generateCustomFieldsXml(customFields) {
    if (!customFields || typeof customFields !== 'object') {
        return '';
    }
    let customXml = '';
    for (const tagName in customFields) {
        // Basic check if tagName seems valid (already sanitized during parsing)
        if (tagName && typeof customFields[tagName] === 'string') {
             // Escape the value, do NOT use CDATA by default for unknown tags
            customXml += `<${tagName}>${escapeXmlMinimal(customFields[tagName])}</${tagName}>\n      `;
        }
    }
    return customXml.trimEnd(); // Remove trailing space/newline
}


function generateRssItemXml(itemData) {
    const itemDate = (itemData.dateObject instanceof Date && isValid(itemData.dateObject))
                     ? itemData.dateObject
                     : new Date();

    const pubDateString = format(itemDate, "EEE, dd MMM yyyy HH:mm:ss 'GMT'", { timeZone: 'GMT' });

    const titleCDATA = `<![CDATA[${itemData.title || ''}]]>`;
    const descriptionCDATA = `<![CDATA[${itemData.descriptionContent || ''}]]>`;
    const linkElement = itemData.link ? `<link>${escapeXmlMinimal(itemData.link)}</link>` : '';
    let guidElement;

    if (itemData.link) {
        guidElement = `<guid isPermaLink="true">${escapeXmlMinimal(itemData.link)}</guid>`;
    } else {
        // Fallback GUID using hash
        const stringToHash = `${itemData.title || ''}::${itemData.descriptionContent || ''}`;
        const fallbackGuid = crypto.createHash('sha1').update(stringToHash).digest('hex');
        guidElement = `<guid isPermaLink="false">${fallbackGuid}</guid>`;
    }
    const customFieldsXml = generateCustomFieldsXml(itemData.customFields); 

    return `<item>
                <title>${titleCDATA}</title>
                <description>${descriptionCDATA}</description>
                ${linkElement}
                ${guidElement}
                <pubDate>${pubDateString}</pubDate>
                ${customFieldsXml ? customFieldsXml : ''}
            </item>`;
}


function generateRssFeed(feedData) {
    if (!feedData || !feedData.metadata || !Array.isArray(feedData.items)) {
        console.error("Invalid feedData passed to generateRssFeed");
        // Return a minimal valid feed indicating an error
        return `<?xml version="1.0" encoding="UTF-8"?>
                <rss version="2.0">
                    <channel>
                        <title>Error Generating Feed</title>
                        <link>${escapeXmlMinimal(feedData?.metadata?.link || '')}</link>
                        <description>Could not generate feed due to invalid data.</description>
                    </channel>
                </rss>`;
    }

    const { metadata, items } = feedData;

    const lastBuildDate = (metadata.lastBuildDate instanceof Date && isValid(metadata.lastBuildDate))
                          ? metadata.lastBuildDate
                          : new Date();
    const lastBuildDateString = format(lastBuildDate, "EEE, dd MMM yyyy HH:mm:ss 'GMT'", { timeZone: 'GMT' });
    const itemXmlStrings = items.map(item => generateRssItemXml(item)).join('');

    let descriptionText = metadata.description || '';
    if (metadata.itemCountLimited || metadata.itemCharLimited) {
        descriptionText += ' [Feed truncated by limit]';
    }

    const feedXml = `<?xml version="1.0" encoding="UTF-8"?>    
                    <rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
                    <channel>
                        <title>${escapeXmlMinimal(metadata.title || 'Untitled Feed')}</title>
                        <link>${escapeXmlMinimal(metadata.link || '')}</link>
                        ${metadata.feedUrl ? `<atom:link href="${escapeXmlMinimal(metadata.feedUrl)}" rel="self" type="application/rss+xml" />` : ''}
                        <description>${escapeXmlMinimal(descriptionText || '')}</description>
                        <lastBuildDate>${lastBuildDateString}</lastBuildDate>
                        ${metadata.generator ? `<generator>${escapeXmlMinimal(metadata.generator)}</generator>` : ''}
                        ${itemXmlStrings}
                    </channel>
                    </rss>`;

    return feedXml;
}

function generateAtomEntryXml(itemData, feedMetadata) {
    const itemDate = (itemData.dateObject instanceof Date && isValid(itemData.dateObject))
                     ? itemData.dateObject : new Date();
    const updatedString = formatISO(itemDate);

    const title = itemData.title || 'Untitled Entry';
    const description = itemData.descriptionContent || '';
    const link = itemData.link;

    let entryId;
    const baseId = feedMetadata.id || feedMetadata.link || `urn:uuid:${crypto.createHash('sha1').update(feedMetadata.title || 'feed').digest('hex')}`; // Generate base URN if needed
    
    if (link && link.startsWith('http')) {
        entryId = link;
    } else {
        const stringToHash = `${title}::${description}::${updatedString}`;
        const hash = crypto.createHash('sha1').update(stringToHash).digest('hex');
        entryId = `${baseId}:${hash}`;
    }

    const titleElement = `<title>${escapeXmlMinimal(title)}</title>`;
    const idElement = `<id>${escapeXmlMinimal(entryId)}</id>`; //
    const updatedElement = `<updated>${updatedString}</updated>`;
    const linkElement = link ? `<link href="${escapeXmlMinimal(link)}" rel="alternate" />` : '';
    const contentElement = `<content type="html"><![CDATA[${description}]]></content>`;
    const customFieldsXml = generateCustomFieldsXml(itemData.customFields);
    return `<entry>
                ${titleElement}
                ${idElement}
                ${updatedElement}
                ${linkElement}
                ${contentElement}
                ${customFieldsXml ? customFieldsXml : ''}
            </entry>`;
}

function generateAtomFeed(feedData) {
    if (!feedData || !feedData.metadata || !Array.isArray(feedData.items)) {
       console.error("Invalid feedData passed to generateAtomFeed");
       return `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Error Generating Feed</title><updated>${formatISO(new Date())}</updated><id>urn:uuid:error</id></feed>`;
   }
   const { metadata, items } = feedData;

   const feedUpdatedDate = (metadata.lastBuildDate instanceof Date && isValid(metadata.lastBuildDate))
                         ? metadata.lastBuildDate : new Date();
   const feedUpdatedString = formatISO(feedUpdatedDate);

   const feedId = metadata.id || metadata.feedUrl || metadata.link || `urn:uuid:${crypto.createHash('sha1').update(metadata.title || 'untitled').digest('hex')}`;
   const entryXmlStrings = items.map(item => generateAtomEntryXml(item, metadata)).join('');

   let subtitleText = metadata.description || '';
   if (metadata.itemCountLimited || metadata.itemCharLimited) {
       subtitleText += ' [Feed truncated by limit]';
   }
   const subtitleElement = subtitleText ? `<subtitle>${escapeXmlMinimal(subtitleText)}</subtitle>` : '';

   const feedXml = `<?xml version="1.0" encoding="utf-8"?>
                    <feed xmlns="http://www.w3.org/2005/Atom">
                    <title>${escapeXmlMinimal(metadata.title || 'Untitled Feed')}</title>
                    ${subtitleElement}
                    <link href="${escapeXmlMinimal(metadata.feedUrl || '')}" rel="self" type="application/atom+xml"/>
                    <link href="${escapeXmlMinimal(metadata.link || '')}" rel="alternate"/>
                    <id>${escapeXmlMinimal(feedId)}</id>
                    <updated>${feedUpdatedString}</updated>
                    ${metadata.generator ? `<generator uri="https://github.com/tgel0/crssnt">${escapeXmlMinimal(metadata.generator)}</generator>` : ''}
                    ${entryXmlStrings}
                    </feed>`;

   return feedXml;
}

function generateBlockedFeedPlaceholder(sheetID, outputFormat, feedBaseUrl) {
    const statusCode = 410; // Gone
    let placeholderFeed = '';
    let contentType = '';
    const placeholderTitle = "Feed Unavailable";
    const placeholderDesc = `The requested Google Sheet (ID: ${sheetID}) is currently unavailable or has been blocked by the administrator.`;
    const placeholderLink = 'https://crssnt.com/';

    if (outputFormat === 'atom') {
        contentType = 'application/atom+xml; charset=utf8';
        const updated = formatISO(new Date());
        const feedId = `urn:crssnt:blocked:${sheetID}`;
        placeholderFeed = `<?xml version="1.0" encoding="utf-8"?>
                            <feed xmlns="http://www.w3.org/2005/Atom">
                            <title>${escapeXmlMinimal(placeholderTitle)}</title>
                            <link href="${escapeXmlMinimal(placeholderLink)}" rel="alternate"/>
                            <id>${escapeXmlMinimal(feedId)}</id>
                            <updated>${updated}</updated>
                            <subtitle>${escapeXmlMinimal(placeholderDesc)}</subtitle>
                            <entry>
                                <title>Sheet Unavailable</title>
                                <id>${escapeXmlMinimal(feedId)}:entry:${Date.now()}</id>
                                <updated>${updated}</updated>
                                <content type="text">${escapeXmlMinimal(placeholderDesc)}</content>
                            </entry>
                            </feed>`;
    } else { // Default to RSS
        contentType = 'application/rss+xml; charset=utf8';
        const pubDate = format(new Date(), "EEE, dd MMM yyyy HH:mm:ss 'GMT'", { timeZone: 'GMT' });
        placeholderFeed = `<?xml version="1.0" encoding="UTF-8"?>
                            <rss version="2.0">
                            <channel>
                            <title>${escapeXmlMinimal(placeholderTitle)}</title>
                            <link>${escapeXmlMinimal(placeholderLink)}</link>
                            <description>${escapeXmlMinimal(placeholderDesc)}</description>
                            <lastBuildDate>${pubDate}</lastBuildDate>
                            <item>
                                <title>Sheet Unavailable</title>
                                <description>${escapeXmlMinimal(placeholderDesc)}</description>
                                <pubDate>${pubDate}</pubDate>
                                <guid isPermaLink="false">unavailable-${escapeXmlMinimal(sheetID)}-${Date.now()}</guid>
                            </item>
                            </channel>
                            </rss>`;
    }

    return { feedXml: placeholderFeed, contentType, statusCode };
}


function generateJsonFeedObject(feedData) {
    if (!feedData || !feedData.metadata || !Array.isArray(feedData.items)) {
        console.error("Invalid feedData passed to generateJsonFeedObject");
        // Return minimal error representation
        return {
            version: "https://jsonfeed.org/version/1.1",
            title: "Error Generating Feed",
            description: "Could not generate feed due to invalid data.",
            items: []
        };
    }
    const { metadata, items } = feedData;

    // Add truncation notice to description
    let descriptionText = metadata.description || '';
    if (metadata.itemCountLimited || metadata.itemCharLimited) {
        descriptionText += ' Note: This feed may be incomplete due to configured limits.';
    }

    const jsonFeed = {
        version: "https://jsonfeed.org/version/1.1",
        title: metadata.title || 'Untitled Feed',
        home_page_url: metadata.link, // Link to the sheet
        feed_url: metadata.feedUrl, // Self URL
        description: descriptionText,
        // Add authors if available in metadata later
        // authors: metadata.author ? [{ name: metadata.author.name, url: metadata.author.link, avatar: metadata.author.image }] : undefined,
        items: items.map(item => {
            const itemDate = (item.dateObject instanceof Date && isValid(item.dateObject))
                             ? item.dateObject : new Date();
            // Generate ID: prefer link, fallback to hash-based GUID logic
            let itemId;
            if (item.link && item.link.startsWith('http')) {
                itemId = item.link;
            } else {
                const stringToHash = `${item.title || ''}::${item.descriptionContent || ''}::${formatISO(itemDate)}`;
                itemId = `${metadata.id || 'urn:uuid:temp'}:${crypto.createHash('sha1').update(stringToHash).digest('hex')}`;
            }

            const jsonItem = {
                id: itemId,
                url: item.link, // External URL of the item
                title: item.title,
                content_html: item.descriptionContent, // Assuming description might contain HTML
                date_published: formatISO(itemDate), // RFC 3339 / ISO 8601
                // date_modified: formatISO(itemDate), // Can be same as published
                // Add authors, tags, attachments etc. if available later
            };
            // Add custom fields under a namespaced key
            if (item.customFields) {
                jsonItem._crssnt_custom_fields = item.customFields;
            }
            // Clean up undefined fields
            Object.keys(jsonItem).forEach(key => jsonItem[key] === undefined && delete jsonItem[key]);
            return jsonItem;
        })
    };

    // Clean up undefined top-level fields
    Object.keys(jsonFeed).forEach(key => jsonFeed[key] === undefined && delete jsonFeed[key]);

    return jsonFeed;
}


function generateMarkdown(feedData) {
    if (!feedData || !feedData.metadata || !Array.isArray(feedData.items)) {
       console.error("Invalid feedData passed to generateMarkdown");
       return "# Error Generating Feed\n\nCould not generate feed due to invalid data.";
   }
   const { metadata, items } = feedData;
   let md = '';

   // Header
   md += `# ${escapeMarkdown(metadata.title || 'Untitled Feed')}\n\n`;
   if (metadata.link) {
       md += `**Source:** [${escapeMarkdown(metadata.link)}](${escapeMarkdown(metadata.link)})\n`;
   }
   if (metadata.feedUrl) {
        md += `**Feed URL:** [${escapeMarkdown(metadata.feedUrl)}](${escapeMarkdown(metadata.feedUrl)})\n`;
   }
   if (metadata.description) {
       md += `\n*${escapeMarkdown(metadata.description)}*\n`;
   }
   // Add truncation notice
   if (metadata.itemCountLimited || metadata.itemCharLimited) {
       md += `\n**Note: This feed may be incomplete due to configured limits.**\n`;
   }
   md += `\n---\n\n`; // Separator

   // Items
   if (items.length === 0) {
       md += "_No items found._\n";
   } else {
       items.forEach(item => {
           md += `## ${escapeMarkdown(item.title || '(Untitled)')}\n\n`;
           if (item.dateObject instanceof Date && isValid(item.dateObject)) {
               // Format date nicely for display
               md += `*Published: ${format(item.dateObject, 'PPPppp', { timeZone: 'GMT' })} (GMT)*\n`;
           }
           if (item.link) {
               md += `**Link:** [${escapeMarkdown(item.link)}](${escapeMarkdown(item.link)})\n`;
           }
           md += `\n${item.descriptionContent || ''}\n\n`; // Assume description is plain text or already formatted Markdown

           // Add custom fields if present
           if (item.customFields) {
               md += `**Custom Fields:**\n`;
               for (const key in item.customFields) {
                   md += `* ${escapeMarkdown(key)}: ${escapeMarkdown(item.customFields[key])}\n`;
               }
               md += `\n`;
           }

           md += `\n---\n\n`;
       });
   }

   return md;
}


module.exports = {
    getSheetData,
    buildFeedData,
    generateRssFeed,
    generateAtomFeed,
    generateJsonFeedObject,
    generateMarkdown,    
    generateBlockedFeedPlaceholder,
    escapeMarkdown // Needed for testing
};