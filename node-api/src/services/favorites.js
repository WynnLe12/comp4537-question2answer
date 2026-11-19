// Port of qa_user_favorite_set() (qa-include/app/favorites.php) and the favorite branch of the
// qa_event_limits module, which records the user's last write. The favorite buttons on question,
// user, tag and category pages (app/page.php, ajax/favorite.php) call it for a signed-in user.
const { ApiError } = require('../errors');

// URL names for QA_ENTITY_QUESTION, QA_ENTITY_USER, QA_ENTITY_TAG and QA_ENTITY_CATEGORY.
const ENTITY_TYPES = { questions: 'Q', users: 'U', tags: 'T', categories: 'C' };

function createFavoriteService(repository, { identify }) {
  async function setFavorite({ token, type, entityid, favorite, ip }) {
    const entitytype = ENTITY_TYPES[type];
    if (!entitytype) throw new ApiError(404, 'not_found');
    if (!entityid) throw new ApiError(400, 'invalid_input', { entityid: 'invalid' });
    const identity = await identify(token);
    if (!identity) throw new ApiError(401, 'unauthenticated');
    return repository.transaction(async q => {
      const options = await q.loadOptions();
      const user = await q.findActor(identity.id);
      if (!user) throw new ApiError(401, 'unauthenticated');
      // Q2A ignores a request to follow yourself; the profile page never offers it.
      if (entitytype === 'U' && Number(user.userid) === entityid) throw new ApiError(403, 'favorite_not_allowed');
      // Like Q2A, the entity itself is not looked up: the page only shows buttons for existing ones.
      if (favorite) await q.favoriteCreate(user.userid, entitytype, entityid, options);
      else await q.favoriteDelete(user.userid, entitytype, entityid);
      await q.userWritten(user.userid, ip); // *_favorite / *_unfavorite
      return { entityType: type, entityId: entityid, favorite };
    });
  }

  return {
    favorite: request => setFavorite({ ...request, favorite: true }),
    unfavorite: request => setFavorite({ ...request, favorite: false }),
  };
}
module.exports = { createFavoriteService, ENTITY_TYPES };
