require("dotenv").config();

const fs = require("fs");
const path = require("path");

const { getAccessToken } = require("./shopify");

async function createStagedUpload(filePath, accessToken) {
  const fileName = path.basename(filePath);

  const query = `
    mutation {
        stagedUploadsCreate(
            input: [{
                filename: "${fileName}"
                mimeType: "image/png"
                httpMethod: POST
                resource: FILE
            }]
        ) {
            stagedTargets {
                url
                resourceUrl
                parameters {
                    name
                    value
                }
            }

            userErrors {
                field
                message
            }
        }
    }
`;

  const response = await fetch(
    `https://${process.env.SHOPIFY_SHOP}.myshopify.com/admin/api/2026-01/graphql.json`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },

      body: JSON.stringify({
        query: query,
      }),
    },
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(JSON.stringify(data, null, 2));
  }

  if (data.errors) {
    throw new Error(JSON.stringify(data.errors, null, 2));
  }

  const result = data.data.stagedUploadsCreate;

  if (result.userErrors.length > 0) {
    throw new Error(JSON.stringify(result.userErrors, null, 2));
  }

  return result.stagedTargets[0];
}

async function uploadToStagedTarget(target, filePath) {
  const form = new FormData();

  for (const parameter of target.parameters) {
    form.append(parameter.name, parameter.value);
  }

  const fileBuffer = fs.readFileSync(filePath);

  const blob = new Blob([fileBuffer], {
    type: "image/png",
  });

  form.append("file", blob, path.basename(filePath));

  const response = await fetch(target.url, {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    throw new Error(`Image upload failed: ${response.status}`);
  }

  console.log("Image uploaded to Shopify staging area!");
}

async function createShopifyFile(resourceUrl, accessToken) {
  const query = `
        mutation {
            fileCreate(
                files: [{
                    originalSource: "${resourceUrl}"
                    contentType: IMAGE
                }]
            ) {
                files {
                    id
                    alt
                    createdAt
                }

                userErrors {
                    field
                    message
                }
            }
        }
    `;

  const response = await fetch(
    `https://${process.env.SHOPIFY_SHOP}.myshopify.com/admin/api/2026-01/graphql.json`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },

      body: JSON.stringify({
        query: query,
      }),
    },
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(JSON.stringify(data, null, 2));
  }

  if (data.errors) {
    throw new Error(JSON.stringify(data.errors, null, 2));
  }

  const result = data.data.fileCreate;

  if (result.userErrors.length > 0) {
    throw new Error(JSON.stringify(result.userErrors, null, 2));
  }

  console.log("Shopify file created successfully!");
  console.log("File ID:", result.files[0].id);
}

async function main() {
  const accessToken = await getAccessToken();

  if (!accessToken) {
    console.log("Could not get Shopify access token.");
    return;
  }

  console.log("Token obtained successfully!");

  const imagePath = path.join(__dirname, "upload.png");

  if (!fs.existsSync(imagePath)) {
    console.log("Image not found:", imagePath);
    return;
  }

  console.log("Image found:", imagePath);

  console.log("Creating staged upload...");

  const target = await createStagedUpload(imagePath, accessToken);

  console.log("Staged target parameters:");

  for (const parameter of target.parameters) {
    console.log(parameter.name, "=", parameter.value);
  }

  console.log("Staged upload created!");
  console.log("Upload URL:", target.url);
  console.log("Resource URL:", target.resourceUrl);

  console.log("Uploading image...");

  await uploadToStagedTarget(target, imagePath);

  console.log("Creating Shopify file...");

  await createShopifyFile(target.resourceUrl, accessToken);
}

main();
