import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, sha } from './lib/shell-test-fixture.mjs';

test('publishes both SHA images before promoting main latest', t => {
    const result = fixture(t).run('publish-images.sh');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.calls, new RegExp(`push ghcr.io/sjkd23/console-bot:${sha}`));
    assert.match(result.calls, new RegExp(`push ghcr.io/sjkd23/console-backend:${sha}`));
    assert.ok(result.calls.lastIndexOf('docker push') < result.calls.indexOf('buildx imagetools create'));
    assert.doesNotMatch(result.calls, /compose|ssh/);
});
test('an existing SHA is never overwritten on reruns', t => {
    const result = fixture(t).run('publish-images.sh', { MOCK_SHA_EXISTS: 'true' });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.calls, /docker tag|docker push/);
});
test('branch dispatch publishes SHA only', t => {
    const result = fixture(t).run('publish-images.sh', { CONSOLE_REF: 'refs/heads/feature' });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.calls, /:latest/);
});
test('registry authentication failure prevents pushes', t => {
    const result = fixture(t).run('publish-images.sh', { MOCK_REGISTRY_FAIL: 'true' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.calls, /docker push|imagetools create/);
});
test('old successful main runs cannot move latest backwards', t => {
    const result = fixture(t).run('publish-images.sh', { MOCK_LATEST_EXISTS: 'true', MOCK_ANCESTRY: 'behind' });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.calls, /imagetools create/);
});
test('a new successful main build promotes latest', t => {
    const result = fixture(t).run('publish-images.sh', { MOCK_LATEST_EXISTS: 'true', MOCK_ANCESTRY: 'ahead' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.calls, /imagetools create.*:latest/);
});
test('divergent main history requires investigation', t => {
    const result = fixture(t).run('publish-images.sh', { MOCK_LATEST_EXISTS: 'true', MOCK_ANCESTRY: 'diverged' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.calls, /imagetools create/);
});
test('organization forks use organization package API paths', t => {
    const result = fixture(t).run('publish-images.sh', { MOCK_OWNER_TYPE: 'Organization' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.calls, /gh api orgs\/sjkd23\/packages\/container\/console-bot\/versions/);
});
