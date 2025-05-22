# crssnt 🥐

[![Build Status](https://github.com/tgel0/crssnt/actions/workflows/main.yml/badge.svg)](https://github.com/tgel0/crssnt/actions/workflows/main.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Overview

`crssnt` converts RSS/Atom feeds into LLM-friendly Markdown or JSON. This simplifies integrating feed content into AI workflows.

## Quickstart

This fetches the BBC News RSS feed and returns its content as Markdown optimized for language models., with the `&llm_compact=true` parameter:

```
https://crssnt.com/v1/feed/md/?url=http://feeds.bbci.co.uk/news/rss.xml&llm_compact=true
```

This uses the `group_by_feed=true` parameter to fetch and group items from BBC News and The Guardian and return a combined LLM-optimized Markdown output.
```
https://crssnt.com/v1/feed/md/?url=http://feeds.bbci.co.uk/news/rss.xml&url=https://www.theguardian.com/world/rss&llm_compact=true&group_by_feed=true
```


## Features

*   **LLM-Optimized Conversion:** Transforms RSS/Atom feeds into structured Markdown or JSON, with an `llm_compact` option for conciseness.
*   **Multiple Output Formats:** Supports Markdown, JSON, and Atom for converted feeds.
*   **Feed Aggregation:** Combines (and auto-sorts by date) items from multiple source feeds.
*   **Google Sheet Support:** Can also generate feeds (RSS, Atom, JSON, Markdown) from public Google Sheets.

## Endpoints

Access via `https://crssnt.com/` followed by these endpoint paths:

**Feed Conversion:**
*   `/v1/feed/md/`
*   `/v1/feed/json/`
*   `/v1/feed/atom/`

**Google Sheet Processing:**
*   `/v1/sheet/md/`
*   `/v1/sheet/json/`
*   `/v1/sheet/rss/`
*   `/v1/sheet/atom/`

## Query Parameters

| Parameter         | Description                                                                                                   | Supported Endpoints                                    | Example Values/Notes                                      |
|-------------------|---------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------|-----------------------------------------------------------|
| `url`             | URL of the source RSS/Atom feed. Stack up to 10 URLs together using `&url=`                                   | `/v1/feed/md/`, `/v1/feed/json/`, `/v1/feed/atom/`                          | `url=http://example.com/feed.xml`                         |
| `llm_compact`     | If `true`, produces compact JSON or Markdown output for LLMs.                                                 | `/v1/feed/md/`, `/v1/feed/json/`, `/v1/sheet/md/`, `/v1/sheet/json/`       | `true`, `false`                                           |
| `group_by_feed`   | If `true` and multiple `url`s are provided, items in JSON/Markdown are grouped by original feed title.        | `/v1/feed/md/`, `/v1/feed/json/`                                            | `true`, `false`                                           |
| `max_items`       | Limits the number of items returned.                                                                          | All data-returning functions                                                | `1`, `10`                                                |
| `id`              | Google Sheet ID (from its URL).                                                                               | `/v1/sheet/*`                                                  | `your-sheet-id`                                           |
| `name`            | Name of a specific sheet/tab in Google Spreadsheet. Multiple `name` params for multiple sheets. Defaults to first. | `/v1/sheet/*`                                                  | `Sheet1`, `name=MyData&name=Sheet2`                       |
| `use_manual_mode` | If `true`, uses specific column headers (`title`, `link`, etc.) for mapping. Default `false` (auto-detection). | `/v1/sheet/*`                                                | `true`, `false`                                           |
## Data Privacy

`crssnt` processes user-provided URLs to fetch data. It's a transient processor and doesn't store feed data. Standard logging may occur. See [Privacy Policy](PRIVACY.md).

## Self-Hosting

`crssnt` can be self-hosted as Firebase Cloud Functions. Refer to the Firebase documentation for deploying functions. Use the Firebase Emulator Suite for local testing. The `https://crssnt.com/` service is recommended for most users.

## Contributing

Contributions are welcome. Please fork the repository, make your changes on a new branch, and submit a pull request.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
