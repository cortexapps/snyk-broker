import { IncomingMessage } from 'http';
import {
  loadSessionRoutingConfig,
  ownerOfSessionId,
  peerFor,
  prefixSessionId,
} from '../../lib/server/sessionRouting';

const routing = loadSessionRoutingConfig({
  brokerSessionRouting: 'true',
  brokerSessionNodeId: 'snyk-broker-sts-0',
  brokerSessionPeerUrlTemplate: 'http://{node}.snyk-broker-headless:8080',
})!;

const request = (url: string, headers: Record<string, string> = {}) =>
  ({ url, headers } as unknown as IncomingMessage);

const pollUrl = (sid?: string) =>
  `/primus/token/?EIO=4&transport=polling${sid ? `&sid=${sid}` : ''}`;

describe('session routing', () => {
  it('is disabled unless explicitly enabled', () => {
    expect(
      loadSessionRoutingConfig({
        brokerSessionNodeId: 'snyk-broker-sts-0',
        brokerSessionPeerUrlTemplate: 'http://{node}:8080',
      }),
    ).toBeNull();
  });

  it('is disabled without a peer URL template', () => {
    expect(
      loadSessionRoutingConfig({
        brokerSessionRouting: 'true',
        brokerSessionNodeId: 'snyk-broker-sts-0',
      }),
    ).toBeNull();
  });

  it('prefixes session ids with the owning node', () => {
    const sid = prefixSessionId('snyk-broker-sts-3', 'abc_-123');
    expect(ownerOfSessionId(sid)).toEqual('snyk-broker-sts-3');
  });

  it('handles a handshake locally', () => {
    expect(peerFor(routing, request(pollUrl()))).toBeNull();
  });

  it('handles its own sessions locally', () => {
    expect(
      peerFor(routing, request(pollUrl('snyk-broker-sts-0~abc'))),
    ).toBeNull();
  });

  it('handles session ids without a node prefix locally', () => {
    expect(peerFor(routing, request(pollUrl('abc')))).toBeNull();
  });

  it('relays another node’s session to that node', () => {
    expect(
      peerFor(routing, request(pollUrl('snyk-broker-sts-2~abc')))?.toString(),
    ).toEqual('http://snyk-broker-sts-2.snyk-broker-headless:8080/');
  });

  it('relays websocket upgrades the same way', () => {
    const url =
      '/primus/token/?EIO=4&transport=websocket&sid=snyk-broker-sts-1~x';
    expect(peerFor(routing, request(url))?.hostname).toEqual(
      'snyk-broker-sts-1.snyk-broker-headless',
    );
  });

  it('never relays to a node outside the peer pattern', () => {
    for (const owner of [
      'evil.example.com',
      'snyk-broker-sts-1.evil.example.com',
      'snyk-broker-latest-0',
      'other-sts-1',
    ]) {
      expect(peerFor(routing, request(pollUrl(`${owner}~abc`)))).toBeNull();
    }
  });

  it('does not relay a request a peer already relayed', () => {
    expect(
      peerFor(
        routing,
        request(pollUrl('snyk-broker-sts-2~abc'), {
          'x-broker-session-forwarded-by': 'snyk-broker-sts-1',
        }),
      ),
    ).toBeNull();
  });
});
