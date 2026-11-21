const express = require('express');
const { readToken, requireApiRequest } = require('../../http/cookies');
const { clientIp } = require('../../http/request');

// Site administration (admins only).
function siteAdminRoutes({ siteAdminService, recalcService }) {
  const router = express.Router();
  // The default avatar's image is the body, so this route checks the API request header itself.
  router.put('/default-avatar', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.get('X-Q2A-Request') !== '1' || !req.is('image/*')) return res.status(403).json({ error: { code: 'request_not_allowed' } });
    next();
  }, express.raw({ type: 'image/*', limit: '2mb' }), async (req, res) => {
    res.json(await siteAdminService.uploadDefaultAvatar({ token: readToken(req), ip: clientIp(req.ip), image: Buffer.isBuffer(req.body) ? req.body : null }));
  });
  router.use(requireApiRequest);
  const call = method => async (req, res) => {
    res.json(await siteAdminService[method]({ token: readToken(req), ip: clientIp(req.ip), host: req.get('Host'), params: req.params, body: req.body }));
  };
  router.get('/ai/usage', call('getAiUsage'));
  router.put('/options', call('saveOptions'));
  router.post('/options/reset', call('resetOptions'));
  // The recalculation tools: { state } (or an operation such as "dorecountposts") and { seconds }.
  if (recalcService) router.post('/recalc', async (req, res) => {
    res.json(await recalcService.perform({ token: readToken(req), ip: clientIp(req.ip), body: req.body }));
  });
  router.post('/mailing/test', call('mailingTest'));
  router.post('/mailing/start', call('mailingStart'));
  router.post('/mailing/stop', call('mailingStop'));
  router.post('/mailing/step', call('mailingStep'));
  router.put('/plugins', call('setEnabledPlugins'));
  router.post('/categories', call('saveCategory'));
  router.put('/categories/:categoryid', async (req, res) => {
    res.json(await siteAdminService.saveCategory({ token: readToken(req), ip: clientIp(req.ip), body: { ...req.body, categoryid: Number(req.params.categoryid) } }));
  });
  router.delete('/categories/:categoryid', call('deleteCategory'));
  router.post('/categories/:categoryid/reassign', call('reassignCategory'));
  const withId = (method, key) => async (req, res) => {
    res.json(await siteAdminService[method]({ token: readToken(req), ip: clientIp(req.ip), body: { ...req.body, [key]: Number(req.params[key]) } }));
  };
  router.post('/pages', call('savePage'));
  router.put('/pages/:pageid', withId('savePage', 'pageid'));
  router.delete('/pages/:pageid', call('deletePage'));
  router.post('/widgets', call('saveWidget'));
  router.put('/widgets/:widgetid', withId('saveWidget', 'widgetid'));
  router.delete('/widgets/:widgetid', call('deleteWidget'));
  router.post('/user-titles', call('saveUserTitle'));
  router.post('/user-fields', call('saveUserField'));
  router.put('/user-fields/:fieldid', withId('saveUserField', 'fieldid'));
  router.delete('/user-fields/:fieldid', call('deleteUserField'));
  return router;
}
module.exports = { siteAdminRoutes };
