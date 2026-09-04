# Shopify Image Uploader & Inventory Update Toolkit

This project is a Chrome extension plus a local Node server that does two main jobs:

1. Scan a web page for images and let the user select/download them.
2. Upload a spreadsheet of inventory updates to Shopify and update stock quantities by SKU.

It combines a browser extension UI in [frontend](frontend) with a local backend in [backend](backend) that handles spreadsheet parsing, Shopify API calls, log storage, duplicate detection, and text-copy generation.

---

## What this project does

### 1) Image studio

The extension can:

- scan the current page for image elements and background images
- show thumbnails in the popup UI
- let the user select or clear images
- export the selected images as PNG files
- upload selected images to Shopify

The image workflow is designed for a Chrome extension popup that runs against the current tab content.

### 2) Inventory update workflow

The inventory feature lets a user:

- upload an Excel or CSV file
- review rows before confirming update
- validate that each row has a valid product name, SKU, and quantity
- update Shopify inventory values by matching the SKU
- keep a plain-text log of results
- detect when the same file was already uploaded successfully
- download a .txt copy of each uploaded spreadsheet file

---

## Project structure

- [frontend](frontend) - Chrome extension files
  - [frontend/popup.html](frontend/popup.html) - popup UI
  - [frontend/popup.js](frontend/popup.js) - extension logic
  - [frontend/popup.css](frontend/popup.css) - styling
  - [frontend/manifest.json](frontend/manifest.json) - extension manifest
  - [frontend/background.js](frontend/background.js) - background logic
  - [frontend/content.js](frontend/content.js) - page scan logic

- [backend](backend) - local Node API server
  - [backend/server.js](backend/server.js) - HTTP server and endpoints
  - [backend/shopify.js](backend/shopify.js) - Shopify auth and scope validation
  - [backend/inventory-update.js](backend/inventory-update.js) - spreadsheet parsing and Shopify inventory updates
  - [backend/shopify-upload.js](backend/shopify-upload.js) - image upload to Shopify
  - [backend/uploads](backend/uploads) - temporary uploaded files
  - [backend/logs](backend/logs) - log archive
  - [backend/temp-files](backend/temp-files) - generated .txt copies of uploaded spreadsheets

---

## Required setup

### Install dependencies

From the project root:

```bash
npm install
```

### Start the backend server

```bash
npm start
```

This starts the local API on:

```text
http://localhost:3000
```

The Chrome extension expects this server to be running while it sends upload and inventory requests.

---

## Shopify configuration

Before using the inventory update feature, configure the Shopify app credentials in the backend environment file.

Create or edit [backend/.env](backend/.env) with values like:

```env
SHOPIFY_SHOP=your-store-name
SHOPIFY_CLIENT_ID=your-client-id
SHOPIFY_CLIENT_SECRET=your-client-secret
SHOPIFY_LOCATION_ID=optional-location-id
```

### Required Shopify scopes

The app requires the following scopes:

- read_products
- read_locations
- write_inventory

If a token is missing one of these scopes, the app will show a clear error explaining that the app needs to be reinstalled with the correct permissions.

---

## Excel / CSV file format for inventory updates

The spreadsheet must contain only these three columns:

1. Product Name
2. SKU
3. Quantity

The first row is treated as the header row.

Example:

| Product Name     | SKU     | Quantity |
| ---------------- | ------- | -------- |
| Classic T-Shirt  | TS-1001 | 25       |
| Black Mug        | MUG-404 | 12       |
| Leather Notebook | LN-778  | 0        |

### Important rules

- Use exactly 3 columns.
- The header names should include Product Name, SKU, and Quantity.
- Quantity must be a whole number and cannot be negative.
- Each SKU must appear only once in the sheet.
- Do not include extra columns or unrelated data.
- Format should be Excel (.xlsx or .xls) or CSV.

The app accepts common variations such as `Product Name`, `product name`, `SKU`, `sku`, `Quantity`, `qty`, and similar normalized header names.

---

## Inventory update flow

### Step 1: upload the file

In the extension, open the Inventory update tab and choose a spreadsheet.

### Step 2: preview the rows

The backend reads the spreadsheet and validates:

- product name is present
- SKU is present
- quantity is a whole number
- quantity is zero or greater
- each SKU is unique

Rows that fail validation are listed as rejected entries.

### Step 3: review and update

If the file is valid, the user can click the update button.

The server sends the rows to Shopify and updates the matching product variants by SKU.

### Step 4: result handling

Each update result is recorded as:

- success
- failure
- duplicate already uploaded

The UI shows the result summary and the download area for generated files.

---

## Duplicate file protection

To prevent the same upload from being processed again, the backend checks the previous successful log entries for:

- same filename
- same file content hash
- a previous successful update

If the same file and same inventory values were already uploaded successfully, the app returns a message like:

> This file has already been uploaded and updated successfully.

This prevents accidental double updates of the same spreadsheet.

---

## Logs and plain-text copies

### Text log

The backend stores all inventory activity in plain text at:

- [backend/logs/inventory-log.txt](backend/logs/inventory-log.txt)

Each log entry includes:

- timestamp
- filename
- status (`done` or `failed`)
- message details
- optional hash value to detect duplicate uploads

Example:

```text
[2026-09-04T22:31:16.393Z] sample-inventory-update.csv | done | 6 SKUs updated successfully
```

### Temp .txt file copies

When a spreadsheet is uploaded, the backend saves a text version into:

- [backend/temp-files](backend/temp-files)

The file name matches the uploaded spreadsheet name, but the extension saves it as a `.txt` file in the temp folder.

These files are used for:

- download links in the UI
- audit review
- log comparison
- recovering the original spreadsheet content in plain text

---

## UI behavior and buttons

The inventory tab contains the following interaction points:

- Choose spreadsheet
- View log
- Clear file
- Update all quantities
- Download .txt file for successful output
- Download sample CSV template

The extension also includes a help section explaining the precise file format before the user uploads a sheet.

---

## Development notes

### Local backend

The Node server handles the inventory endpoints and image upload endpoints:

- `/` - health check
- `/upload` - image upload flow
- `/inventory/preview` - validate and parse spreadsheet
- `/inventory/update` - apply inventory updates to Shopify
- `/inventory/logs` - read activity log
- `/inventory/text-copy` - download saved text copy

### Key logic in the backend

- [backend/server.js](backend/server.js) validates requests, writes logs, saves temp files, and exposes the API routes.
- [backend/inventory-update.js](backend/inventory-update.js) parses spreadsheet rows and calls the Shopify GraphQL endpoints.
- [backend/shopify.js](backend/shopify.js) validates token configuration and required app scopes.

---

## Troubleshooting

### Server will not start

Check:

- Node is installed
- dependencies are installed
- the port `3000` is free
- no other copy of the local server is already running

### Shopify access denied

This usually means:

- the app was not installed with the required scopes
- the shop domain is wrong
- the access token is expired or invalid

The app will surface a clear error message if the required scopes are missing.

### Wrong file format

If the spreadsheet does not match the required column pattern, the app will reject rows and show validation errors.

### Duplicate message appears

This means the same file content was already processed successfully and the app is protecting against a second identical update.

---

## Typical workflow summary

1. Configure Shopify credentials and scopes.
2. Run the backend with `npm start`.
3. Open Chrome extension and enable Developer mode.
4. Load this project as an unpacked extension.
5. Use the Image studio tab for image tasks or the Inventory update tab for stock updates.
6. Upload a 3-column spreadsheet.
7. Review validation results.
8. Click update.
9. Download the saved .txt log or text copy if needed.

---

## Notes

This project is intended for a local development environment. The Shopify API calls and local file processing require a running backend service and valid Shopify credentials.

For image download tasks, some websites may block direct access because of hotlink protection, authentication, signed URLs, or other restrictions.

---

## Quick start

```bash
npm install
npm start
```

Then load the extension in Chrome using Developer mode and choose the unpacked project folder.
