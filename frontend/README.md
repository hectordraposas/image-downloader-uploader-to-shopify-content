# Image Canvas Downloader

Chrome Manifest V3 extension that:

- Scans the current webpage for `<img>` elements and CSS background images.
- Shows thumbnails in the extension popup.
- Lets you select individual images or select/clear all.
- Creates every selected image as a separate PNG.
- Every output is exactly **1000 × 1000 px**.
- **White + 200 px padding** mode places the image inside a 600 × 600 area.
- **Full-screen image background** mode fills the complete 1000 × 1000 canvas.
- Upload directly to shopify.

## Install

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the extracted `image_downloader` folder.
5. Open a webpage containing images.
6. Click the extension icon.

## Notes

Some websites protect their images with authentication, hotlink protection, signed URLs, or other restrictions. Those images may fail to download.

The extension requests access to all websites because it needs to retrieve image files from arbitrary pages for canvas processing.
