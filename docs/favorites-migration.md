# Favorites migration

The sixth migrated slice: adding questions, users, tags and categories to a user's favorites and
removing them. The Node API checks and writes; PHP renders the pages and their favorite buttons.
Reference behaviour: `qa_user_favorite_set()` in `app/favorites.php`, `qa_db_favorite_create()`
and `qa_db_favorite_delete()` in `db/favorites.php`, the favorite button handler in `app/page.php`
and its ajax version `ajax/favorite.php`.

## v1 contract

| Method and path | Does | Success |
| --- | --- | --- |
| PUT `/api/v1/favorites/:type/:id` | Add to the signed-in user's favorites | `{ entityType, entityId, favorite: true }` |
| DELETE `/api/v1/favorites/:type/:id` | Remove from favorites | `{ entityType, entityId, favorite: false }` |

`:type` is `questions`, `users`, `tags` or `categories`; `:id` is the post, user, tag word or
category ID. Requests need `X-Q2A-Request: 1` and a signed-in user.

Errors: 401 `unauthenticated`; 403 `favorite_not_allowed` for following yourself (the profile page
never offers it); 404 `not_found` for an unknown type; 400 `invalid_input` for a bad ID.

## What Node reproduces

- The favorite row, added with `INSERT IGNORE` so repeating it changes nothing.
- Update streams: a new favoriter gets the entity's recent shared events copied into their own
  stream, trimmed to `max_store_user_updates`. Once `max_copy_user_updates` users follow an
  entity (or one already uses its shared stream), every follower switches to the shared stream,
  and the threshold rises when a switching user already follows more shared streams than it
  allows, exactly as `qa_db_favorite_create()` does. Removing a favorite deletes it and its
  copied events.
- The user's last write (`written`, `writeip`) from the `qa_event_limits` module.
- Like PHP, the entity itself is not looked up; the pages only show buttons for existing ones.
- When `max_copy_user_updates` has no row yet, Node stores its default on first use, as PHP's
  `qa_opt()` does.

## Bridge

`qa_user_favorite_set()` gains the standard `qa_to_override` hook. The bridge overrides it to call
Node and sends `X-Q2A-Favorite-Backend: node-api-v1`, so both the plain form buttons and the
ajax buttons on question, user, tag and category pages go to Node. Following yourself stays a
silent no-op in the bridge, as in PHP.

## Parity tests

`node-api/tests/parity/favorites.test.js` (10 cases) presses the favorite buttons on the PHP site
and the shared UI, with and without JavaScript (the ajax request), calls the API, and compares
outcomes, favorites, the events copied into each stream, the shared-stream switch and threshold,
and last writes. Cases: questions, users and tags, removing, following yourself, anonymous
visitors, switching to a shared stream and raising its threshold.

## Known differences

- An unknown entity type is refused before anything is written; PHP writes the row and then stops
  with "Favorite type not recognized". The pages never send one.
- Category favorites use the same code path but have no parity case, because the test sites have
  no categories and adding one changes the ask form for every other suite.
