/**
 * A ~70-line router. Express would do this too, but this app has zero
 * dependencies and that is worth protecting: nothing to audit, nothing to
 * patch, and it will still install in five years.
 */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, options = {}) {
    const names = [];
    const regex = new RegExp(
      `^${pattern.replace(/:[a-zA-Z_]+/g, (m) => {
        names.push(m.slice(1));
        return '([^/]+)';
      })}/?$`,
    );
    this.routes.push({ method, regex, names, handler, options });
    return this;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  find(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.regex.exec(pathname);
      if (!match) continue;
      const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(match[i + 1])]));
      return { route, params };
    }
    return null;
  }
}

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message, details) => new ApiError(400, message, details);
export const notFound = (what = 'Resource') => new ApiError(404, `${what} not found`);
export const unauthorized = (message = 'A valid API key is required') => new ApiError(401, message);
export const forbidden = (message = 'This key is not allowed to do that') => new ApiError(403, message);
