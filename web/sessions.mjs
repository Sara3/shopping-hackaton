export const MAX_SESSIONS = 200;
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export const newSession = (id) => Object.freeze({ id, turns: [], patterns: [], products: [], checkouts: [] });

// Stored sessions are replaced, never mutated. The oldest is evicted past MAX_SESSIONS.
export function createSessionStore(limit = MAX_SESSIONS) {
  let sessions = new Map();
  const busy = new Set();

  const set = (id, session) => {
    const next = new Map(sessions);
    next.delete(id);
    next.set(id, session);
    const overflow = [...next.keys()].slice(0, Math.max(0, next.size - limit));
    overflow.forEach((key) => next.delete(key));
    sessions = next;
  };

  return {
    get: (id) => sessions.get(id),
    getOrNew: (id) => sessions.get(id) ?? newSession(id),
    set,
    delete(id) {
      const next = new Map(sessions);
      next.delete(id);
      sessions = next;
    },
    tryLock(id) {
      if (busy.has(id)) return false;
      busy.add(id);
      return true;
    },
    unlock: (id) => busy.delete(id),
    size: () => sessions.size,
  };
}
