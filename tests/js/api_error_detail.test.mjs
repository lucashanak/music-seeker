// What apiJson hands the caller when a handler explains WHY it failed.
// A 503 whose detail is {message, cause} used to reach the UI as "[object Object]",
// and nothing could branch on the cause.
import test from 'node:test';
import assert from 'node:assert';

// store.js reads localStorage at module load — stub the browser before importing it.
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = globalThis;
globalThis.document = { addEventListener() {}, getElementById: () => null, querySelector: () => null };

const { apiJson } = await import('../../static/js/api.js');

function stubFetch(status, body) {
  globalThis.fetch = async () => ({
    ok: false,
    status,
    statusText: 'Service Unavailable',
    headers: { get: () => null },
    json: async () => body,
  });
}

test('an object detail becomes a readable message plus a reason', async () => {
  stubFetch(503, { detail: { message: 'Onkyo TX-NR555 did not answer', cause: 'device' } });
  await assert.rejects(apiJson('/api/dlna/cast'), (e) => {
    assert.equal(e.message, 'Onkyo TX-NR555 did not answer');
    assert.equal(e.reason, 'device');
    assert.equal(e.status, 503);
    return true;
  });
});

test('a plain string detail still comes through unchanged', async () => {
  stubFetch(400, { detail: 'No active cast session' });
  await assert.rejects(apiJson('/x'), (e) => {
    assert.equal(e.message, 'No active cast session');
    assert.equal(e.reason, undefined);
    return true;
  });
});

test('a pydantic validation array still reports its first message', async () => {
  stubFetch(422, { detail: [{ msg: 'field required', loc: ['body', 'name'] }] });
  await assert.rejects(apiJson('/x'), (e) => {
    assert.equal(e.message, 'field required');
    return true;
  });
});
