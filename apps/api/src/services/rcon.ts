import { Socket } from 'node:net';
import { HttpError } from '../util/index.js';

/**
 * Minimal Source RCON client, which is the protocol Minecraft servers speak.
 *
 * Packet layout (little-endian):
 *   int32 length (of everything after this field)
 *   int32 request id
 *   int32 type
 *   ascii body, null terminated
 *   one trailing null byte
 */

const TYPE_AUTH = 3;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_COMMAND = 2;
const TYPE_RESPONSE = 0;

/** The server answers an auth failure with request id -1. */
const AUTH_FAILED = -1;

export interface RconOptions {
  host: string;
  port: number;
  password: string;
  timeoutMs?: number;
}

function encode(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf8');
  const buffer = Buffer.alloc(14 + payload.length);
  buffer.writeInt32LE(10 + payload.length, 0);
  buffer.writeInt32LE(id, 4);
  buffer.writeInt32LE(type, 8);
  payload.copy(buffer, 12);
  // Two trailing nulls: end of body, end of packet.
  buffer.writeInt16LE(0, 12 + payload.length);
  return buffer;
}

interface Packet {
  id: number;
  type: number;
  body: string;
}

/** Pull every complete packet out of the buffer, returning the leftover bytes. */
function decode(buffer: Buffer): { packets: Packet[]; rest: Buffer<ArrayBufferLike> } {
  const packets: Packet[] = [];
  let offset = 0;

  while (buffer.length - offset >= 4) {
    const length = buffer.readInt32LE(offset);
    // Guard against a hostile or corrupt length field.
    if (length < 10 || length > 4_194_304) {
      throw new HttpError(502, 'rcon_protocol', 'Malformed RCON packet received.');
    }
    if (buffer.length - offset - 4 < length) break;

    const id = buffer.readInt32LE(offset + 4);
    const type = buffer.readInt32LE(offset + 8);
    const body = buffer.toString('utf8', offset + 12, offset + 4 + length - 2);
    packets.push({ id, type, body });
    offset += 4 + length;
  }

  return { packets, rest: buffer.subarray(offset) };
}

/**
 * Opens a connection, authenticates, runs commands in order, then closes.
 * Deliberately per-call rather than pooled: the server is usually off, and a
 * stale pooled socket is worse than a fresh connect.
 */
export async function rcon(
  options: RconOptions,
  commands: string[],
): Promise<string[]> {
  const timeoutMs = options.timeoutMs ?? 5000;

  return new Promise<string[]>((resolve, reject) => {
    const socket = new Socket();
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const responses: string[] = [];
    let authenticated = false;
    let commandIndex = 0;
    let settled = false;

    const finish = (err: Error | null, value?: string[]): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(value ?? []);
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () =>
      finish(new HttpError(504, 'rcon_timeout', 'The Minecraft server did not respond.')),
    );
    socket.on('error', (err) =>
      finish(
        new HttpError(
          502,
          'rcon_unreachable',
          `Could not reach the Minecraft server: ${err.message}`,
        ),
      ),
    );
    socket.on('close', () => {
      if (!settled) {
        finish(
          new HttpError(502, 'rcon_closed', 'The Minecraft server closed the connection.'),
        );
      }
    });

    const sendNextCommand = (): void => {
      if (commandIndex >= commands.length) {
        finish(null, responses);
        return;
      }
      socket.write(encode(commandIndex + 100, TYPE_COMMAND, commands[commandIndex]!));
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let decoded;
      try {
        decoded = decode(buffer);
      } catch (err) {
        finish(err as Error);
        return;
      }
      buffer = decoded.rest;

      for (const packet of decoded.packets) {
        if (!authenticated) {
          if (packet.type !== TYPE_AUTH_RESPONSE) continue;
          if (packet.id === AUTH_FAILED) {
            finish(
              new HttpError(401, 'rcon_auth', 'The RCON password was rejected.'),
            );
            return;
          }
          authenticated = true;
          sendNextCommand();
          continue;
        }

        if (packet.type === TYPE_RESPONSE) {
          responses[commandIndex] = (responses[commandIndex] ?? '') + packet.body;
          commandIndex++;
          sendNextCommand();
        }
      }
    });

    socket.connect(options.port, options.host, () => {
      socket.write(encode(1, TYPE_AUTH, options.password));
    });
  });
}

/* --------------------------------------------------------------- parsing */

/**
 * `list` replies look like:
 *   "There are 2 of a max of 12 players online: Luke, Ralph"
 * Formatting varies between server flavours, so parse defensively.
 */
export function parsePlayerList(text: string): {
  online: number;
  max: number | null;
  names: string[];
} {
  const clean = stripColorCodes(text);
  const counts = clean.match(/(\d+)\s*(?:of a max of|\/)\s*(\d+)/i);
  const online = counts ? Number(counts[1]) : 0;
  const max = counts ? Number(counts[2]) : null;

  const colon = clean.indexOf(':');
  const namePart = colon === -1 ? '' : clean.slice(colon + 1);
  const names = namePart
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0 && n.length < 40);

  return { online, max, names };
}

/**
 * Paper's `tps` reply looks like:
 *   "TPS from last 1m, 5m, 15m: 20.0, 19.98, 20.0"
 * Vanilla has no such command, so a null result is normal.
 */
export function parseTps(text: string): number | null {
  // The label itself contains numbers ("last 1m, 5m, 15m"), so read only the
  // part after the final colon, where the actual values live.
  const value = firstNumberAfterLabel(text);
  if (value === null || value <= 0 || value > 25) return null;
  return Math.round(value * 100) / 100;
}

/** Milliseconds per tick, from Paper's `mspt` command. */
export function parseMspt(text: string): number | null {
  const value = firstNumberAfterLabel(text);
  if (value === null || value < 0 || value > 10_000) return null;
  return Math.round(value * 100) / 100;
}

/**
 * Paper prefixes its numbers with a label that itself contains digits, e.g.
 * "TPS from last 1m, 5m, 15m: 19.98, 20.0, 20.0". Taking the text after the
 * last colon isolates the values; when there is no colon the whole string is
 * searched instead.
 */
function firstNumberAfterLabel(text: string): number | null {
  const clean = stripColorCodes(text);
  const colon = clean.lastIndexOf(':');
  const tail = colon === -1 ? clean : clean.slice(colon + 1);
  const match = tail.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

/** Minecraft embeds section-sign colour codes in console output. */
export function stripColorCodes(text: string): string {
  return text.replace(/§[0-9a-fk-orA-FK-OR]/g, '');
}
