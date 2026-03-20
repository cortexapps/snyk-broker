import { overloadHttpRequestWithConnectionDetailsMiddleware } from '../../lib/server/routesHandlers/httpRequestHandler';
import { connectionStatusHandler } from '../../lib/server/routesHandlers/connectionStatusHandler';
import express from 'express';
import request from 'supertest';

const TOKEN = '7fe7a57b-aa0d-416a-97fc-472061737e24';
const CLIENT_A = { id: 'client-a', socketMarker: 'socket-a' };
const CLIENT_B = { id: 'client-b', socketMarker: 'socket-b' };

jest.mock('../../lib/server/socket', () => {
  const originalModule = jest.requireActual('../../lib/server/socket');

  return {
    __esModule: true,
    ...originalModule,
    getSocketConnections: () => {
      const map = new Map();

      map.set(TOKEN, [
        {
          socket: { marker: CLIENT_A.socketMarker },
          socketVersion: '1',
          metadata: {
            clientId: CLIENT_A.id,
            version: '1.0.0',
            filters: { github: {} },
            capabilities: ['post-streams'],
          },
        },
        {
          socket: { marker: CLIENT_B.socketMarker },
          socketVersion: '1',
          metadata: {
            clientId: CLIENT_B.id,
            version: '1.0.1',
            filters: { gitlab: {} },
            capabilities: ['post-streams'],
          },
        },
      ]);
      return map;
    },
  };
});

jest.mock('node:os', () => {
  const originalModule = jest.requireActual('node:os');

  return {
    __esModule: true,
    ...originalModule,
    hostname: () => 'broker-server-0-0',
  };
});

describe('client routing via x-broker-client-id header', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    // Expose selected socket marker so we can assert which client was picked
    app.all(
      '/broker/:token/*',
      overloadHttpRequestWithConnectionDetailsMiddleware,
      (_req, res) => {
        res.json({ marker: res.locals.websocket.marker });
      },
    );
  });

  it('routes to the first client when no header is provided', async () => {
    const response = await request(app).get(`/broker/${TOKEN}/path`);

    expect(response.status).toEqual(200);
    expect(response.body.marker).toEqual(CLIENT_A.socketMarker);
  });

  it('routes to a specific client when x-broker-client-id is set', async () => {
    const response = await request(app)
      .get(`/broker/${TOKEN}/path`)
      .set('x-broker-client-id', CLIENT_B.id);

    expect(response.status).toEqual(200);
    expect(response.body.marker).toEqual(CLIENT_B.socketMarker);
  });

  it('returns 404 when x-broker-client-id does not match any client', async () => {
    const response = await request(app)
      .get(`/broker/${TOKEN}/path`)
      .set('x-broker-client-id', 'nonexistent-client');

    expect(response.status).toEqual(404);
    expect(response.body).toEqual({ ok: false });
  });
});

describe('connection-status returns clientId', () => {
  it('includes clientId for each connected client', async () => {
    const app = express();
    app.all('/connection-status/:token', connectionStatusHandler);

    const response = await request(app).get(`/connection-status/${TOKEN}`);

    expect(response.status).toEqual(200);
    expect(response.body).toEqual({
      ok: true,
      clients: [
        {
          version: '1.0.0',
          filters: { github: {} },
          clientId: CLIENT_A.id,
        },
        {
          version: '1.0.1',
          filters: { gitlab: {} },
          clientId: CLIENT_B.id,
        },
      ],
    });
  });
});
