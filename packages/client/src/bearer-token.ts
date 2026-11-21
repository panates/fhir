import type { FhirClientInterceptor } from './fhir-client.js';

/**
 * Where a token comes from: `refresh` is true after the server refused the
 * one given (401), to get a new one rather than a cached one
 */
export type FhirTokenProvider = (refresh: boolean) => string | Promise<string>;

/**
 * An interceptor that sends `Authorization: Bearer <token>`. When the server
 * answers 401, it asks the provider for a new token once and sends the
 * request again. Concurrent requests share one refresh.
 *
 * ```ts
 * new FhirClient({ baseUrl, fhir, interceptors: [bearerToken(refresh => tokens.get(refresh))] });
 * ```
 */
export function bearerToken(
  provider: FhirTokenProvider,
): FhirClientInterceptor {
  let current: Promise<string> | undefined;
  let refreshing: Promise<string> | undefined;
  const token = (refresh: boolean): Promise<string> => {
    if (refresh) {
      // one refresh at a time; requests refused meanwhile wait for it
      refreshing ??= Promise.resolve(provider(true)).finally(
        () => (refreshing = undefined),
      );
      current = refreshing;
      return refreshing;
    }
    current ??= Promise.resolve(provider(false));
    return current;
  };
  const withToken = (request: Request, t: string) => {
    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${t}`);
    return new Request(request, { headers });
  };
  return async (request, next) => {
    // the body can be sent once: keep a copy for the retry
    const retry = request.clone();
    const used = await token(false);
    const response = await next(withToken(request, used));
    if (response.status !== 401) return response;
    await response.body?.cancel();
    // a token refreshed by another request meanwhile is used without a new refresh
    const fresh =
      current && (await current) !== used ? await current : await token(true);
    return next(withToken(retry, fresh));
  };
}
