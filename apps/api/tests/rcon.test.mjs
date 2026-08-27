import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

const { rcon, parsePlayerList, parseTps, parseMspt, stripColorCodes } =
  await import('../dist/services/rcon.js');

const TYPE_AUTH = 3, TYPE_AUTH_RESPONSE = 2, TYPE_COMMAND = 2, TYPE_RESPONSE = 0;

function encode(id, type, body) {
  const payload = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  return buf;
}

/** A mock Source-RCON server, so the client is tested against the real wire format. */
function mockServer({ password = 'secret', replies = {}, splitPackets = false } = {}) {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const len = buffer.readInt32LE(0);
        if (buffer.length - 4 < len) break;
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.toString('utf8', 12, 4 + len - 2);
        buffer = buffer.subarray(4 + len);

        if (type === TYPE_AUTH) {
          const ok = body === password;
          socket.write(encode(ok ? id : -1, TYPE_AUTH_RESPONSE, ''));
        } else if (type === TYPE_COMMAND) {
          const reply = replies[body] ?? `unknown command: ${body}`;
          const packet = encode(id, TYPE_RESPONSE, reply);
          if (splitPackets) {
            // Prove the client reassembles a packet split across TCP reads.
            socket.write(packet.subarray(0, 6));
            setTimeout(() => socket.write(packet.subarray(6)), 15);
          } else {
            socket.write(packet);
          }
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

describe('RCON client', () => {
  let ctx;
  before(async () => {
    ctx = await mockServer({
      replies: {
        list: 'There are 2 of a max of 12 players online: Luke, Ralph',
        tps: 'TPS from last 1m, 5m, 15m: 19.98, 20.0, 20.0',
        mspt: 'Server tick times (avg/min/max) from last 5s, 10s, 1m: 14.2, 13.9, 14.0',
      },
    });
  });
  after(() => ctx.server.close());

  test('authenticates and runs a single command', async () => {
    const [reply] = await rcon(
      { host: '127.0.0.1', port: ctx.port, password: 'secret' },
      ['list'],
    );
    assert.match(reply, /Luke, Ralph/);
  });

  test('runs several commands in order', async () => {
    const replies = await rcon(
      { host: '127.0.0.1', port: ctx.port, password: 'secret' },
      ['list', 'tps', 'mspt'],
    );
    assert.equal(replies.length, 3);
    assert.match(replies[0], /players online/);
    assert.match(replies[1], /TPS/);
    assert.match(replies[2], /tick times/);
  });

  test('rejects a wrong password with 401', async () => {
    await assert.rejects(
      () => rcon({ host: '127.0.0.1', port: ctx.port, password: 'wrong' }, ['list']),
      (err) => err.status === 401 && /rejected/i.test(err.message),
    );
  });

  test('reports an unreachable server rather than hanging', async () => {
    await assert.rejects(
      () => rcon({ host: '127.0.0.1', port: 1, password: 'secret', timeoutMs: 2000 }, ['list']),
      (err) => err.status === 502 || err.status === 504,
    );
  });

  test('reassembles a reply split across TCP reads', async () => {
    const split = await mockServer({ splitPackets: true, replies: { list: 'There are 1 of a max of 8 players online: Ralph' } });
    try {
      const [reply] = await rcon({ host: '127.0.0.1', port: split.port, password: 'secret' }, ['list']);
      assert.match(reply, /Ralph/);
    } finally {
      split.server.close();
    }
  });
});

describe('RCON reply parsing', () => {
  test('parses a populated player list', () => {
    const r = parsePlayerList('There are 2 of a max of 12 players online: Luke, Ralph');
    assert.equal(r.online, 2);
    assert.equal(r.max, 12);
    assert.deepEqual(r.names, ['Luke', 'Ralph']);
  });

  test('parses an empty server', () => {
    const r = parsePlayerList('There are 0 of a max of 12 players online:');
    assert.equal(r.online, 0);
    assert.equal(r.max, 12);
    assert.deepEqual(r.names, []);
  });

  test('survives an unexpected format', () => {
    const r = parsePlayerList('something else entirely');
    assert.equal(r.online, 0);
    assert.deepEqual(r.names, []);
  });

  test('parses Paper TPS and rejects nonsense', () => {
    assert.equal(parseTps('TPS from last 1m, 5m, 15m: 19.98, 20.0, 20.0'), 19.98);
    assert.equal(parseTps('Unknown command'), null);
    assert.equal(parseTps('TPS: 999'), null);
  });

  test('parses MSPT', () => {
    assert.equal(parseMspt('Server tick times (avg/min/max) from last 5s, 10s, 1m: 14.2, 13.9, 14.0'), 14.2);
    assert.equal(parseMspt('Server tick times (avg/min/max) 14.2'), 14.2);
  });

  test('strips colour codes', () => {
    assert.equal(stripColorCodes('§aGreen §cRed'), 'Green Red');
  });
});
