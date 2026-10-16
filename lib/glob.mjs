// The one glob dialect the harness understands: `*` matches within a path
// segment and `**/` matches zero or more whole segments. No braces, no
// character classes -- a pattern using them matches only itself, literally,
// which is why a route's `tests` refuses braces outright (lib/config.mjs).
// Shared by canary-target discovery, routing and validate, so a file is a test
// file by exactly one definition.

export function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped
    .split('**/').join('\0')
    .split('*').join('[^/]*')
    .split('\0').join('(?:.*/)?');
  return new RegExp(`^${body}$`);
}
