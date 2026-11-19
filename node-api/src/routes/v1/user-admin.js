const { Router } = require('express');
const { readToken, requireApiRequest } = require('../../http/cookies');
const { clientIp } = require('../../http/request');

// Moderating and administering a user, addressed by handle as the profile page is.
function userAdminRoutes({ userAdminService }) {
  const router = Router();
  router.use(requireApiRequest);
  const call = method => async (req, res) => {
    res.json(await userAdminService[method]({ token: readToken(req), ip: clientIp(req.ip), handle: req.params.handle, body: req.body }));
  };
  router.patch('/:handle', call('editUser'));
  router.delete('/:handle', call('deleteUser'));
  router.put('/:handle/level', call('changeLevel'));
  router.post('/:handle/approve', call('approveUser'));
  router.put('/:handle/block', call('blockUser'));
  router.delete('/:handle/block', call('unblockUser'));
  router.post('/:handle/hide-posts', call('hidePosts'));
  return router;
}
module.exports = { userAdminRoutes };
