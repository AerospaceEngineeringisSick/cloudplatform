import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

let jail, paths, browser, totp, passwords, dockerClient;

before(async () => {
  jail = await mkdtemp(join(tmpdir(), 'cloudjail-'));
  await mkdir(join(jail, 'mount', 'sub'), { recursive: true });
  await mkdir(join(jail, 'mount', '....', '....'), { recursive: true });
  await mkdir(join(jail, 'secret'), { recursive: true });
  await writeFile(join(jail, 'secret', 'passwords.txt'), 'TOP SECRET');
  await writeFile(join(jail, 'mount', 'sub', 'file.txt'), 'ok');
  await symlink(join(jail, 'secret'), join(jail, 'mount', 'escape-link'));
  await symlink('/etc/passwd', join(jail, 'mount', 'passwd-link'));
  await symlink('/nonexistent-target', join(jail, 'mount', 'dangling-link'));

  process.env.MOUNTS = `test:Test:${jail}/mount:nvme`;
  process.env.DATA_DIR = join(jail, 'data');

  paths = await import('../dist/storage/paths.js');
  browser = await import('../dist/storage/browser.js');
  totp = await import('../dist/auth/totp.js');
  passwords = await import('../dist/auth/passwords.js');
  dockerClient = await import('../dist/docker/client.js');
});

describe('storage path jail', () => {
  const root = () => resolve(jail, 'mount');

  // The security property is containment: whether a path throws or resolves,
  // it must never end up outside the mount root.
  const contained = (abs) => abs === root() || abs.startsWith(root() + sep);

  const attacks = [
    '../secret/passwords.txt',
    '../../etc/passwd',
    'sub/../../secret/passwords.txt',
    './../../secret',
    'escape-link/passwords.txt',
    'escape-link',
    'passwd-link',
    'sub/./../../secret',
    '../'.repeat(40) + 'etc/passwd',
    'sub/../sub/../../secret',
  ];

  for (const attack of attacks) {
    test(`never escapes via ${JSON.stringify(attack)}`, async () => {
      try {
        const r = await paths.resolveReal('test', attack);
        assert.ok(contained(r.absolute), `escaped the jail: ${r.absolute}`);
      } catch (err) {
        assert.equal(err.status, 403, `expected 403, got ${err.status}: ${err.message}`);
      }
    });
  }

  test('a literal "...." directory stays inside and is not treated as traversal', async () => {
    const r = await paths.resolveReal('test', '..../....');
    assert.ok(contained(r.absolute));
    assert.equal(r.relative, '..../....');
  });

  test('rejects absolute paths', () => {
    assert.throws(() => paths.resolveLexical('test', '/etc/passwd'), /relative/i);
  });

  test('rejects null bytes', () => {
    assert.throws(() => paths.resolveLexical('test', 'a\0b'), /null byte/i);
  });

  test('rejects unknown mounts', () => {
    assert.throws(() => paths.resolveLexical('nope', 'x'), /Unknown storage mount/);
  });

  test('resolves legitimate paths', async () => {
    const r = await paths.resolveReal('test', 'sub/file.txt');
    assert.equal(r.relative, 'sub/file.txt');
    assert.ok(contained(r.absolute));
  });

  test('refuses to delete a mount root', async () => {
    await assert.rejects(() => browser.deleteEntry('test', ''), /storage root/i);
  });

  test('listing tolerates dangling and escaping symlinks', async () => {
    const listing = await browser.listDirectory('test', '');
    const names = listing.entries.map((e) => e.name);
    assert.ok(names.includes('sub'));
    assert.ok(names.includes('dangling-link'));
    assert.equal(listing.parent, null);
  });

  test('rejects names containing slashes', () => {
    assert.throws(() => paths.assertSafeName('a/b'), /slashes/);
    assert.throws(() => paths.assertSafeName('..'), /Invalid name/);
  });
});

describe('TOTP (RFC 6238)', () => {
  const secret = () => totp.base32Encode(Buffer.from('12345678901234567890', 'ascii'));

  const vectors = [
    [59, '287082'], [1111111109, '081804'], [1111111111, '050471'],
    [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130'],
  ];

  for (const [t, expected] of vectors) {
    test(`vector at t=${t}`, () => {
      assert.equal(totp.generateCode(secret(), t * 1000), expected);
    });
  }

  test('base32 round-trips', () => {
    const buf = Buffer.from('hello world!', 'utf8');
    assert.equal(totp.base32Decode(totp.base32Encode(buf)).toString('utf8'), 'hello world!');
  });

  test('accepts a current code and rejects its replay', () => {
    const at = 1700000000000;
    const code = totp.generateCode(secret(), at);
    const first = totp.verifyCode(secret(), code, 0, at);
    assert.equal(first.valid, true);
    const replay = totp.verifyCode(secret(), code, first.step, at);
    assert.equal(replay.valid, false, 'a consumed step must not verify again');
  });

  test('tolerates one step of clock drift but not three', () => {
    const at = 1700000000000;
    assert.equal(totp.verifyCode(secret(), totp.generateCode(secret(), at - 30_000), 0, at).valid, true);
    assert.equal(totp.verifyCode(secret(), totp.generateCode(secret(), at - 90_000), 0, at).valid, false);
  });

  test('rejects malformed input', () => {
    for (const bad of ['abcdef', '', '12345', '1234567', 'こんにちは']) {
      assert.equal(totp.verifyCode(secret(), bad, 0).valid, false);
    }
  });
});

describe('password policy', () => {
  test('rejects short passwords', () => {
    assert.equal(passwords.checkPasswordPolicy('short').ok, false);
  });
  test('rejects common passwords', () => {
    assert.equal(passwords.checkPasswordPolicy('password123').ok, false);
  });
  test('rejects a single repeated character', () => {
    assert.equal(passwords.checkPasswordPolicy('aaaaaaaaaaaaaaa').ok, false);
  });
  test('accepts a reasonable passphrase', () => {
    assert.equal(passwords.checkPasswordPolicy('correct horse battery staple').ok, true);
  });
  test('argon2id hashes verify and reject wrong passwords', async () => {
    const hash = await passwords.hashPassword('correct horse battery staple');
    assert.ok(hash.startsWith('$argon2id$'));
    assert.equal(await passwords.verifyPassword(hash, 'correct horse battery staple'), true);
    assert.equal(await passwords.verifyPassword(hash, 'wrong'), false);
  });
  test('a malformed hash reads as a failed login, not a crash', async () => {
    assert.equal(await passwords.verifyPassword('not-a-hash', 'anything'), false);
  });
  test('recovery codes are unique and hash stably', () => {
    const codes = passwords.generateRecoveryCodes(10);
    assert.equal(new Set(codes).size, 10);
    assert.equal(
      passwords.hashRecoveryCode(codes[0]),
      passwords.hashRecoveryCode(codes[0].toLowerCase()),
      'hashing must ignore case and dashes',
    );
  });
});

describe('docker helpers', () => {
  test('converts cores to CPU quota', () => {
    assert.equal(dockerClient.cpusToQuota(3.25), 325000);
    assert.equal(dockerClient.quotaToCpus(325000, 100000), 3.25);
    assert.equal(dockerClient.quotaToCpus(0, 100000), null);
  });

  test('redacts secrets from container environment', () => {
    assert.equal(dockerClient.redactEnv('MC_RCON_PASSWORD=hunter2'), 'MC_RCON_PASSWORD=••••••••');
    assert.equal(dockerClient.redactEnv('API_KEY=abc'), 'API_KEY=••••••••');
    assert.equal(dockerClient.redactEnv('JELLYFIN_URL=http://x'), 'JELLYFIN_URL=http://x');
    assert.equal(dockerClient.redactEnv('NOEQUALS'), 'NOEQUALS');
  });

  test('demultiplexes framed docker logs', () => {
    const frame = (text) => {
      const payload = Buffer.from(text, 'utf8');
      const header = Buffer.alloc(8);
      header[0] = 1;
      header.writeUInt32BE(payload.length, 4);
      return Buffer.concat([header, payload]);
    };
    const buf = Buffer.concat([frame('hello\n'), frame('world\n')]);
    assert.equal(dockerClient.demultiplex(buf), 'hello\nworld\n');
  });

  test('passes through unframed TTY logs', () => {
    assert.equal(dockerClient.demultiplex(Buffer.from('plain text output', 'utf8')), 'plain text output');
  });
});
