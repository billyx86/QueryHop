# QueryHop Search Redirector

![Logo for QueryHop](QueryHop%20Extension/Resources/images/Icon-256.png)

A Safari extension that allows you to change your search engine to one outside of Safari's defaults, either through set presets or a supplied custom URL.

## Table of Contents
- [Description](#description)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Presets](#presets)
- [Custom URLs](#custom-urls)
- [Advanced Options](#advanced-options)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)

## Description

QueryHop is a lightweight extension that intercepts searches from Safari's default search engines (Google, Bing, DuckDuckGo, Baidu, etc.) and redirects them to your preferred search engine. Unlike Safari's built-in search engine options, this extension works with any search engine that accepts query parameters.

Key features:
- Redirection from default search engines before they begin to load
- Intergrated preset options for popular alternative search engines
- Custom URL configuration for any search engine
- Works with Safari on macOS (iOS/iPadOS support coming soon!)

## Requirements

- Safari 14.0 or later on macOS 11.0+

## Installation

### From GitHub (Free, Notarized)
1. Download the latest release from the [Releases page](https://github.com/billyx86/QueryHop/releases)
3. Double-click the `.app` file
4. In the confirmation dialog, click **Open**
5. When prompted, click **Quit and Open Safari Extensions Preferences…**
6. Enable the extension in the **Extensions** tab

I will always distribute this extension for free alongside the App Store build.

### From Mac App Store ($0.99)
- This will be updated when the app is live on the Mac App Store.
- This is an option for users who want automatic updates and to support QueryHop's development.

## Usage

1. Install the extension and enable it in Safari's extensions preferences
2. Click on the extension's icon on the toolbar
3. You will have to allow the extension to access the website you are viewing and the search engine you'd like to redirect from (or all websites)*.
5. Either:
   - Select a preset search engine from the dropdown
   - Enter a custom URL with a `%s` placeholder for the search query
6. Click **Save Options**
7. Search using any supported search engine (Google, Bing, etc.), and you'll be automatically redirected to your chosen search engine

\* Unfortunately, there is no way I could find around this. 

This extension does not collect logs or data at all, but for peace of mind I recommend only allowing it for search engines you'd like to redirect from. Please refer to "**Is my search data private?**" under the [FAQs](#faq) for more information.

## Presets

The extension comes with several presets for popular alternative search engines:
- Ask.com
- Brave Search
- Kagi
- Lilo
- Mojeek
- Perplexity
- Presearch
- Qwant
- SearXNG (local instances hosted on port 8080)
- Startpage
- You.com

More presets can be added upon request, or alternatively, they can be found in the [`popup.html`](https://github.com/billyx86/safari-search-redirector/blob/main/Safari%20Search%20Redirector%20Extension/Resources/popup.html) file if you would like to submit a pull request/fork the repository.

## Custom URLs

To use a custom search engine, you need to provide its search URL with a `%s` placeholder where the search query should be inserted.

Example formats:
- `https://example.com/search?q=%s`
- `https://search.example.org/?query=%s&param=value`

The extension will replace `%s` with your search term, properly URL-encoded.

## Advanced Options

### Disable URL Validation

The extension includes a "Disable URL Validation" setting. This is useful for:
- Using non-standard URL schemes
- Omitting the `%s` placeholder (redirects to a static URL)
- Using internal browser URLs

**Warning:** Unsafe Mode can potentially lead to unsafe redirects. Use with caution.

## FAQ

### How does it work?

The extension monitors navigation events to popular search engines. When you submit a search on one of these engines, the extension captures the search query and redirects your browser to your preferred search engine with the same query.

### Does it work with all search engines?

The extension can redirect from the following search engines:
- Google
- Bing
- DuckDuckGo
- Yahoo
- Baidu
- Ecosia
- Yandex

It can redirect to any search engine that accepts query parameters.

### Is my search data private?

The extension processes all data locally and doesn't send any information about your searches to external servers. Your search queries are only shared with the search engine you've chosen to redirect to.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/additional-feature`)
3. Commit your changes (`git commit -m 'Add some awesome feature'`)
4. Push to the branch (`git push origin feature/additional-feature`)
5. Open a Pull Request

## License

This project is licensed under the GPLv3 License - see the LICENSE file for details.
