const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
require("dotenv").config();

const B2_BUCKET = process.env.B2_BUCKET_NAME || "secure-vault-files";
const B2_ENDPOINT = process.env.B2_ENDPOINT || "https://s3.us-east-005.backblazeb2.com";
const B2_REGION = process.env.B2_REGION || "us-east-005";
const B2_KEY_ID = process.env.B2_KEY_ID;
const B2_APPLICATION_KEY = process.env.B2_APPLICATION_KEY;

let b2Client = null;
let isB2Configured = false;
let isB2Connected = false;

function initB2() {
  if (B2_KEY_ID && B2_APPLICATION_KEY && B2_BUCKET) {
    try {
      b2Client = new S3Client({
        endpoint: B2_ENDPOINT,
        region: B2_REGION,
        credentials: {
          accessKeyId: B2_KEY_ID,
          secretAccessKey: B2_APPLICATION_KEY,
        },
        forcePathStyle: true,
      });
      isB2Configured = true;
      console.log(`[Backblaze B2] Client initialized with endpoint: ${B2_ENDPOINT}, bucket: ${B2_BUCKET}`);
    } catch (err) {
      console.error("[Backblaze B2 Init Error]", err.message);
      b2Client = null;
      isB2Configured = false;
    }
  } else {
    console.log("[Backblaze B2] Missing credentials in .env. Operating in local storage mode.");
  }
}

initB2();

/**
 * Test connectivity to Backblaze B2
 */
async function testB2Connection() {
  if (!isB2Configured || !b2Client) {
    return {
      connected: false,
      configured: false,
      bucket: B2_BUCKET,
      message: "B2 credentials not configured",
    };
  }

  try {
    // Test with a harmless check
    const pingKey = `.b2_ping_${Date.now()}.tmp`;
    await b2Client.send(
      new PutObjectCommand({
        Bucket: B2_BUCKET,
        Key: pingKey,
        Body: "ok",
        ContentType: "text/plain",
        ContentLength: 2,
      })
    );
    await b2Client.send(
      new DeleteObjectCommand({
        Bucket: B2_BUCKET,
        Key: pingKey,
      })
    );

    isB2Connected = true;
    console.log(`[Backblaze B2] Successfully connected and verified bucket: ${B2_BUCKET}`);
    return {
      connected: true,
      configured: true,
      bucket: B2_BUCKET,
      endpoint: B2_ENDPOINT,
      region: B2_REGION,
    };
  } catch (err) {
    console.warn(`[Backblaze B2 Warning] Connection test: ${err.message}`);
    isB2Connected = false;
    return {
      connected: false,
      configured: true,
      bucket: B2_BUCKET,
      error: err.message,
    };
  }
}

/**
 * Upload an object (file or text) to Backblaze B2
 */
async function uploadToB2({ key, body, contentType, contentLength }) {
  if (!b2Client) {
    throw new Error("Backblaze B2 is not configured");
  }

  const command = new PutObjectCommand({
    Bucket: B2_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType || "application/octet-stream",
    ContentLength: contentLength,
  });

  return await b2Client.send(command);
}

/**
 * Retrieve an object from Backblaze B2 as a stream
 */
async function getFromB2({ key }) {
  if (!b2Client) {
    throw new Error("Backblaze B2 is not configured");
  }

  const command = new GetObjectCommand({
    Bucket: B2_BUCKET,
    Key: key,
  });

  return await b2Client.send(command);
}

/**
 * Delete an object from Backblaze B2
 */
async function deleteFromB2({ key }) {
  if (!b2Client) return;
  try {
    const command = new DeleteObjectCommand({
      Bucket: B2_BUCKET,
      Key: key,
    });
    return await b2Client.send(command);
  } catch (err) {
    console.error(`[Backblaze B2] Cleanup failed for ${key}:`, err.message);
  }
}

/**
 * Check if an object exists in Backblaze B2
 */
async function existsInB2({ key }) {
  if (!b2Client) return false;
  try {
    await b2Client.send(
      new HeadObjectCommand({
        Bucket: B2_BUCKET,
        Key: key,
      })
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a short-lived presigned download URL
 */
async function getPresignedDownloadUrl({ key, expiresInSeconds = 300 }) {
  if (!b2Client) return null;
  try {
    const command = new GetObjectCommand({
      Bucket: B2_BUCKET,
      Key: key,
    });
    return await getSignedUrl(b2Client, command, { expiresIn: expiresInSeconds });
  } catch (err) {
    console.error("[Backblaze B2 Presign Error]", err.message);
    return null;
  }
}

module.exports = {
  b2Client,
  isB2Configured: () => isB2Configured,
  isB2Connected: () => isB2Connected,
  testB2Connection,
  uploadToB2,
  getFromB2,
  deleteFromB2,
  existsInB2,
  getPresignedDownloadUrl,
  B2_BUCKET,
};
