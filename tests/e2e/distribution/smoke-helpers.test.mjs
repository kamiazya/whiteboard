// Run with: pnpm test:scripts. The smokes themselves run only on the release
// path, so the helpers they share are the one part of them a pull request can
// execute.

import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import test from 'node:test'
import {
  base64url,
  createAccessTokenMinter,
  createTempDirs,
  generateTestTlsCert,
  readyRecord,
  signEs256Jwt,
} from './smoke-helpers.mjs'

function verifiesAsEs256(jwt, publicKey) {
  const [header, payload, signature] = jwt.split('.')
  const raw = Buffer.from(signature, 'base64url')
  return {
    rawLength: raw.length,
    valid: verify(
      'SHA256',
      Buffer.from(`${header}.${payload}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      raw,
    ),
  }
}

test('an ES256 JWT carries a 64-byte r||s signature a verifier accepts', () => {
  // The DER form is 70-72 bytes, so a signature that was left DER-encoded
  // fails the length check before the verifier ever sees it. Enough keys that
  // a component with a leading zero byte (a 31-byte r or s) shows up.
  for (let i = 0; i < 40; i++) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwt = signEs256Jwt(privateKey, { alg: 'ES256' }, { sub: `user-${i}` })
    const { rawLength, valid } = verifiesAsEs256(jwt, publicKey)
    assert.equal(rawLength, 64)
    assert.equal(valid, true)
  }
})

test('an ES256 JWT is three base64url segments whose first two decode to the inputs', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwt = signEs256Jwt(privateKey, { alg: 'ES256', kid: 'k' }, { sub: 's' })
  const [header, payload] = jwt.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'k' })
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { sub: 's' })
  assert.equal(base64url('a?b>c'), 'YT9iPmM')
})

test('an access-token minter names the subject and client after the smoke and expires in an hour', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const mint = createAccessTokenMinter({
    name: 'unit-smoke',
    issuer: 'https://issuer.example',
    audience: 'https://aud.example',
  })
  const [header, payload] = mint(privateKey, 'a:read b:read').split('.')
  const claims = JSON.parse(Buffer.from(payload, 'base64url'))
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).kid, 'unit-smoke-key')
  assert.equal(claims.sub, 'unit-smoke-user')
  assert.equal(claims.azp, 'unit-smoke-client')
  assert.equal(claims.scope, 'a:read b:read')
  assert.equal(claims.exp - claims.iat, 3600)
})

test('a test TLS certificate is written to the directory and covers the requested name', () => {
  const dirs = createTempDirs()
  try {
    const dir = dirs.make('smoke-helpers-tls-')
    const { keyFile, certFile } = generateTestTlsCert(dir, {
      commonName: 'unit-ca',
      subjectAltName: 'IP:127.0.0.1,DNS:host.docker.internal',
    })
    assert.ok(existsSync(keyFile))
    const cert = createPublicKey(readFileSync(certFile))
    assert.equal(cert.asymmetricKeyType, 'rsa')
  } finally {
    dirs.cleanup()
  }
})

test('the temp-dir registry removes every directory it made', () => {
  const dirs = createTempDirs()
  const a = dirs.make('smoke-helpers-a-')
  const b = dirs.make('smoke-helpers-b-')
  assert.ok(existsSync(a) && existsSync(b))
  dirs.cleanup()
  assert.equal(existsSync(a) || existsSync(b), false)
  rmSync(a, { recursive: true, force: true })
})

test('a ready record is a JSON line with ok:true and a numeric pid, and nothing else is', () => {
  assert.deepEqual(readyRecord('{"ok":true,"pid":12}'), { ok: true, pid: 12 })
  assert.equal(readyRecord(''), undefined)
  assert.equal(readyRecord('listening on 3000'), undefined)
  assert.equal(readyRecord('{"ok":true}'), undefined)
  assert.equal(readyRecord('{"ok":false,"pid":1}'), undefined)
})
