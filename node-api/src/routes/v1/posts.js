const { Router } = require('express');
const { readToken, requireApiRequest } = require('../../http/cookies');
const { clientIp, postIdParam, readVisitorCookie, setVisitorCookie } = require('../../http/request');

// Sends a created post back, setting the visitor cookie when one was created for an anonymous author.
function created(res, result, secureCookies) {
  setVisitorCookie(res, result.cookieid, secureCookies);
  res.status(201).json({ id: result.id, type: result.type, queued: result.queued });
}

function postRoutes({ voteService, postService, secureCookies }) {
  const router = Router();
  router.use(requireApiRequest);
  // Equivalent of the original ajax "vote" operation; the body holds -1, 0 or 1.
  if (voteService) router.put('/:postid/vote', async (req, res) => {
    const vote = req.body?.vote;
    if (![-1, 0, 1].includes(vote)) return res.status(400).json({ error: { code: 'invalid_input', fields: { vote: 'invalid' } } });
    res.json(await voteService.vote({ token: readToken(req), postid: postIdParam(req.params.postid), vote, ip: clientIp(req.ip) }));
  });
  // Comment on a question or an answer.
  if (postService) router.post('/:postid/comments', async (req, res) => {
    created(res, await postService.createComment({
      token: readToken(req), cookieid: readVisitorCookie(req), ip: clientIp(req.ip), parentid: postIdParam(req.params.postid), body: req.body,
    }), secureCookies);
  });
  return router;
}

function questionRoutes({ postService, secureCookies }) {
  const router = Router();
  router.use(requireApiRequest);
  router.post('/', async (req, res) => {
    created(res, await postService.createQuestion({ token: readToken(req), cookieid: readVisitorCookie(req), ip: clientIp(req.ip), body: req.body }), secureCookies);
  });
  router.post('/:questionid/answers', async (req, res) => {
    created(res, await postService.createAnswer({
      token: readToken(req), cookieid: readVisitorCookie(req), ip: clientIp(req.ip), questionid: postIdParam(req.params.questionid), body: req.body,
    }), secureCookies);
  });
  return router;
}
module.exports = { postRoutes, questionRoutes };
