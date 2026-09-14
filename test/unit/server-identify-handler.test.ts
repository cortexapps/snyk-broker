import { EventEmitter } from 'node:events';

jest.mock('../../lib/server/infra/dispatcher', () => ({
  clientConnected: jest.fn(),
  clientPinged: jest.fn(),
}));

jest.mock('../../lib/server/socketHandlers/initHandlers', () => ({
  getForwardWebSocketRequestHandler: () => () => () => undefined,
}));

jest.mock('../../lib/hybrid-sdk/LegacyStreamResponseHandler', () => ({
  legacyStreamResponseHandler: () => () => undefined,
}));

jest.mock('../../lib/common/utils/metrics', () => ({
  incrementSocketConnectionGauge: jest.fn(),
}));

import { clientPinged } from '../../lib/server/infra/dispatcher';
import {
  handleIdentifyOnSocket,
  initIdentifyHandler,
} from '../../lib/server/socketHandlers/identifyHandler';
import { getSocketConnections } from '../../lib/server/socket';

const token =
  '3c469e9d6c5875d37a43f353d4f88e61fcf812c66eee3457465a40b0da4153e0';
const clientId = '40365f1c-8c8f-45d4-8311-788058652c4d';
const clientVersion = '4.200.0';

const flushSetImmediate = () => new Promise((resolve) => setImmediate(resolve));

// Primus namespaces heartbeat events by direction from each peer's own point of view. A
// server-side spark writes `primus::ping::<time>` and emits `incoming::pong` when the client
// echoes it back, so `incoming::ping` never fires here - it is the client-side event.
describe('server identify handler heartbeat wiring', () => {
  let socket: EventEmitter;

  beforeEach(() => {
    (clientPinged as jest.Mock).mockReset();
    getSocketConnections().clear();
    initIdentifyHandler();

    socket = new EventEmitter();
    const identified = handleIdentifyOnSocket(
      { token, metadata: { clientId, version: clientVersion } },
      socket,
      token,
    );
    expect(identified).toBe(true);
  });

  it('notifies the dispatcher when the client answers the heartbeat', async () => {
    const sentAt = Date.now() - 25;
    socket.emit('incoming::pong', sentAt);
    await flushSetImmediate();

    expect(clientPinged).toHaveBeenCalledTimes(1);
    expect(clientPinged).toHaveBeenCalledWith(
      token,
      clientId,
      clientVersion,
      sentAt,
    );
  });

  it('does not listen for incoming::ping, which a spark never emits', async () => {
    socket.emit('incoming::ping', Date.now());
    await flushSetImmediate();

    expect(clientPinged).not.toHaveBeenCalled();
  });
});
