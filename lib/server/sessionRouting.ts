import http, { IncomingMessage, ServerResponse } from 'http';
import net, { Socket } from 'net';
import { log as logger } from '../logs/logger';

// Engine.IO keeps a session in the memory of the server that created it, so every
// polling request and the websocket upgrade of that session must reach that server.
// A load balancer cannot guarantee this when a client's requests arrive from several
// source IPs. Session routing prefixes each session id with the id of the node that
// owns it, and a node that receives a request for another node's session relays it
// to the owner.

const SESSION_ID_SEPARATOR = '~';
const FORWARDED_HEADER = 'x-broker-session-forwarded-by';

export interface SessionRoutingConfig {
  nodeId: string;
  peerUrlTemplate: string;
  nodeIdPattern: RegExp;
}

export const loadSessionRoutingConfig = (
  config: Record<string, any>,
): SessionRoutingConfig | null => {
  if (String(config.brokerSessionRouting).toLowerCase() !== 'true') {
    return null;
  }
  const nodeId = config.brokerSessionNodeId || process.env.HOSTNAME;
  const peerUrlTemplate = config.brokerSessionPeerUrlTemplate;
  if (!nodeId || !peerUrlTemplate || !peerUrlTemplate.includes('{node}')) {
    logger.error(
      { nodeId, peerUrlTemplate },
      'Session routing needs a node id and a peer URL template containing {node}; leaving it disabled',
    );
    return null;
  }
  const nodeIdPattern = config.brokerSessionNodeIdPattern
    ? new RegExp(config.brokerSessionNodeIdPattern)
    : defaultNodeIdPattern(nodeId);
  if (!nodeIdPattern.test(nodeId)) {
    logger.error(
      { nodeId, nodeIdPattern: nodeIdPattern.source },
      'Session routing node id does not match the peer node id pattern; leaving it disabled',
    );
    return null;
  }
  return { nodeId, peerUrlTemplate, nodeIdPattern };
};

// A StatefulSet pod is named <set>-<ordinal>, so peers share everything before the ordinal.
const defaultNodeIdPattern = (nodeId: string): RegExp => {
  const match = /^(.*)-\d+$/.exec(nodeId);
  const escaped = (match ? match[1] : nodeId).replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  );
  return match ? new RegExp(`^${escaped}-\\d+$`) : new RegExp(`^${escaped}$`);
};

export const prefixSessionId = (nodeId: string, id: string): string =>
  `${nodeId}${SESSION_ID_SEPARATOR}${id}`;

export const ownerOfSessionId = (sid: string | null): string | null => {
  if (!sid) return null;
  const index = sid.indexOf(SESSION_ID_SEPARATOR);
  return index > 0 ? sid.substring(0, index) : null;
};

const sessionIdOf = (req: IncomingMessage): string | null => {
  try {
    return new URL(req.url || '', 'http://broker').searchParams.get('sid');
  } catch {
    return null;
  }
};

/**
 * Returns the peer that owns the session of this request, or null when this node
 * should handle it: no session yet (a handshake), a session of this node, a session
 * id without a node prefix, an owner outside the peer pattern, or a request a peer
 * already relayed.
 */
export const peerFor = (
  routing: SessionRoutingConfig,
  req: IncomingMessage,
): URL | null => {
  if (req.headers[FORWARDED_HEADER]) return null;
  const owner = ownerOfSessionId(sessionIdOf(req));
  if (!owner || owner === routing.nodeId) return null;
  if (!routing.nodeIdPattern.test(owner)) return null;
  return new URL(routing.peerUrlTemplate.replace('{node}', owner));
};

// Primus stores the request object under a pseudo-header, which is not a valid header to send.
const relayableHeaders = (req: IncomingMessage) => {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.includes('::')) continue;
    if (typeof value !== 'string' && !Array.isArray(value)) continue;
    headers[name] = value;
  }
  return headers;
};

const unknownSession = (res: ServerResponse) => {
  if (res.headersSent) return res.destroy();
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 1, message: 'Session ID unknown' }));
};

export const relayRequest = (
  routing: SessionRoutingConfig,
  peer: URL,
  req: IncomingMessage,
  res: ServerResponse,
) => {
  const upstream = http.request(
    {
      host: peer.hostname,
      port: peer.port,
      method: req.method,
      path: req.url,
      headers: { ...relayableHeaders(req), [FORWARDED_HEADER]: routing.nodeId },
    },
    (peerRes) => {
      res.writeHead(peerRes.statusCode || 502, peerRes.headers);
      peerRes.pipe(res);
    },
  );
  upstream.on('error', (error) => {
    logger.warn(
      { peer: peer.host, error: error.message },
      'Unable to relay a session request to its owner',
    );
    unknownSession(res);
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
};

export const relayUpgrade = (
  routing: SessionRoutingConfig,
  peer: URL,
  req: IncomingMessage,
  socket: Socket,
) => {
  const upstream = net.connect(Number(peer.port) || 80, peer.hostname, () => {
    let head = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      head += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    head += `${FORWARDED_HEADER}: ${routing.nodeId}\r\n\r\n`;
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', (error) => {
    logger.warn(
      { peer: peer.host, error: error.message },
      'Unable to relay a session upgrade to its owner',
    );
    socket.destroy();
  });
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
};

/**
 * Primus middleware that relays requests for another node's session to that node.
 * Primus runs it for polling requests (res is a ServerResponse) and websocket
 * upgrades (res is the raw socket); returning true stops Primus handling the request.
 */
export const sessionRoutingMiddleware = (routing: SessionRoutingConfig) =>
  function routeToSessionOwner(req: IncomingMessage, res: any): boolean {
    const peer = peerFor(routing, req);
    if (!peer) return false;
    logger.debug(
      { peer: peer.host, upgrade: !(res instanceof ServerResponse) },
      'Relaying a session request to its owner',
    );
    try {
      if (res instanceof ServerResponse) {
        relayRequest(routing, peer, req, res);
      } else {
        relayUpgrade(routing, peer, req, res as Socket);
      }
    } catch (error) {
      logger.error(
        { peer: peer.host, error: (error as Error).message },
        'Failed to relay a session request to its owner',
      );
      if (res instanceof ServerResponse) unknownSession(res);
      else (res as Socket).destroy();
    }
    return true;
  };
