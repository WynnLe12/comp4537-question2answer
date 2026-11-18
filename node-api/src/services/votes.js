// Port of qa_vote_error_html() and qa_vote_set() (qa-include/app/votes.php), plus the
// vote branch of the qa_event_limits module (qa-include/plugins/qa-event-limits.php).
const { ApiError } = require('../errors');
const { phpBool } = require('../q2a/php');
const { LIMIT, userPermitError, userLevelForPost } = require('../q2a/permissions');

// Public error codes; the bridge maps each to the language string PHP shows.
const PERMIT_ERRORS = {
  login: [401, 'unauthenticated'],
  confirm: [403, 'vote_must_confirm'],
  confirmDown: [403, 'vote_down_must_confirm'],
  limit: [429, 'vote_limit'],
};

function createVoteService(repository, { identify }) {
  // qa_vote_error_html(): the same checks, in the same order.
  function voteError(post, vote, user, ip, options, limits) {
    if (!post) return [404, 'post_not_found'];
    if (Number(post.hidden)) return [403, 'vote_disabled_hidden'];
    if (Number(post.queued)) return [403, 'vote_disabled_queued'];
    const allowVoting = { Q: 'voting_on_qs', A: 'voting_on_as', C: 'voting_on_cs' }[post.basetype];
    if (!allowVoting || !phpBool(options.get(allowVoting)) || (post.userid !== null && user && Number(post.userid) === Number(user.userid))) {
      return [403, 'vote_not_allowed'];
    }
    const userlevel = userLevelForPost(post, user);
    const context = { userlevel, user, ip, options, limits };
    // PHP uses permit_vote_a for comments as well as answers.
    let permitError = userPermitError({ ...context, permitoption: post.basetype === 'Q' ? 'permit_vote_q' : 'permit_vote_a', limitAction: LIMIT.VOTES });
    const downOnly = !permitError && vote < 0;
    if (downOnly) permitError = userPermitError({ ...context, permitoption: 'permit_vote_down' });
    if (!permitError) return null;
    if (permitError === 'confirm') return PERMIT_ERRORS[downOnly ? 'confirmDown' : 'confirm'];
    return PERMIT_ERRORS[permitError] ?? [403, 'no_permission'];
  }

  // qa_vote_set() after a successful check.
  async function applyVote(q, post, user, vote, ip, options) {
    const old = await q.getUserVote(post.postid, user.userid);
    const oldvote = old ? Number(old.vote) : 0;
    if (oldvote === vote) return;

    await q.setUserVote(post.postid, user.userid, vote);
    await q.recountVotes(post.postid);
    if (!['Q', 'A', 'C'].includes(post.basetype)) return;
    const prefix = post.basetype.toLowerCase();

    if (post.type === 'A') {
      const question = await q.findQuestion(post.parentid);
      const originalAmaxvote = Number(question.amaxvote);
      const potential = Math.max(Number(post.netvotes) + vote - oldvote, 0);
      const open = question.closedbyid === null;
      if (potential > originalAmaxvote) {
        await q.setAmaxvote(question.postid, potential);
        if (originalAmaxvote === 0 && open) await q.unupaqcountUpdate(-1);
      } else if (originalAmaxvote === Number(post.netvotes) && potential < originalAmaxvote) {
        if (Number(question.acount) === 1) {
          await q.setAmaxvote(question.postid, potential);
          if (potential === 0 && open) await q.unupaqcountUpdate(1);
        } else {
          const changed = await q.setAmaxvote(question.postid);
          if (changed > 0 && potential === 0 && open) await q.unupaqcountUpdate(1);
        }
      }
    }

    const columns = [];
    if (vote > 0 || oldvote > 0) columns.push(`${prefix}upvotes`);
    if (vote < 0 || oldvote < 0) columns.push(`${prefix}downvotes`);
    await q.updatePoints(user.userid, columns, options);
    await q.updatePoints(post.userid, [`${prefix}voteds`, 'upvoteds', 'downvoteds'], options);
    if (prefix === 'q') await q.updateHotness(post.postid, options);

    // Event modules: qa_event_limits counts the vote and records the user's last write.
    await q.incrementLimits(user.userid, ip, LIMIT.VOTES, Math.trunc(options.dbTime / 3600));
    await q.userWritten(user.userid, ip);
  }

  return {
    async vote({ token, postid, vote, ip }) {
      const identity = await identify(token); // null when not logged in
      return repository.transaction(async q => {
        const options = await q.loadOptions();
        const post = postid ? await q.findPost(postid) : undefined;
        const user = identity ? await q.findVoter(identity.id) : null;
        const limits = await q.findLimits(user?.userid, ip, LIMIT.VOTES);
        const error = voteError(post, vote, user, ip, options, limits);
        if (error) throw new ApiError(...error);
        if (!user) throw new ApiError(401, 'unauthenticated'); // votes are stored per user
        await applyVote(q, post, user, vote, ip, options);
        const counts = await q.postVotes(post.postid);
        return { vote, post: { id: post.postid, upvotes: counts.upvotes, downvotes: counts.downvotes, netvotes: counts.netvotes } };
      });
    },
  };
}
module.exports = { createVoteService };
