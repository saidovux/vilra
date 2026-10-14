const fs = require('node:fs');
const path = require('node:path');

const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_LISTED_REPORTS = 10;

let uniqueSequence = 1;

function diagnosticError(context, error) {
  return new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`);
}

function ensureDirectory(directory) {
  try {
    fs.mkdirSync(directory, {recursive: true});
  } catch (error) {
    throw diagnosticError('create diagnostics directory', error);
  }
}

function newSessionId() {
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const millis = String(now % 1000).padStart(3, '0');
  const sequence = uniqueSequence++;
  return `${seconds}-${millis}-${process.pid}-${sequence}`;
}

function validSessionId(sessionId) {
  return typeof sessionId === 'string'
    && sessionId.length > 0
    && sessionId.length <= 80
    && /^[0-9-]+$/.test(sessionId);
}

function reportPath(directory, sessionId, suffix) {
  if (!validSessionId(sessionId)) throw new Error('invalid diagnostic session id');
  return path.join(directory, `long-scroll-${sessionId}.${suffix}`);
}

function temporaryPath(target) {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${uniqueSequence++}.tmp`,
  );
}

function atomicWrite(target, contents, replace) {
  const parent = path.dirname(target);
  ensureDirectory(parent);
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  if (!replace && fs.existsSync(target)) {
    let existing;
    try {
      existing = fs.readFileSync(target);
    } catch (error) {
      throw diagnosticError('read existing diagnostic file', error);
    }
    if (existing.equals(bytes)) return;
    throw new Error('diagnostic file already exists');
  }

  const temporary = temporaryPath(target);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx');
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original persistence error.
      }
    }
    try {
      fs.rmSync(temporary, {force: true});
    } catch {
      // Temporary-file cleanup is best effort.
    }
    throw diagnosticError(replace ? 'publish diagnostic checkpoint' : 'publish diagnostic file', error);
  }
}

const FORBIDDEN_KEYS = new Set([
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
]);

function validatePrivacy(value, key = null) {
  if (key !== null && FORBIDDEN_KEYS.has(String(key).toLowerCase())) {
    throw new Error(`forbidden diagnostic field: ${key}`);
  }
  if (Array.isArray(value)) {
    for (const child of value) validatePrivacy(child);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      validatePrivacy(child, childKey);
    }
    return;
  }
  if (typeof value === 'string') {
    const windowsPath = /^[A-Za-z]:[\\/]/.test(value);
    if (value.startsWith('/') || windowsPath || value.includes('://') || value.startsWith('file:')) {
      throw new Error('diagnostic report contains a path or URL');
    }
  }
}

function parseReport(reportJson, expectedState) {
  if (typeof reportJson !== 'string') throw new Error('diagnostic report must be JSON text');
  const bytes = Buffer.byteLength(reportJson);
  if (bytes === 0 || bytes > MAX_REPORT_BYTES) {
    throw new Error(`diagnostic report size must be between 1 and ${MAX_REPORT_BYTES} bytes`);
  }
  let report;
  try {
    report = JSON.parse(reportJson);
  } catch (error) {
    throw diagnosticError('parse diagnostic JSON', error);
  }
  if (report === null || Array.isArray(report) || typeof report !== 'object') {
    throw new Error('diagnostic report must be a JSON object');
  }
  if (report.schema_version !== 1) throw new Error('unsupported diagnostic schema version');
  for (const required of ['session', 'depth', 'pagination', 'thumbnails', 'intervals']) {
    if (!Object.prototype.hasOwnProperty.call(report, required)) {
      throw new Error(`diagnostic report is missing ${required}`);
    }
  }
  if (report.session?.state !== expectedState) {
    throw new Error(`diagnostic session state must be ${expectedState}`);
  }
  validatePrivacy(report);
  return report;
}

function valueAt(report, pointer) {
  let value = report;
  for (const part of pointer.split('/').slice(1)) {
    if (value === null || typeof value !== 'object') return undefined;
    value = value[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return value;
}

function integerAt(report, pointer) {
  const value = valueAt(report, pointer);
  return Number.isInteger(value) ? value : 0;
}

function metric(report, pointer) {
  const value = valueAt(report, pointer);
  return typeof value === 'number' || typeof value === 'string' ? String(value) : 'NOT MEASURED';
}

function sumObjectNumbers(report, pointer) {
  const value = valueAt(report, pointer);
  if (value === null || Array.isArray(value) || typeof value !== 'object') return 0;
  return Object.values(value).reduce(
    (total, item) => total + (Number.isInteger(item) ? item : 0),
    0,
  );
}

function maximumQueueDepth(report) {
  const depths = Array.isArray(report.intervals)
    ? report.intervals
      .map(interval => interval?.thumb_queue_snapshot?.thumbQueueDepth)
      .filter(Number.isInteger)
    : [];
  const latest = valueAt(report, '/queue_sampling/latest_snapshot/thumbQueueDepth');
  if (depths.length > 0) return Math.max(...depths);
  return Number.isInteger(latest) ? latest : null;
}

function analyzeReport(report) {
  const duration = metric(report, '/session/duration_ms');
  const runtime = typeof report.session?.runtime === 'string' ? report.session.runtime : 'NOT MEASURED';
  const started = typeof report.session?.started_at_utc === 'string'
    ? report.session.started_at_utc
    : 'NOT MEASURED';
  const maximumVisible = integerAt(report, '/depth/maximum_visible_index');
  const visited = maximumVisible >= 0 ? maximumVisible + 1 : 0;
  const pages = sumObjectNumbers(report, '/pagination/requests_by_kind');
  const primary = integerAt(report, '/thumbnails/primary_request_started');
  const fallback = integerAt(report, '/thumbnails/fallback_attempts');
  const firstVisible = integerAt(report, '/thumbnails/first_visible_entries');
  const missingAtVisibility = integerAt(report, '/thumbnails/not_ready_on_first_visibility');
  const missingPercent = firstVisible > 0
    ? `${(100 * missingAtVisibility / firstVisible).toFixed(1)}%`
    : 'NOT MEASURED';
  const fallback202 = integerAt(report, '/thumbnails/fallback_http_202');
  const terminalPlaceholders = integerAt(report, '/thumbnails/terminal_error_placeholders');
  const fallbackDecodeErrors = integerAt(report, '/thumbnails/fallback_image_decode_errors');
  const unmountedPending = integerAt(report, '/thumbnails/unmounted_before_load');
  const queueDepth = maximumQueueDepth(report);
  const queueMax = queueDepth === null ? 'NOT MEASURED' : String(queueDepth);
  const frameAnomalies = integerAt(report, '/frame_intervals/intervals_over_50_ms');
  const markers = Array.isArray(report.manual_slowdown_markers)
    ? report.manual_slowdown_markers.length
    : 0;
  const reasons = valueAt(report, '/thumbnails/terminal_error_reasons');
  const reasonCounts = reasons && typeof reasons === 'object' && !Array.isArray(reasons)
    ? (Object.keys(reasons).length === 0
      ? 'none'
      : Object.entries(reasons).map(([reason, count]) => (
        `${reason}=${Number.isInteger(count) ? count : 0}`
      )).join(', '))
    : 'NOT MEASURED';

  const correlations = [];
  if (markers === 0) {
    correlations.push('- [NOT MEASURED] No manual slowdown marker was recorded.');
  } else {
    correlations.push(`- [CORRELATED] ${markers} manual marker(s) can be aligned with the exported two-second intervals.`);
  }
  if (fallback202 > 0 && (queueDepth || 0) > 0) {
    correlations.push(`- [CORRELATED] Fallback returned 202 ${fallback202} time(s) while sampled thumbnail queue depth reached ${queueMax}.`);
  }
  if (terminalPlaceholders > 0) {
    correlations.push(`- [CONFIRMED] ${terminalPlaceholders} mounted lifecycle(s) reached a terminal thumbnail error placeholder.`);
  }

  let proposedFix = 'No production loader change is justified by this trace alone.';
  if (terminalPlaceholders > 0) {
    proposedFix = 'Reproduce the dominant terminal reason, then apply a targeted retry or stale-job recovery fix; do not change gallery virtualization.';
  } else if (fallback202 > 0 && (queueDepth || 0) > 0) {
    proposedFix = 'Inspect stale/running thumbnail jobs and worker claim progress before changing frontend prefetching.';
  }

  return `# Vilra Autonomous Gallery Diagnostic Analysis

## 1. Session information

- Start: \`${started}\`
- Duration: \`${duration}\` ms
- Schema: \`1\`

## 2. Runtime and version

- Runtime: \`${runtime}\`
- Vilra diagnostic format: \`0.1.1 / schema 1\`

## 3. Images visited

- Maximum visible depth: \`${visited}\` images
- Loaded metadata: \`${metric(report, '/depth/loaded_metadata_count')}\`

## 4. Pages requested

- Total refresh/cursor requests: \`${pages}\`
- End-to-end p95: \`${metric(report, '/pagination/end_to_end/p95_ms_approx')}\` ms
- Backend Server-Timing p95: \`${metric(report, '/pagination/server_timing_api_images/p95_ms_approx')}\` ms

## 5. Thumbnail requests

- Primary requests: \`${primary}\`
- Fallback attempts: \`${fallback}\`

## 6. Missing thumbnail frequency

- Not ready on first visibility: \`${missingAtVisibility}/${firstVisible}\` (\`${missingPercent}\`)
- Unmounted before successful load: \`${unmountedPending}\`

## 7. Fallback 202 frequency

- HTTP 202 attempts: \`${fallback202}\`
- Lifecycles affected: \`${integerAt(report, '/thumbnails/mount_lifecycles_with_202')}\`

## 8. Worker queue behavior

- Maximum sampled thumbnail queue depth: \`${queueMax}\`
- Latest running workers: \`${metric(report, '/queue_sampling/latest_snapshot/thumbRunning')}\`
- Sampling is sparse and cannot prove causality between samples.

## 9. Frontend processing times

- Mapping p95: \`${metric(report, '/pagination/stages/mapped/p95_ms_approx')}\` ms
- Deduplication p95: \`${metric(report, '/pagination/stages/deduped/p95_ms_approx')}\` ms
- Array update/copy p95: \`${metric(report, '/pagination/stages/arrays/p95_ms_approx')}\` ms
- Virtualizer update p95: \`${metric(report, '/rendering/update_virtual_gallery_count/p95_ms_approx')}\` ms

## 10. Frame interval anomalies

- Active-scroll intervals over 50 ms: \`${frameAnomalies}\`
- Frame interval p95: \`${metric(report, '/frame_intervals/distribution/p95_ms_approx')}\` ms

## 11. Slowdown intervals

- Manual markers: \`${markers}\`
- Inspect \`manual_slowdown_markers\` and adjacent \`intervals\` in the JSON for timing correlation.

## 12. Black thumbnail observations

- Terminal error placeholders: \`${terminalPlaceholders}\`
- Fallback image decode errors: \`${fallbackDecodeErrors}\`
- Terminal reasons: \`${reasonCounts}\`

## 13. Relevant correlations

${correlations.join('\n')}

## 14. Confirmed facts

- [CONFIRMED] Metrics are bounded and contain no image IDs, paths, names, tags, URLs, or SQLite rows.
- [CONFIRMED] HTTP completion, image decode/load, and frame interval proxy are reported separately.

## 15. Working hypotheses

- [SUSPECTED] Queue growth plus repeated 202 responses indicates thumbnail generation pressure or stale jobs.
- [SUSPECTED] Increasing array-stage latency with depth would indicate frontend scaling cost.

## 16. Missing evidence

- [NOT MEASURED] CPU ownership, Chromium layout/compositor cost, disk I/O, and complete Resource Timing drop counts.
- [NOT MEASURED] A synthetic trace does not establish the cause of a user-library slowdown.

## 17. Proposed minimal fixes

- ${proposedFix}
`;
}

function createGalleryDiagnostics({diagnosticsDirectory}) {
  if (typeof diagnosticsDirectory !== 'string' || !path.isAbsolute(diagnosticsDirectory)) {
    throw new Error('diagnostics directory must be absolute');
  }

  return Object.freeze({
    begin() {
      ensureDirectory(diagnosticsDirectory);
      const sessionId = newSessionId();
      return {
        session_id: sessionId,
        diagnostics_dir: diagnosticsDirectory,
        checkpoint_path: reportPath(diagnosticsDirectory, sessionId, 'checkpoint.json'),
      };
    },

    checkpoint(sessionId, reportJson) {
      parseReport(reportJson, 'recording');
      const checkpointPath = reportPath(diagnosticsDirectory, sessionId, 'checkpoint.json');
      atomicWrite(checkpointPath, reportJson, true);
      parseReport(fs.readFileSync(checkpointPath, 'utf8'), 'recording');
      return {
        checkpoint_path: checkpointPath,
        bytes: Buffer.byteLength(reportJson),
      };
    },

    finalize(sessionId, reportJson) {
      const report = parseReport(reportJson, 'stopped');
      const jsonPath = reportPath(diagnosticsDirectory, sessionId, 'json');
      atomicWrite(jsonPath, reportJson, false);
      let verified;
      try {
        verified = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      } catch (error) {
        throw diagnosticError('verify saved diagnostic JSON', error);
      }
      if (JSON.stringify(verified) !== JSON.stringify(report)) {
        throw new Error('saved diagnostic JSON does not match the final snapshot');
      }

      const markdownPath = reportPath(diagnosticsDirectory, sessionId, 'md');
      let savedMarkdown = markdownPath;
      let analysisError = null;
      try {
        atomicWrite(markdownPath, analyzeReport(report), false);
      } catch (error) {
        savedMarkdown = null;
        analysisError = error instanceof Error ? error.message : String(error);
      }

      fs.rmSync(reportPath(diagnosticsDirectory, sessionId, 'checkpoint.json'), {force: true});
      return {
        json_path: jsonPath,
        markdown_path: savedMarkdown,
        analysis_error: analysisError,
        bytes: Buffer.byteLength(reportJson),
      };
    },

    status() {
      ensureDirectory(diagnosticsDirectory);
      const entries = fs.readdirSync(diagnosticsDirectory, {withFileTypes: true});
      const jsonReports = [];
      const markdownReports = [];
      let checkpoints = 0;
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (entry.name.endsWith('.checkpoint.json')) {
          checkpoints += 1;
        } else if (entry.name.startsWith('long-scroll-') && entry.name.endsWith('.json')) {
          jsonReports.push(path.join(diagnosticsDirectory, entry.name));
        } else if (entry.name.startsWith('long-scroll-') && entry.name.endsWith('.md')) {
          markdownReports.push(path.join(diagnosticsDirectory, entry.name));
        }
      }
      jsonReports.sort();
      markdownReports.sort();
      const listedJson = jsonReports.slice(-MAX_LISTED_REPORTS);
      const listedMarkdown = markdownReports.slice(-MAX_LISTED_REPORTS);
      return {
        diagnostics_dir: diagnosticsDirectory,
        latest_json: listedJson.at(-1) || null,
        latest_markdown: listedMarkdown.at(-1) || null,
        checkpoints,
      };
    },
  });
}

module.exports = {
  MAX_LISTED_REPORTS,
  MAX_REPORT_BYTES,
  analyzeReport,
  createGalleryDiagnostics,
  parseReport,
  validSessionId,
};
