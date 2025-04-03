const { parseISO, isValid } = require('date-fns');

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


module.exports = {
  parseDateString,
  sortFeedItems
};