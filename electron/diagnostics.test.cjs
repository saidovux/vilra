const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_REPORT_BYTES,
  createGalleryDiagnostics,
} = require('./diagnostics.cjs');

function withDiagnostics(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vilra-diagnostics-'));
  try {
    return run(createGalleryDiagnostics({diagnosticsDirectory: directory}), directory);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

function report(state, overrides = {}) {
  return JSON.stringify({
    schema_version: 1,
    description: 'private-safe fixture',
    session: {
      state,
      started_at_utc: '2026-10-03T12:00:00.000Z',
      duration_ms: 12000,
      runtime: 'Electron/Chromium',
    },
    depth: {loaded_metadata_count: 144, maximum_visible_index: 95},
    pagination: {
      requests_by_kind: {refresh: 1, cursor: 2},
      end_to_end: {p95_ms_approx: 50},
      server_timing_api_images: {p95_ms_approx: 12},
      stages: {
        mapped: {p95_ms_approx: 2},
        deduped: {p95_ms_approx: 4},
        arrays: {p95_ms_approx: 8},
      },
    },
    thumbnails: {
      primary_request_started: 96,
      fallback_attempts: 10,
      first_visible_entries: 96,
      not_ready_on_first_visibility: 12,
      fallback_http_202: 5,
      mount_lifecycles_with_202: 2,
      terminal_error_placeholders: 1,
      fallback_image_decode_errors: 1,
      unmounted_before_load: 3,
      terminal_error_reasons: {fallback_decode_error: 1},
    },
    queue_sampling: {latest_snapshot: {thumbQueueDepth: 7, thumbRunning: 3}},
    frame_intervals: {intervals_over_50_ms: 4, distribution: {p95_ms_approx: 67}},
    rendering: {update_virtual_gallery_count: {p95_ms_approx: 2}},
    manual_slowdown_markers: [{relativeTimeMs: 5000}],
    intervals: [{thumb_queue_snapshot: {thumbQueueDepth: 9}}],
    ...overrides,
  });
}

test('checkpoint and final reports are atomic, valid, and discoverable', () => {
  withDiagnostics((diagnostics, directory) => {
    const session = diagnostics.begin();
    assert.equal(session.diagnostics_dir, directory);
    assert.match(session.session_id, /^[0-9-]+$/);

    const checkpoint = diagnostics.checkpoint(session.session_id, report('recording'));
    assert.equal(fs.existsSync(checkpoint.checkpoint_path), true);
    diagnostics.checkpoint(session.session_id, report('recording', {description: 'updated'}));

    const final = diagnostics.finalize(session.session_id, report('stopped'));
    assert.equal(fs.existsSync(final.json_path), true);
    assert.equal(fs.existsSync(final.markdown_path), true);
    assert.equal(fs.existsSync(checkpoint.checkpoint_path), false);
    assert.equal(JSON.parse(fs.readFileSync(final.json_path, 'utf8')).session.state, 'stopped');
    const markdown = fs.readFileSync(final.markdown_path, 'utf8');
    assert.match(markdown, /Runtime: `Electron\/Chromium`/);
    assert.match(markdown, /Terminal error placeholders: `1`/);
    assert.match(markdown, /Maximum sampled thumbnail queue depth: `9`/);

    const status = diagnostics.status();
    assert.equal(status.checkpoints, 0);
    assert.equal(status.latest_json, final.json_path);
    assert.equal(status.latest_markdown, final.markdown_path);
    assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')), []);
  });
});

test('invalid and private reports do not replace a valid checkpoint', () => {
  withDiagnostics(diagnostics => {
    const session = diagnostics.begin();
    const initial = report('recording');
    const checkpoint = diagnostics.checkpoint(session.session_id, initial);

    for (const forbidden of [
      'path',
      'root_path',
      'absolute_path',
      'file_name',
      'filename',
      'image_id',
      'request_url',
      'url',
      'tags',
      'sqlite_rows',
    ]) {
      assert.throws(
        () => diagnostics.checkpoint(
          session.session_id,
          report('recording', {[forbidden]: 'private-value'}),
        ),
        /forbidden diagnostic field/,
      );
    }
    assert.throws(
      () => diagnostics.checkpoint(session.session_id, '{"schema_version":1}'),
      /missing session/,
    );
    assert.equal(fs.readFileSync(checkpoint.checkpoint_path, 'utf8'), initial);
  });
});

test('sessions are unique and different final files are never overwritten', () => {
  withDiagnostics(diagnostics => {
    const first = diagnostics.begin();
    const second = diagnostics.begin();
    assert.notEqual(first.session_id, second.session_id);

    const initial = report('stopped');
    const final = diagnostics.finalize(first.session_id, initial);
    diagnostics.finalize(second.session_id, initial);
    const different = report('stopped', {depth: {loaded_metadata_count: 2, maximum_visible_index: 1}});
    assert.throws(
      () => diagnostics.finalize(first.session_id, different),
      /diagnostic file already exists/,
    );
    assert.equal(fs.readFileSync(final.json_path, 'utf8'), initial);

    const repeated = diagnostics.finalize(first.session_id, initial);
    assert.equal(repeated.json_path, final.json_path);
    assert.equal(repeated.markdown_path, final.markdown_path);

    fs.writeFileSync(final.markdown_path, 'different existing analysis', 'utf8');
    const protectedMarkdown = diagnostics.finalize(first.session_id, initial);
    assert.equal(protectedMarkdown.markdown_path, null);
    assert.match(protectedMarkdown.analysis_error, /diagnostic file already exists/);
    assert.equal(fs.readFileSync(final.markdown_path, 'utf8'), 'different existing analysis');
  });
});

test('invalid session IDs and oversized reports are rejected', () => {
  withDiagnostics(diagnostics => {
    const recording = report('recording');
    for (const sessionId of ['', 'abc', '../123', '1_2', '1'.repeat(81)]) {
      assert.throws(
        () => diagnostics.checkpoint(sessionId, recording),
        /invalid diagnostic session id/,
      );
    }
    const session = diagnostics.begin();
    const oversized = report('recording', {description: 'x'.repeat(MAX_REPORT_BYTES)});
    assert.throws(
      () => diagnostics.checkpoint(session.session_id, oversized),
      /diagnostic report size/,
    );
  });
});

test('absolute paths and URLs are rejected without touching real user storage', () => {
  withDiagnostics(diagnostics => {
    const session = diagnostics.begin();
    for (const value of [
      '/home/user/private.jpg',
      'C:\\Users\\Example\\private.jpg',
      'https://example.test/private.jpg',
      'file:///home/user/private.jpg',
    ]) {
      assert.throws(
        () => diagnostics.checkpoint(session.session_id, report('recording', {description: value})),
        /path or URL/,
      );
    }
  });
});
