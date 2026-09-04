const fs = require("fs");
const path = require("path");

const API_VERSION = "2026-01";
const { getShopDomain } = require("./shopify");

async function createStagedUpload(fileName, accessToken) {
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
    `https://${getShopDomain()}/admin/api/${API_VERSION}/graphql.json`,
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

  if (!result.stagedTargets.length) {
    throw new Error("Shopify did not return a staged target.");
  }

  console.log("Staged upload created!");

  return result.stagedTargets[0];
}

async function uploadToStagedTarget(target, filePath) {
  const form = new FormData();

  // Add Shopify's required parameters
  for (const parameter of target.parameters) {
    form.append(parameter.name, parameter.value);
  }

  const fileBuffer = fs.readFileSync(filePath);

  const blob = new Blob([fileBuffer], {
    type: "image/png",
  });

  form.append("file", blob, path.basename(filePath));

  console.log("Uploading image to Shopify staging...");

  const response = await fetch(target.url, {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    const errorText = await response.text();

    console.error("Shopify staging upload error:", errorText);

    throw new Error(`Shopify staging upload failed: ${response.status}`);
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
    `https://${getShopDomain()}/admin/api/${API_VERSION}/graphql.json`,
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

  if (!result.files.length) {
    throw new Error("Shopify did not create the file.");
  }

  console.log("Shopify file created successfully!");

  return result.files[0];
}

async function uploadImage(filePath, accessToken) {
  const fileName = path.basename(filePath);

  console.log("Starting Shopify upload:", fileName);

  // 1. Create staged upload
  const target = await createStagedUpload(fileName, accessToken);

  // 2. Upload image to staging
  await uploadToStagedTarget(target, filePath);

  // 3. Create permanent Shopify file
  const file = await createShopifyFile(target.resourceUrl, accessToken);

  return file;
}

module.exports = {
  uploadImage,
};
