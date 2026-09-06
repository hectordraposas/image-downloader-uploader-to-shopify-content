# Inventory Dashboard

This project is a local Shopify inventory dashboard that runs from a Node.js backend and serves a browser UI for spreadsheet-based stock updates.

## What it does

- Upload CSV or Excel files from the browser
- Preview rows before sending them to Shopify
- Update inventory quantities by SKU
- Keep a shared queue of uploaded files for same-network access
- Save plain-text log entries with timestamps and results
- Store .txt copies of spreadsheet content in the temp-files folder
- Protect server routes with an admin key

## Current workflow

1. Open the dashboard in a browser.
2. Use the Upload & Update tab to choose a spreadsheet.
3. Review the parsed rows.
4. Click Update all quantities.
5. The app sends the data to Shopify by SKU.
6. The server records successful or failed updates in the log.
7. Download the generated text copy when needed.

## Queue behavior

- Queue items are used to stage files before upload.
- Each queued item shows file name, file size, uploader PC, IP, and timestamp.
- The queue can be used from computers on the same local network.
- The queue supports Upload and Delete actions.
- The Edit action has been removed from the current UI.

## Spreadsheet format

The spreadsheet must contain exactly these 3 columns:

Product Name,SKU,Quantity
Classic T-Shirt,TS-1001,25
Black Mug,MUG-404,12

Rules:

- Use a header row.
- Keep only Product Name, SKU, and Quantity.
- Quantity should be numeric.
- Do not add extra columns.

## Setup

### 1) Install dependencies

```bash
npm install
```

### 2) Configure environment values

Create a `.env` file in the project root with values like:

```env
ADMIN_KEY=your-secret-admin-key
HOST=0.0.0.0
PORT=3000
SHOP_NAME=your-shop-name
SHOPIFY_ACCESS_TOKEN=your-access-token
```

### 3) Start the server

```bash
node backend/server.js
```

### 4) Open the dashboard

```text
http://localhost:3000/inventory
```

For another device on the same network, use the host machine IP instead of localhost:

```text
http://192.168.1.20:3000/inventory
```

## Security

- Protected routes require the admin key in the `x-admin-key` header.
- The client must use the same key as the server `.env` file.
- Keep the dashboard on a trusted local network only.

## Project structure

- backend/server.js — API server, admin enforcement, queue logic, logs, and frontend serving
- backend/inventory-update.js — spreadsheet parsing and Shopify update logic
- backend/shopify.js — Shopify auth helpers
- backend/shopify-upload.js — upload support
- backend/logs/inventory-log.txt — inventory activity log
- backend/temp-files — generated .txt copies
- frontend/inventory.html — browser dashboard UI
- frontend/inventory.js — frontend logic
- frontend/inventory.css — dashboard styling

## Logs and text copies

The inventory log is saved in plain text under:

- backend/logs/inventory-log.txt

Generated .txt copies are saved under:

- backend/temp-files

These files help with audit trails, duplicate checks, and reviewing the exact spreadsheet content that was processed.

## Troubleshooting

### Queue is empty on another computer

Check:

- server URL is the machine IP, not localhost
- the admin key matches the server `.env`
- the same network can reach the host on port 3000

### Shopify access denied

Check:

- access token is valid
- shop name is correct
- required app permissions are granted

### File rejected

Make sure the spreadsheet is in the exact 3-column format and has valid numbers.

## Notes

- The dashboard is intended for local network use.
- The UI intentionally does not include the queue edit button in the current build.
- Logs and queued files are protected by the server admin key for security.
