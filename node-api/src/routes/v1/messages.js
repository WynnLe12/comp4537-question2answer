const { Router } = require('express');
const { readToken, requireApiRequest } = require('../../http/cookies');
const { clientIp, postIdParam } = require('../../http/request');

// Private messages and wall posts. Users are addressed by handle, as the message and wall pages are.
function userMessageRoutes({ messageService }) {
  const router = Router();
  router.use(requireApiRequest);
  router.post('/:handle/messages', async (req, res) => {
    res.status(201).json(await messageService.sendMessage({ token: readToken(req), handle: req.params.handle, body: req.body, ip: clientIp(req.ip) }));
  });
  router.post('/:handle/wall', async (req, res) => {
    res.status(201).json(await messageService.postOnWall({ token: readToken(req), handle: req.params.handle, body: req.body, ip: clientIp(req.ip) }));
  });
  return router;
}

function wallPostRoutes({ messageService }) {
  const router = Router();
  router.use(requireApiRequest);
  router.delete('/:messageid', async (req, res) => {
    res.json(await messageService.deleteWallPost({ token: readToken(req), messageid: postIdParam(req.params.messageid), ip: clientIp(req.ip) }));
  });
  return router;
}

// DELETE /api/v1/messages/inbox/:id or /outbox/:id hides a private message from that box.
function privateMessageRoutes({ messageService }) {
  const router = Router();
  router.use(requireApiRequest);
  router.delete('/:box/:messageid', async (req, res) => {
    res.json(await messageService.deleteMessage({ token: readToken(req), box: req.params.box, messageid: postIdParam(req.params.messageid), ip: clientIp(req.ip) }));
  });
  return router;
}
module.exports = { userMessageRoutes, wallPostRoutes, privateMessageRoutes };
