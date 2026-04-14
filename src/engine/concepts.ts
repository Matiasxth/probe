/**
 * Static concept/synonym graph for semantic search.
 * Maps domain concepts to related terms without needing an LLM.
 */

// Bidirectional synonym clusters — if you search any term in a cluster,
// all other terms in the cluster are also searched.
const SYNONYM_CLUSTERS: string[][] = [
  // Authentication & identity
  ['login', 'signin', 'authenticate', 'auth', 'logon', 'sso'],
  ['logout', 'signout', 'logoff', 'deauthenticate'],
  ['register', 'signup', 'enroll', 'onboard'],
  ['password', 'credential', 'secret', 'passphrase'],
  ['token', 'jwt', 'bearer', 'apikey', 'accesstoken', 'refreshtoken'],
  ['session', 'cookie', 'sessionid'],
  ['user', 'account', 'profile', 'member', 'identity'],
  ['role', 'permission', 'privilege', 'access', 'rbac', 'acl'],
  ['authorize', 'authz', 'checkpermission', 'canaccess', 'isallowed'],

  // CRUD operations
  ['create', 'add', 'insert', 'new', 'register', 'post'],
  ['read', 'get', 'fetch', 'find', 'query', 'lookup', 'retrieve', 'load', 'select'],
  ['update', 'edit', 'modify', 'patch', 'change', 'set', 'put'],
  ['delete', 'remove', 'destroy', 'drop', 'erase', 'purge', 'unlink'],
  ['list', 'getall', 'findall', 'browse', 'index', 'enumerate'],

  // Data persistence
  ['save', 'persist', 'store', 'write', 'commit', 'flush'],
  ['cache', 'memoize', 'buffer', 'stash'],
  ['database', 'db', 'datastore', 'repository', 'repo', 'storage'],
  ['migrate', 'migration', 'schema', 'alembic', 'knex'],
  ['query', 'sql', 'orm', 'querybuilder'],
  ['transaction', 'tx', 'atomic', 'rollback'],

  // API & HTTP
  ['endpoint', 'route', 'handler', 'controller', 'action'],
  ['request', 'req', 'input', 'payload', 'body'],
  ['response', 'res', 'reply', 'output'],
  ['middleware', 'interceptor', 'filter', 'guard', 'hook'],
  ['validate', 'validation', 'check', 'verify', 'sanitize', 'parse'],
  ['serialize', 'marshal', 'encode', 'format', 'transform', 'convert'],
  ['deserialize', 'unmarshal', 'decode', 'parse'],

  // Error handling
  ['error', 'exception', 'failure', 'fault', 'err'],
  ['throw', 'raise', 'panic', 'abort'],
  ['catch', 'handle', 'recover', 'rescue', 'fallback'],
  ['retry', 'backoff', 'resilience', 'circuit'],
  ['log', 'logger', 'logging', 'trace', 'debug', 'warn'],

  // Async & concurrency
  ['async', 'await', 'promise', 'future', 'coroutine', 'goroutine'],
  ['queue', 'worker', 'job', 'task', 'consumer', 'producer'],
  ['event', 'emit', 'publish', 'subscribe', 'listener', 'observer', 'bus'],
  ['websocket', 'ws', 'socket', 'realtime', 'stream', 'sse'],
  ['schedule', 'cron', 'timer', 'interval', 'periodic'],

  // Testing
  ['test', 'spec', 'assert', 'expect', 'verify', 'check'],
  ['mock', 'stub', 'fake', 'spy', 'double', 'fixture'],
  ['setup', 'beforeeach', 'beforeall', 'init', 'bootstrap'],
  ['teardown', 'aftereach', 'afterall', 'cleanup', 'dispose'],

  // File & IO
  ['file', 'path', 'directory', 'folder', 'dir'],
  ['read', 'open', 'load', 'import', 'ingest'],
  ['write', 'save', 'export', 'output', 'dump'],
  ['upload', 'attach', 'multipart', 'blob', 'binary'],
  ['download', 'export', 'extract'],

  // Config & environment
  ['config', 'configuration', 'settings', 'options', 'preferences', 'env'],
  ['secret', 'credential', 'apikey', 'password', 'token'],

  // UI/Frontend
  ['component', 'widget', 'element', 'view'],
  ['render', 'display', 'show', 'draw', 'paint'],
  ['state', 'store', 'redux', 'context', 'atom'],
  ['hook', 'usecallback', 'useeffect', 'usememo', 'usestate'],
  ['navigate', 'route', 'redirect', 'push', 'router'],
  ['modal', 'dialog', 'popup', 'overlay', 'drawer'],
  ['form', 'input', 'field', 'submit', 'validation'],

  // Location & maps
  ['gps', 'location', 'geolocation', 'coordinate', 'position', 'latlng', 'geo'],
  ['map', 'marker', 'polygon', 'layer', 'tile'],
  ['track', 'tracking', 'trace', 'follow', 'monitor'],

  // Notification & communication
  ['notify', 'notification', 'alert', 'toast', 'message', 'push'],
  ['email', 'mail', 'smtp', 'sendgrid'],
  ['sms', 'text', 'twilio'],
];

// Build lookup: term → set of related terms
const conceptMap = new Map<string, Set<string>>();

for (const cluster of SYNONYM_CLUSTERS) {
  const normalized = cluster.map((t) => t.toLowerCase());
  for (const term of normalized) {
    const existing = conceptMap.get(term) ?? new Set<string>();
    for (const related of normalized) {
      if (related !== term) existing.add(related);
    }
    conceptMap.set(term, existing);
  }
}

/**
 * Expand a set of keywords with semantic synonyms.
 * "login" → ["login", "signin", "authenticate", "auth", "logon", "sso"]
 */
export function expandKeywords(keywords: string[]): string[] {
  const expanded = new Set<string>(keywords);

  for (const kw of keywords) {
    const lower = kw.toLowerCase();
    const related = conceptMap.get(lower);
    if (related) {
      for (const r of related) {
        expanded.add(r);
      }
    }

    // Also try splitting camelCase/snake_case into parts
    const parts = splitIdentifier(lower);
    for (const part of parts) {
      if (part.length > 2) {
        expanded.add(part);
        const partRelated = conceptMap.get(part);
        if (partRelated) {
          for (const r of partRelated) {
            expanded.add(r);
          }
        }
      }
    }
  }

  return [...expanded];
}

/**
 * Get synonyms for a single term.
 */
export function getSynonyms(term: string): string[] {
  return [...(conceptMap.get(term.toLowerCase()) ?? [])];
}

/**
 * Split a camelCase or snake_case identifier into parts.
 * "loginUser" → ["login", "user"]
 * "find_by_email" → ["find", "by", "email"]
 */
function splitIdentifier(name: string): string[] {
  // snake_case
  if (name.includes('_')) {
    return name.split('_').filter((p) => p.length > 0);
  }
  // kebab-case
  if (name.includes('-')) {
    return name.split('-').filter((p) => p.length > 0);
  }
  // camelCase / PascalCase
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(' ')
    .filter((p) => p.length > 0);
}
