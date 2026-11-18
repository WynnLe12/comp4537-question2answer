const { Router } = require('express');
const { readToken, requireApiRequest } = require('../../http/cookies');
const { clientIp, postIdParam, readVisitorCookie, setVisitorCookie } = require('../../http/request');

// Sends a created post back, setting the visitor cookie when one was created for an anonymous author.
function created(res, result, secureCookies) {
  setVisitorCookie(res, result.cookieid, secureCookies);
  res.status(201).json({ id: result.id, type: result.type, queued: result.queued });
}

function postRoutes({ voteService, postService, postChangeService, secureCookies }) {
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
  // Edit a question, answer or comment; an answer can also become a comment (convertToCommentOn).
  if (postChangeService) router.patch('/:postid', async (req, res) => {
    res.json(await postChangeService.editPost({
      token: readToken(req), cookieid: readVisitorCookie(req), ip: clientIp(req.ip), postid: postIdParam(req.params.postid), body: req.body,
    }));
  });
  // Hide, reshow, approve or reject ({ action }), delete a hidden post, claim an anonymous one, or flag.
  if (postChangeService) {
    const change = method => async (req, res) => {
      res.json(await postChangeService[method]({
        token: readToken(req), cookieid: readVisitorCookie(req), ip: clientIp(req.ip), postid: postIdParam(req.params.postid), body: req.body,
      }));
    };
    router.post('/:postid/status', change('setStatus'));
    router.delete('/:postid', change('deletePost'));
    router.post('/:postid/claim', change('claimPost'));
    // Flag a post (hiding it once it has enough flags), take the flag back, or clear every flag.
    router.put('/:postid/flag', change('flagPost'));
    router.delete('/:postid/flag', change('unflagPost'));
    router.delete('/:postid/flags', change('clearFlags'));
  }
  return router;
}

function questionRoutes({ postService, postChangeService, secureCookies }) {
  const router = Router();
  router.use(requireApiRequest);
  router.post('/', async (req, res) => {
    created(res, await postService.createQuestion({ token: readToken(req), cookieid: readVisitorCookie(req), ip: clientIp(req.ip), body: req.body }), secureCookies);
  });
  // Select or unselect the best answer ({ answerId } or null), close ({ details }) and reopen.
  if (postChangeService) {
    const change = method => async (req, res) => {
      res.json(await postChangeService[method]({
        token: readToken(req), cookieid: readVisitorCookie(req), ip: clientIp(req.ip), questionid: postIdParam(req.params.questionid), body: req.body,
      }));
    };
    router.put('/:questionid/selected-answer', change('selectAnswer'));
    router.post('/:questionid/close', change('closeQuestion'));
    router.delete('/:questionid/close', change('reopenQuestion'));
  }
  router.post('/:questionid/answers', async (req, res) => {
    created(res, await postService.createAnswer({
      token: readToken(req), cookieid: readVisitorCookie(req), ip: clientIp(req.ip), questionid: postIdParam(req.params.questionid), body: req.body,
    }), secureCookies);
  });
  return router;
}
module.exports = { postRoutes, questionRoutes };
