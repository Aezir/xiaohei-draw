'use strict';

// Local fake upstream only. These tests never contact novelai.net: every
// request passes an explicit url pointing at 127.0.0.1.

const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { after, before, test } = require('node:test');

const { init, info } = require('../index.js');
const manifest = require('../manifest.json');

const VIBE_BYTES = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256));
const SUBSCRIPTION = {
    tier: 3,
    active: true,
    expiresAt: 0,
    perks: { unlimitedMaxPriority: true },
    usage: { percent: 100, isNegative: false, timeUntilNextPercent: 6048 },
};

let server;
let origin;
let requests = [];
const routes = { get: new Map(), post: new Map() };

async function invokeRoute(handler, body) {
    const req = new EventEmitter();
    req.aborted = false;
    req.destroyed = false;
    req.complete = true;
    req.body = body;
    const res = new EventEmitter();
    res.destroyed = false;
    res.writableEnded = false;
    res.status = status => {
        res.statusCode = status;
        return res;
    };
    res.send = responseBody => {
        res.writableEnded = true;
        res.body = responseBody;
        return res;
    };
    await handler(req, res);
    return res;
}

before(async () => {
    server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(Buffer.from(chunk)));
        req.on('end', () => {
            requests.push({
                method: req.method,
                url: req.url,
                authorization: req.headers.authorization || '',
                contentType: req.headers['content-type'] || '',
                body: Buffer.concat(chunks).toString('utf8'),
            });
            if (req.url === '/ai/encode-vibe') {
                res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': VIBE_BYTES.length });
                res.end(VIBE_BYTES);
                return;
            }
            if (req.url === '/no-anlas/ai/encode-vibe') {
                res.writeHead(402, { 'Content-Type': 'text/plain' });
                res.end('Not enough Anlas');
                return;
            }
            if (req.url === '/user/subscription') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(SUBSCRIPTION));
                return;
            }
            if (req.url === '/bad-key/user/subscription') {
                res.writeHead(401, { 'Content-Type': 'text/plain' });
                res.end('Unauthorized');
                return;
            }
            res.writeHead(404);
            res.end();
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    await init({
        get(path, handler) { routes.get.set(path, handler); },
        post(path, handler) { routes.post.set(path, handler); },
        delete() {},
    });
});

after(async () => {
    await new Promise(resolve => server.close(resolve));
});

test('status advertises the renamed plugin, v3.0.0 and the new capabilities', () => {
    assert.equal(info.id, 'xbdraw-image-proxy');
    assert.equal(manifest.id, 'xbdraw-image-proxy');
    assert.equal(manifest.version, '3.0.0');
    let body;
    routes.get.get('/status')({}, { status() { return this; }, send(value) { body = value; return this; } });
    assert.equal(body.id, 'xbdraw-image-proxy');
    assert.equal(body.version, '3.0.0');
    assert.deepEqual(body.capabilities, ['v5-msgpack-stream', 'novelai-encode-vibe-v1', 'novelai-subscription-v1']);
});

test('only the proxy routes are registered (no background task routes)', () => {
    assert.deepEqual([...routes.get.keys()], ['/status']);
    assert.deepEqual([...routes.post.keys()].sort(), [
        '/v1/encode-vibe',
        '/v1/generate-image',
        '/v1/generate-image-stream',
        '/v1/subscription',
        '/v1/test',
        '/v2/generate-image',
        '/v2/test',
    ]);
});

test('encode-vibe forwards a JSON body with Bearer auth and returns base64 bytes', async () => {
    requests = [];
    const res = await invokeRoute(routes.post.get('/v1/encode-vibe'), {
        url: `${origin}/ai/encode-vibe`,
        key: 'vibe-key',
        payload: { image: 'data:image/png;base64,AAAA', information_extracted: 0.456, model: 'nai-diffusion-4-5-full', extra: 'dropped' },
        timeout: 1000,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.bytes, VIBE_BYTES.length);
    assert.deepEqual(Buffer.from(res.body.base64, 'base64'), VIBE_BYTES);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].authorization, 'Bearer vibe-key');
    assert.match(requests[0].contentType, /application\/json/);
    assert.deepEqual(JSON.parse(requests[0].body), {
        image: 'AAAA',
        information_extracted: 0.46,
        model: 'nai-diffusion-4-5-full',
    });
});

test('encode-vibe rejects unsupported models and bad input before any upstream request', async () => {
    requests = [];
    const handler = routes.post.get('/v1/encode-vibe');
    const base = { url: `${origin}/ai/encode-vibe`, key: 'k', timeout: 1000 };
    for (const payload of [
        { image: 'AAAA', information_extracted: 1, model: 'nai-diffusion-5-full' },
        { image: 'AAAA', information_extracted: 1, model: 'nai-diffusion-3' },
        { image: '', information_extracted: 1, model: 'nai-diffusion-4-5-full' },
        { image: 'AAAA', information_extracted: 0, model: 'nai-diffusion-4-5-full' },
        { image: 'AAAA', information_extracted: 1.5, model: 'nai-diffusion-4-5-full' },
    ]) {
        const res = await invokeRoute(handler, { ...base, payload });
        assert.equal(res.statusCode, 400, JSON.stringify(payload));
        assert.equal(res.body.ok, false);
    }
    const noKey = await invokeRoute(handler, { ...base, key: '', payload: { image: 'A', information_extracted: 1, model: 'nai-diffusion-4-full' } });
    assert.equal(noKey.statusCode, 400);
    const badUrl = await invokeRoute(handler, { ...base, url: 'ftp://x', payload: { image: 'A', information_extracted: 1, model: 'nai-diffusion-4-full' } });
    assert.equal(badUrl.statusCode, 400);
    assert.equal(requests.length, 0);
});

test('encode-vibe surfaces upstream billing errors without retrying', async () => {
    requests = [];
    const res = await invokeRoute(routes.post.get('/v1/encode-vibe'), {
        url: `${origin}/no-anlas/ai/encode-vibe`,
        key: 'k',
        payload: { image: 'AAAA', information_extracted: 1, model: 'nai-diffusion-4-5-curated' },
        timeout: 1000,
    });
    assert.equal(res.body.ok, false);
    assert.equal(res.body.status, 402);
    assert.match(res.body.error, /Anlas/);
    assert.equal(requests.length, 1);
});

test('subscription performs a bodiless GET with Bearer auth and passes JSON through', async () => {
    requests = [];
    const res = await invokeRoute(routes.post.get('/v1/subscription'), {
        url: `${origin}/user/subscription`,
        key: 'sub-key',
        timeout: 1000,
    });
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.subscription, SUBSCRIPTION);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].authorization, 'Bearer sub-key');
    assert.equal(requests[0].body, '');
});

test('subscription reports 401 and validates input', async () => {
    requests = [];
    const handler = routes.post.get('/v1/subscription');
    const bad = await invokeRoute(handler, { url: `${origin}/bad-key/user/subscription`, key: 'k', timeout: 1000 });
    assert.equal(bad.body.ok, false);
    assert.equal(bad.body.status, 401);
    const noKey = await invokeRoute(handler, { url: `${origin}/user/subscription`, key: ' ' });
    assert.equal(noKey.statusCode, 400);
    const badUrl = await invokeRoute(handler, { url: 'not a url', key: 'k' });
    assert.equal(badUrl.statusCode, 400);
    assert.equal(requests.length, 1);
});
