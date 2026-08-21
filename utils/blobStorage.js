// Product/service image storage. Local disk on Azure App Service turned out
// NOT to be the durable storage the original design assumed — every
// previously-uploaded image was found missing from production (confirmed:
// a fresh upload was immediately reachable, but every pre-existing one
// 404'd), most likely wiped by an app restart/redeploy despite writing to
// the supposedly-persistent /home path. Azure Blob Storage is genuinely
// durable and is what this should have used from the start.
//
// Falls back to local disk when AZURE_STORAGE_CONNECTION_STRING isn't set —
// keeps local dev working without needing real Azure credentials, matching
// this app's existing convention for optional external services (RESEND_API_KEY,
// WA_APP_ID/SECRET, etc. all degrade gracefully rather than hard-failing).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { BlobServiceClient } = require('@azure/storage-blob');
const { APP_URL, UPLOAD_DIR } = require('./config');

const CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_NAME = process.env.AZURE_STORAGE_CONTAINER || 'uploads';

let _containerClient = null;
function containerClient() {
  if (!_containerClient) {
    const service = BlobServiceClient.fromConnectionString(CONNECTION_STRING);
    _containerClient = service.getContainerClient(CONTAINER_NAME);
  }
  return _containerClient;
}

if (!CONNECTION_STRING) {
  console.warn('[blobStorage] AZURE_STORAGE_CONNECTION_STRING not set — falling back to local disk (fine for local dev, NOT durable in production).');
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Ensures the container exists (idempotent — safe to call on every boot) with
// anonymous public read access on blobs only, so WhatsApp's own servers can
// fetch an image URL directly with no auth, same as the local-disk /uploads
// static route already allowed.
async function ensureContainer() {
  if (!CONNECTION_STRING) return;
  await containerClient().createIfNotExists({ access: 'blob' });
}

function extFor(mimetype, originalname) {
  const map = { 'image/png': '.png', 'image/jpeg': '.jpg' };
  return map[mimetype] || path.extname(originalname) || '';
}

// buffer must come from multer.memoryStorage() — this module has no
// filesystem dependency on the upload side when Azure is configured.
async function uploadImage(buffer, mimetype, originalname) {
  const filename = `${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}${extFor(mimetype, originalname)}`;

  if (!CONNECTION_STRING) {
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
    return `${APP_URL}/uploads/${filename}`;
  }

  await ensureContainer();
  const blockBlobClient = containerClient().getBlockBlobClient(filename);
  await blockBlobClient.uploadData(buffer, { blobHTTPHeaders: { blobContentType: mimetype } });
  return blockBlobClient.url;
}

module.exports = { uploadImage, ensureContainer };
