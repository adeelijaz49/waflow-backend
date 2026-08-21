const router = require('express').Router();
const multer = require('multer');
const { uploadImage } = require('../utils/blobStorage');

const ALLOWED_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg' };

// memoryStorage — the buffer goes straight to Azure Blob Storage (or the
// local-disk fallback) via utils/blobStorage.js, never touching this app's
// own filesystem in production. See blobStorage.js for why local disk was
// dropped as the durable store.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_TYPES[file.mimetype]) return cb(new Error('Only PNG and JPEG images are allowed'));
    cb(null, true);
  },
});

router.post('/image', (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });
    try {
      const url = await uploadImage(req.file.buffer, req.file.mimetype, req.file.originalname);
      res.json({ url });
    } catch (uploadErr) {
      res.status(500).json({ error: uploadErr.message });
    }
  });
});

module.exports = router;
