const { Router } = require('express');
const { readToken, requireApiRequest } = require('../../http/cookies');
const { clientIp, postIdParam } = require('../../http/request');

// PUT adds a question, user, tag or category to the signed-in user's favorites; DELETE removes it.
function favoriteRoutes({ favoriteService }) {
  const router = Router();
  router.use(requireApiRequest);
  const handle = method => async (req, res) => {
    res.json(await favoriteService[method]({
      token: readToken(req), type: req.params.type, entityid: postIdParam(req.params.entityid), ip: clientIp(req.ip),
    }));
  };
  router.put('/:type/:entityid', handle('favorite'));
  router.delete('/:type/:entityid', handle('unfavorite'));
  return router;
}
module.exports = { favoriteRoutes };
