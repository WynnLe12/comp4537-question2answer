const { Router } = require('express');
const { readToken, requireApiRequest } = require('../../http/cookies');

const MAX_POSTID = 4294967295; // qa_posts.postid is INT UNSIGNED
// PHP's REMOTE_ADDR shows IPv4 clients as a.b.c.d, not as IPv4-mapped IPv6.
const clientIp = ip => (ip?.startsWith('::ffff:') && ip.includes('.') ? ip.slice(7) : ip);

function postRoutes(voteService) {
  const router = Router();
  router.use(requireApiRequest);
  // Equivalent of the original ajax "vote" operation; the body holds -1, 0 or 1.
  router.put('/:postid/vote', async (req, res) => {
    const vote = req.body?.vote;
    if (![-1, 0, 1].includes(vote)) return res.status(400).json({ error: { code: 'invalid_input', fields: { vote: 'invalid' } } });
    const id = /^\d{1,10}$/.test(req.params.postid) ? Number(req.params.postid) : 0;
    const postid = id > 0 && id <= MAX_POSTID ? id : null;
    res.json(await voteService.vote({ token: readToken(req), postid, vote, ip: clientIp(req.ip) }));
  });
  return router;
}
module.exports = { postRoutes };
