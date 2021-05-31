import * as http from 'http';
import * as querystring from 'querystring';
import * as joi from 'joi';
import { match } from 'path-to-regexp';
import { pipeline } from 'stream';

import {
  FAIL_EXCEPTION_CODE,
  failWith,
  Handler,
  stopPropagationWith,
  Toolkit,
} from '../daisugi/daisugi';
import { compress } from './compress';
import { setCache, setInfiniteCache } from './cache';
import { isStream } from './utils';
import { Context } from './types';

export { Context as Context };

function getQuerystring(
  querystringStartPosition: number,
  rawRequest: http.IncomingMessage,
) {
  if (querystringStartPosition > -1) {
    return querystring.parse(
      rawRequest.url.slice(querystringStartPosition + 1),
    );
  }

  return {};
}

function getUrl(
  querystringStartPosition: number,
  rawRequest: http.IncomingMessage,
) {
  if (querystringStartPosition > -1) {
    return rawRequest.url.slice(
      0,
      querystringStartPosition,
    );
  }

  return rawRequest.url;
}

function deferredPromise() {
  let resolve;
  let reject;

  const promise = new Promise(
    (privateResolve, privateReject) => {
      resolve = privateResolve;
      reject = privateReject;
    },
  );

  return {
    resolve,
    reject,
    promise,
  };
}

function createWebServer(port = 3000) {
  const connectionTimeout = 30000; // 30s
  const keepAliveTimeout = 5000; // 5s default NodeJS
  // const bodyLimit = 1024 * 1024; // 1 MB

  function handler(toolkit: Toolkit) {
    const isStarted = deferredPromise();

    const server = http.createServer(
      (rawRequest, rawResponse) => {
        const querystringStartPosition =
          rawRequest.url.indexOf('?');

        const context: Context = {
          rawRequest,
          rawResponse,
          request: {
            url: getUrl(
              querystringStartPosition,
              rawRequest,
            ),
            matchedRoutePath: null,
            params: {},
            headers: rawRequest.headers,
            querystring: getQuerystring(
              querystringStartPosition,
              rawRequest,
            ),
            body: {},
            method: rawRequest.method,
          },
          response: {
            statusCode: 200,
            body: null,
            headers: {
              'cache-control': 'no-cache',
              'content-type': 'text/html; charset=UTF-8',
              'last-modified': new Date().toUTCString(),
            },
          },
          sendFile() {},
        };

        toolkit.nextWith(context);

        const body = context.response.body;

        if (body) {
          if (Buffer.isBuffer(body)) {
            context.response.headers['Content-Length'] =
              body.length;
          }

          if (typeof body === 'string') {
            context.response.headers['Content-Length'] =
              Buffer.byteLength(body);
          }
        }

        rawResponse.statusCode =
          context.response.statusCode;

        Object.entries(context.response.headers).forEach(
          ([key, value]) => {
            rawResponse.setHeader(key, value);
          },
        );

        // Maybe introduce short circuit when method is HEAD.
        if (!body) {
          rawResponse.end();
          return;
        }

        if (isStream(body)) {
          pipeline(body, rawResponse, (error) => {
            if (error) {
              // TODO: Do something.
              console.log('ERROR', error);
            }
          });

          return;
        }

        rawResponse.end(body);
      },
    );

    server.setTimeout(connectionTimeout, () => {
      // TODO: Log timeout.
      console.log('Request timeout');
    });
    server.keepAliveTimeout = keepAliveTimeout;

    server.listen(port, () => {
      isStarted.resolve();
    });

    return isStarted.promise;
  }

  handler.meta = {
    injectToolkit: true,
  };

  return handler;
}

function captureError(userHandler: Handler) {
  function handler(context: Context, toolkit: Toolkit) {
    try {
      const result = toolkit.next;

      if (
        result.isFailure &&
        result.error.code === FAIL_EXCEPTION_CODE
      ) {
        return userHandler(result.error.value);
      }

      if (context.response.statusCode >= 500) {
        return userHandler(result.error.value);
      }

      return context;
    } catch (error) {
      console.log(error);

      return userHandler(context);
    }
  }

  handler.meta = {
    injectToolkit: true,
  };

  return handler;
}

function validate(schema) {
  const validationSchema = joi.object(schema);

  return function (context: Context) {
    const { error, value } = validationSchema.validate(
      context.request,
      {
        allowUnknown: true,
      },
    );

    if (error) {
      context.response.statusCode = 400;

      return failWith(context);
    }

    context.request = value;

    return context;
  };
}

function createRouteHandler(
  routePath: string,
  routeMethod: string,
) {
  const matchFn = match(routePath, {
    decode: decodeURIComponent,
  });

  return function (context: Context) {
    if (context.request.matchedRoutePath) {
      return stopPropagationWith(context);
    }

    if (
      routeMethod !== 'ALL' &&
      context.request.method !== routeMethod
    ) {
      return stopPropagationWith(context);
    }

    const matchedUrl = matchFn(context.request.url);

    if (!matchedUrl) {
      return stopPropagationWith(context);
    }

    // @ts-ignore
    context.request.params = matchedUrl.params;
    context.request.matchedRoutePath = routePath;
    context.response.statusCode = 200;

    return context;
  };
}

export function get(path: string) {
  return createRouteHandler(path, 'GET');
}

export function post(path: string) {
  return createRouteHandler(path, 'POST');
}

export function put(path: string) {
  return createRouteHandler(path, 'PUT');
}

export function patch(path: string) {
  return createRouteHandler(path, 'PATCH');
}

export function routeDelete(path: string) {
  return createRouteHandler(path, 'DELETE');
}

export function all(path: string) {
  return createRouteHandler(path, 'ALL');
}

export function notFound(context: Context) {
  if (context.request.matchedRoutePath) {
    return stopPropagationWith(context);
  }

  context.response.statusCode = 404;

  return context;
}

export function oza() {
  return {
    createWebServer,
    get,
    post,
    put,
    patch,
    routeDelete,
    all,
    notFound,
    validate,
    captureError,
    compress,
    setCache,
    setInfiniteCache,
  };
}
