const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { APP_URL, UPLOAD_DIR } = require('../utils/config');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg' };

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = ALLOWED_TYPES[file.mimetype] || path.extname(file.originalname) || '';
    cb(null, `${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_TYPES[file.mimetype]) return cb(new Error('Only PNG and JPEG images are allowed'));
    cb(null, true);
  },
});

router.post('/image', (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });
    res.json({ url: `${APP_URL}/uploads/${req.file.filename}` });
  });
});

module.exports = router;
