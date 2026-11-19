# Editor uploads migration

Slice 8b: images and files added to posts through the WYSIWYG editor. The Node API checks, resizes
and stores them; PHP still serves the editor's upload page. Reference behaviour: `qa_upload_file()`
and `qa_get_max_upload_size()` in `qa-include/app/upload.php`, `qa_create_blob()` and
`qa_db_blob_create()`, the image helpers in `util/image.php`, and the editor's upload page
`qa-plugin/wysiwyg-editor/qa-wysiwyg-upload.php`.

## v1 contract

| Method and path | Body | Does |
| --- | --- | --- |
| POST `/api/v1/uploads?name=…&maxSize=…&onlyImage=1&maxWidth=…&maxHeight=…` (header `X-Q2A-Request: 1`) | the file itself (any type, up to 16 MB) | Stores the file as a blob; 201 `{ upload: { width, height, format, blobid, bloburl } }` (`width` and `height` for images) |

`name` is the file's original name (its extension sets the format), `maxSize` the caller's own size
limit in bytes, `onlyImage` refuses anything that is not a readable image, and `maxWidth`/`maxHeight`
shrink larger images. Errors: 429 `upload_limit`, 403 `no_permission`, 400 `max_upload_size` (with
`maxSize`, the limit that applied) and 400 `image_not_read`. An anonymous upload without a valid
visitor cookie creates one and sets `qa_id`, as `qa_cookie_get_create()` does.

## What Node reproduces

- The permission check with the hourly upload limits (`max_rate_user_uploads`, `max_rate_ip_uploads`),
  counted before the file is looked at, so refused files still count.
- The size limit: the caller's limit, capped by the MEDIUMBLOB column and PHP's `upload_max_filesize`
  (2 MB). PHP gets an empty file when it was over its own limit, and the bridge passes that on, so
  both refuse it the same way.
- The format: the lowercased extension, and for `png`, `gif`, `jpeg` and `jpg` files the real type of
  a readable image (`gif`, `jpg` or `png`). Other files keep their extension; a broken "image" is
  kept as a file unless only images are allowed.
- Shrinking: `qa_image_constrain()` (floor of the scaled size), drawn onto white (for transparency) and
  saved as a JPEG at quality 90, with the format becoming `jpg`. The editor's image button limits the
  width to 600 px.
- The blob: the file name, the user or (anonymous) the visitor cookie, the address and the time, in
  the database (no `QA_BLOBS_DIRECTORY` here), and its URL as `qa_get_blob_url()` builds it.

## Bridge

The bridge overrides `qa_upload_file()` (which already had the hook) and posts the uploaded file to
Node, turning Node's error codes back into the page's own messages (`main/upload_limit`,
`users/no_permission`, `main/max_upload_size_x`, `main/image_not_read`). Its responses carry
`X-Q2A-Upload-Backend: node-api-v1`. The editor page itself (whether uploads are on, whether all files
are allowed, its size setting) still decides what it asks for, from options Node reads.

## Parity tests

`node-api/tests/parity/uploads.test.js` (14 cases) uploads through the editor page on the PHP site and
the shared UI and directly to the API: small and wide images, a tall image, a JPEG named `.png`, text
files with and without an extension, broken images with and without the image button, the size
limit, anonymous uploads with their new visitor cookie, the hourly limit and uploads switched off.
It compares the editor's reply, the stored blob (format, name, owner, cookie, address and bytes), the
rate limits and the cookie.

## Known differences

- A shrunk image is re-encoded by sharp in Node rather than GD in PHP, so its bytes differ. Its
  format, size and look (average colour within 3/255) match, and the tests compare those.
- Node reads images with sharp, which knows fewer formats than PHP's `getimagesize()` (BMP, for
  example). This only matters for such files named `.png`, `.gif` or `.jpg`.
