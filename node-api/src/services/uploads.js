// Editor uploads: a port of qa_upload_file() (qa-include/app/upload.php), which the WYSIWYG editor's
// upload page (qa-plugin/wysiwyg-editor/qa-wysiwyg-upload.php) calls for images and files added to posts.
const sharp = require('sharp');
const { ApiError } = require('../errors');
const { phpNum } = require('../q2a/php');
const { LIMIT, userPermitError } = require('../q2a/permissions');
const { path, URL_FORMAT } = require('../q2a/paths');

// qa_get_max_upload_size(): the MEDIUMBLOB column, and PHP's upload_max_filesize (2M by default).
const MEDIUMBLOB_MAX = 16777215;
const PHP_UPLOAD_MAX_FILESIZE = 2 * 1024 * 1024;
const maxUploadSize = () => Math.min(MEDIUMBLOB_MAX, PHP_UPLOAD_MAX_FILESIZE);
const IMAGE_EXTENSIONS = ['png', 'gif', 'jpeg', 'jpg']; // the extensions qa_upload_file() treats as images
const REAL_FORMATS = { gif: 'gif', jpeg: 'jpg', png: 'png' }; // getimagesize() types it renames the format to
const isset = value => value !== null && value !== undefined && value !== '';

// PHP's pathinfo($name)['extension']: after the last dot of the last path segment, if any.
function extensionOf(filename) {
  const base = String(filename ?? '').split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1) : '';
}

// What getimagesize() and imagecreatefromstring() see in the file, or null when it is not an image.
async function readImage(content) {
  try {
    const { width, height, format } = await sharp(content).metadata();
    return width && height ? { width, height, format } : null;
  } catch {
    return null;
  }
}

function createUploadService(repository, { identify }) {
  // { token, cookieid, ip, filename, content, maxSize, onlyImage, maxWidth, maxHeight } → the PHP result
  // array ({ error } or { width, height, format, blobid, bloburl }) and the visitor cookie it used.
  async function upload(request) {
    const content = Buffer.isBuffer(request.content) ? request.content : Buffer.alloc(0);
    const filename = String(request.filename ?? '');
    if (filename.length > 255) throw new ApiError(400, 'validation_failed', { filename: 'too_long' });
    const identity = await identify(request.token);
    return repository.transaction(async q => {
      const options = await q.loadOptions();
      const user = identity ? await q.findActor(identity.id) : null;
      const userid = user ? String(user.userid) : null;
      const ip = request.ip;
      const period = Math.trunc(options.dbTime / 3600);

      // Per-user upload limits: counted before the file is looked at.
      const limits = await q.findLimits(userid, ip, LIMIT.UPLOADS);
      const permit = userPermitError({ permitoption: null, limitAction: LIMIT.UPLOADS, user, ip, options, limits });
      if (permit === 'limit') return { result: { error: 'upload_limit' } };
      if (permit) return { result: { error: 'no_permission' } };
      await q.incrementLimits(userid, ip, LIMIT.UPLOADS, period);

      // The file must not be too large (PHP sees an empty file when it was over its own limit).
      const maxSize = isset(request.maxSize) ? Math.min(phpNum(request.maxSize), maxUploadSize()) : maxUploadSize();
      if (content.length <= 0 || content.length > maxSize) return { result: { error: 'max_upload_size', maxSize } };

      // The type from the extension, corrected from the content for GIF, JPEG and PNG images.
      const result = {};
      let format = extensionOf(filename).toLowerCase();
      const isimage = IMAGE_EXTENSIONS.includes(format);
      const image = isimage ? await readImage(content) : null;
      if (image) {
        result.width = image.width;
        result.height = image.height;
        format = REAL_FORMATS[image.format] ?? format;
      }
      result.format = format;
      if (request.onlyImage && (!isimage || !image)) return { result: { error: 'image_not_read' } };

      // qa_image_constrain() and qa_gd_image_resize(): too-large images shrink, onto white, as JPEG (quality 90).
      let data = content;
      if (image && (isset(request.maxWidth) || isset(request.maxHeight))) {
        const maxWidth = isset(request.maxWidth) ? phpNum(request.maxWidth) : image.width;
        const maxHeight = isset(request.maxHeight) ? phpNum(request.maxHeight) : image.height;
        if (image.width > maxWidth || image.height > maxHeight) {
          const multiplier = Math.min(maxWidth / image.width, maxHeight / image.height);
          const width = Math.floor(image.width * multiplier);
          const height = Math.floor(image.height * multiplier);
          try {
            data = await sharp(content).flatten({ background: '#ffffff' }).resize(width, height, { fit: 'fill' }).jpeg({ quality: 90 }).toBuffer();
            Object.assign(result, { format: 'jpg', width, height });
            format = 'jpg';
          } catch {
            data = content; // GD keeps the original when resampling fails
          }
        }
      }

      // The blob, tied to the user or (anonymous) to the visitor cookie, created if need be.
      let cookieid = request.cookieid && /^\d{1,20}$/.test(request.cookieid) ? request.cookieid : null;
      let cookieCreated = false;
      if (!userid && !(cookieid && await q.cookieExists(cookieid))) {
        cookieid = await q.createCookie(ip);
        cookieCreated = true;
      }
      const blobid = await q.blobCreate({ content: data, format, filename, userid, cookieid, ip });
      if (!blobid) return { result: { error: 'general_error' }, cookieid, cookieCreated };
      result.blobid = blobid;
      result.bloburl = path('blob', { qa_blobid: blobid }, options.get('site_url'), URL_FORMAT.PARAMS);
      return { result, cookieid, cookieCreated };
    });
  }
  return { upload, maxUploadSize };
}

module.exports = { createUploadService };
