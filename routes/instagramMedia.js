// Image/video upload for Instagram posts — mounted at /api/instagram-media
// under requireAuth. Deliberately separate from the existing routes/
// uploads.js (which only accepts PNG/JPEG for product images) rather than
// modifying it, since this feature also needs MP4/MOV for video/Reels.
// Reuses utils/blobStorage.js#uploadImage directly — despite the name, it's
// just "upload this buffer with this mimetype", not image-specific.
const router = require('express').Router();
const multer = require('multer');
const { uploadImage } = require('../utils/blobStorage');

const ALLOWED_TYPES = {
  'image/png': '.png', 'image/jpeg': '.jpg',
  'video/mp4': '.mp4', 'video/quicktime': '.mov',
};
const MAX_SIZE = 100 * 1024 * 1024; // 100MB — generous enough for a short Reel

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_TYPES[file.mimetype]) return cb(new Error('Only PNG/JPEG images or MP4/MOV videos are allowed'));
    cb(null, true);
  },
});

router.post('/upload', (req, res) => {
  upload.single('media')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No media file provided' });
    try {
      const url = await uploadImage(req.file.buffer, req.file.mimetype, req.file.originalname);
      const isVideo = req.file.mimetype.startsWith('video/');
      res.json({ url, mediaType: isVideo ? 'video' : 'image' });
    } catch (uploadErr) {
      res.status(500).json({ error: uploadErr.message });
    }
  });
});

module.exports = router;
