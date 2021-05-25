import type hapi from '@hapi/hapi';
import { parseAll } from '@hapi/accept';

export { GraphQLOptions } from 'apollo-server-core';
import {
  ApolloServerBase,
  convertNodeHttpToRequest,
  GraphQLOptions,
  HttpQueryError,
  runHttpQuery,
} from 'apollo-server-core';
import Boom from '@hapi/boom';

export class ApolloServer extends ApolloServerBase {
  // This translates the arguments from the middleware into graphQL options It
  // provides typings for the integration specific behavior, ideally this would
  // be propagated with a generic to the super class
  async createGraphQLServerOptions(
    request: hapi.Request,
    h: hapi.ResponseToolkit,
  ): Promise<GraphQLOptions> {
    return super.graphQLServerOptions({ request, h });
  }

  public async applyMiddleware({
    app,
    cors,
    path,
    route,
    disableHealthCheck,
    onHealthCheck,
  }: ServerRegistration) {
    this.assertStarted('applyMiddleware');

    if (!path) path = '/graphql';

    const frontendPage = this.getFrontendPage();

    if (frontendPage) {
      app.ext({
        type: 'onRequest',
        method: async (request, h) => {
          // Note that this path check is stricter than other integrations,
          // which return frontend for arbitrary URLs under the given path.
          if (request.path !== path && request.path !== `${path}/`) {
            return h.continue;
          }

          if (request.method === 'get') {
            // perform more expensive content-type check only if necessary
            const accept = parseAll(request.headers);
            const types = accept.mediaTypes as string[];
            const prefersHtml =
              types.find(
                (x: string) => x === 'text/html' || x === 'application/json',
              ) === 'text/html';

            if (prefersHtml) {
              return h.response(frontendPage.html).type('text/html').takeover();
            }
          }
          return h.continue;
        },
      });
    }

    if (!disableHealthCheck) {
      app.route({
        method: '*',
        path: '/.well-known/apollo/server-health',
        options: {
          cors: cors !== undefined ? cors : true,
        },
        handler: async function (request, h) {
          if (onHealthCheck) {
            try {
              await onHealthCheck(request);
            } catch {
              const response = h.response({ status: 'fail' });
              response.code(503);
              response.type('application/health+json');
              return response;
            }
          }
          const response = h.response({ status: 'pass' });
          response.type('application/health+json');
          return response;
        },
      });
    }

    app.route({
      method: ['GET', 'POST'],
      path,
      options: route ?? {
        cors: cors ?? true,
      },
      handler: async (request, h) => {
        try {
          const { graphqlResponse, responseInit } = await runHttpQuery(
            [request, h],
            {
              method: request.method.toUpperCase(),
              options: () => this.createGraphQLServerOptions(request, h),
              query:
                request.method === 'post'
                  ? // TODO type payload as string or Record
                    (request.payload as any)
                  : request.query,
              request: convertNodeHttpToRequest(request.raw.req),
            },
          );

          const response = h.response(graphqlResponse);
          if (responseInit.headers) {
            Object.entries(
              responseInit.headers,
            ).forEach(([headerName, value]) =>
              response.header(headerName, value),
            );
          }
          return response;
        } catch (e: unknown) {
          const error = e as HttpQueryError;
          if ('HttpQueryError' !== error.name) {
            throw Boom.boomify(error);
          }

          if (true === error.isGraphQLError) {
            const response = h.response(error.message);
            response.code(error.statusCode);
            response.type('application/json');
            return response;
          }

          const err = new Boom.Boom(error.message, {
            statusCode: error.statusCode,
          });
          if (error.headers) {
            Object.entries(error.headers).forEach(([headerName, value]) => {
              err.output.headers[headerName] = value;
            });
          }
          // Boom hides the error when status code is 500
          err.output.payload.message = error.message;
          throw err;
        }
      },
    });

    this.graphqlPath = path;
  }
}

export interface ServerRegistration {
  app: hapi.Server;
  path?: string;
  cors?: boolean | hapi.RouteOptionsCors;
  route?: hapi.RouteOptions;
  onHealthCheck?: (request: hapi.Request) => Promise<any>;
  disableHealthCheck?: boolean;
}
