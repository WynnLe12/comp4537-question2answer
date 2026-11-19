// Port of qa_path() and qa_path_absolute() (qa-include/qa-base.php) for the links Node puts in
// emails. Custom page slugs (qa_get_request_map()) are not applied.
const URL_FORMAT = { INDEX: 0, NEAT: 1, PARAM: 3, PARAMS: 4, SAFEST: 5 }; // QA_URL_FORMAT_*

// PHP's rawurlencode() (RFC 3986: everything except unreserved characters).
const rawurlencode = value => encodeURIComponent(String(value)).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function path(request, params, rooturl, neaturls) {
  let url = rooturl + (!rooturl || rooturl.endsWith('/') ? '' : '/');
  let paramsextra = '';
  const requestparts = String(request).split('/').map(rawurlencode);
  const requestpath = requestparts.join('/');
  switch (Number(neaturls)) {
    case URL_FORMAT.INDEX: if (request) url += `index.php/${requestpath}`; break;
    case URL_FORMAT.NEAT: url += requestpath; break;
    case URL_FORMAT.PARAM: if (request) paramsextra = `?qa=${requestpath}`; break;
    default: url += 'index.php'; // falls through to the PARAMS format, as in PHP
    // eslint-disable-next-line no-fallthrough
    case URL_FORMAT.PARAMS:
      if (request) requestparts.forEach((part, index) => { paramsextra += `${paramsextra ? '&' : '?'}qa${index ? `_${index}` : ''}=${part}`; });
  }
  for (const [key, value] of Object.entries(params ?? {})) {
    paramsextra += `${paramsextra ? '&' : '?'}${rawurlencode(key)}=${rawurlencode(value ?? '')}`;
  }
  return url + paramsextra;
}

const pathAbsolute = (options, request, params) => path(request, params, options.get('site_url'), options.get('neat_urls'));

module.exports = { path, pathAbsolute, rawurlencode, URL_FORMAT };
